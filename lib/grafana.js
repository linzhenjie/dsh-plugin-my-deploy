/**
 * The Grafana-shaped layer over an MCP session.
 *
 * Grafana MCP servers are not one schema: `mcp/grafana` names its tools
 * `query_prometheus`, `query_loki_logs`, `query_tempo_trace`, while other
 * servers publish their own names and argument spellings. So nothing here
 * hard-codes a tool name or an argument list. Instead:
 *
 *   1. the discovered tool directory is classified by name patterns,
 *   2. arguments are synthesized from the tool's own `inputSchema`,
 *   3. results are parsed tolerantly from the JSON a tool returns.
 *
 * When a server has no tool that fits, the caller gets `{ ok: false, reason }`
 * with the reason a user can act on (`no-tool`, `query-failed`, ...).
 */
import { RANGES } from './store.js';

/** Tool-name patterns, most specific first. */
const PATTERNS = {
  metrics: [/query_prometheus$/i, /query_prometheus_/i, /prometheus.*quer/i, /quer.*prometheus/i, /prom.*range/i],
  logs: [/query_loki_logs?$/i, /loki.*log/i, /quer.*loki/i, /query_logs?$/i, /quer.*logs?$/i, /list_loki_logs/i],
  /* A search tool takes a TraceQL query; a `get_*` tool takes one trace id, so
     the pattern order and the `get_` filter below keep them apart. */
  traces: [/search_tempo_traces?$/i, /search_traces?$/i, /find_traces?$/i, /quer.*trace/i, /tempo.*trace/i],
  labelValues: [/list_loki_label_values$/i, /label_values/i, /list_.*label_values/i],
  labelNames: [/list_loki_label_names$/i, /label_names/i],
  datasources: [/^list_datasources$/i, /list_.*datasources?$/i, /find_datasources/i],
  dashboards: [/^search_dashboards?$/i, /^list_dashboards?$/i, /search_.*dashboards?$/i, /find_dashboards?/i],
};

/**
 * A Grafana-side auth failure, reported by the MCP server when its own
 * credential cannot reach Grafana. It is a configuration problem on the server,
 * not a broken query, and the page says so instead of showing a bare 401.
 */
const AUTH_FAILURE = /(\[40[13]\]|invalid api key|unauthori[sz]ed|forbidden|permission denied|access denied)/i;

/** `grafana-auth` when a tool failure is a credential problem, else `query-failed`. */
export function failureReasonOf(text) {
  return AUTH_FAILURE.test(String(text ?? '')) ? 'grafana-auth' : 'query-failed';
}

/** Normalized property-name keys we recognize across server spellings. */
const ARG_KEYS = {
  expr: ['expr', 'expression'],
  query: ['query', 'logql', 'traceql', 'q', 'search'],
  /* mcp-grafana spells the Loki window `startRfc3339` / `endRfc3339`; leaving
     those out silently dropped the page's range and fell back to one hour. */
  start: ['start', 'starttime', 'startts', 'from', 'timefrom', 'starttimeunix', 'startrfc3339'],
  end: ['end', 'endtime', 'endts', 'to', 'timeto', 'endtimeunix', 'endrfc3339'],
  step: ['step', 'stepseconds', 'stepsize', 'interval', 'resolution', 'stepsize'],
  limit: ['limit', 'maxentries', 'maxlines', 'pagesize', 'count'],
  datasource: ['datasourceuid', 'datasource', 'datasourceid', 'uid'],
  queryType: ['querytype', 'type'],
  label: ['label', 'labelname'],
  service: ['service', 'servicename', 'service_name'],
  matcher: ['matcher', 'streamselector', 'selector'],
};

/** Lowercase and drop separators so `startTime` and `start_time` compare equal. */
function normalizeKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** One millisecond-precision window for a range tag. */
export function windowOf(range) {
  const span = RANGES[range] ?? RANGES['1h'];
  const end = Date.now();
  return { start: end - span, end, span };
}

/** A PromQL/Label selector for the chosen service, empty when none is chosen. */
function selectorOf(service) {
  const trimmed = String(service ?? '').trim();
  if (trimmed === '') return '';
  return `service_name="${trimmed.replace(/(["\\])/g, '\\$1')}"`;
}

/**
 * Expand a stored query template.
 *
 * `$SERVICE`     a `service_name="..."` matcher, for use inside a selector
 * `$SERVICE_VALUE` the bare value, for use inside quotes
 *
 * An empty service keeps the query valid: a bare selector stays `{}` and a
 * `service_name="$SERVICE_VALUE"` template widens to a non-empty match.
 */
export function expandQuery(template, service) {
  const value = String(service ?? '').trim();
  const matcher = selectorOf(value);
  let expanded = String(template ?? '');
  if (value === '') {
    expanded = expanded
      .replace(/\{\s*\$SERVICE\s*,\s*/g, '{')
      .replace(/,\s*\$SERVICE\s*\}/g, '}')
      .replace(/\{\s*\$SERVICE\s*\}/g, '{}')
      .replace(/service_name\s*=\s*"\$SERVICE_VALUE"/g, 'service_name=~".+"')
      .replace(/resource\.service\.name\s*=\s*"\$SERVICE_VALUE"/g, 'resource.service.name=~".+"');
  } else {
    expanded = expanded
      .replace(/\$SERVICE_VALUE/g, value.replace(/(["\\])/g, '\\$1'))
      .replace(/\{\s*\$SERVICE\s*,\s*/g, `{${matcher},`)
      .replace(/,\s*\$SERVICE\s*\}/g, `,${matcher}}`)
      .replace(/\{\s*\$SERVICE\s*\}/g, `{${matcher}}`);
  }
  return expanded.replace(/\$SERVICE_VALUE/g, value);
}

/**
 * Append a Loki line filter for one keyword search.
 *
 * A literal `|=` is the cheapest filter Loki has and needs only the two escapes
 * Loki's quoted strings require. A template that is not a plain selector (an
 * aggregation, say) is left alone: appending a line filter to it would be a
 * syntax error.
 * @param query - the expanded LogQL expression.
 * @param keyword - what the user typed; blank means no filter.
 */
export function withKeyword(query, keyword) {
  const value = String(keyword ?? '').trim();
  if (value === '') return query;
  const base = String(query ?? '').trim();
  if (!base.startsWith('{')) return base;
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `${base} |= "${escaped}"`;
}

/** Classify the discovered tools into the roles this page needs. */
export function categorize(tools) {
  const available = Array.isArray(tools) ? tools : [];
  const pick = (patterns, accept = () => true) => {
    for (const pattern of patterns) {
      const found = available.find((tool) => accept(tool) && pattern.test(tool.name));
      if (found !== undefined) return found;
    }
    return null;
  };
  /* A trace *search* tool is preferred; a `get_*_trace` tool only fetches one
     trace by id, so it is a last resort rather than the first match. */
  const searchable = (tool) => !/^get[_-]/i.test(tool.name);
  return {
    metrics: pick(PATTERNS.metrics),
    logs: pick(PATTERNS.logs),
    traces: pick(PATTERNS.traces, searchable) ?? pick(PATTERNS.traces),
    labelValues: pick(PATTERNS.labelValues),
    labelNames: pick(PATTERNS.labelNames),
    datasources: pick(PATTERNS.datasources),
    dashboards: pick(PATTERNS.dashboards),
  };
}

/** Normalize a `search_dashboards` payload into the rows the page renders. */
export function parseDashboards(payload) {
  const list = Array.isArray(payload)
    ? payload
    : payload !== null && typeof payload === 'object'
      ? payload.dashboards ?? payload.data ?? payload.items ?? payload.results ?? []
      : [];
  const rows = [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (entry === null || typeof entry !== 'object') continue;
    const uid = typeof entry.uid === 'string' ? entry.uid : '';
    const title = typeof entry.title === 'string' ? entry.title : '';
    if (uid === '' && title === '') continue;
    rows.push({
      uid,
      title: title === '' ? uid : title,
      url: typeof entry.url === 'string' ? entry.url : '',
      folder: typeof entry.folderTitle === 'string' ? entry.folderTitle : typeof entry.folderPath === 'string' ? entry.folderPath : '',
      tags: Array.isArray(entry.tags) ? entry.tags.filter((tag) => typeof tag === 'string') : [],
    });
  }
  return rows;
}

/**
 * The datasource types each role can query. A Grafana MCP query tool requires a
 * `datasourceUid`, so the page resolves one per role from `list_datasources`
 * instead of asking the user to type it.
 */
const ROLE_TYPES = {
  metrics: ['prometheus', 'mimir', 'cortex'],
  logs: ['loki', 'victorialogs', 'elasticsearch', 'opensearch'],
  traces: ['tempo', 'jaeger', 'zipkin'],
};

/** How long one session's datasource list is trusted. */
const DATASOURCE_TTL_MS = 300000;

/** Per-session datasource discovery, shared by every reader built on it. */
const DATASOURCE_CACHE = new WeakMap();

/** Normalize a `list_datasources` payload into `{ uid, name, type, isDefault }`. */
export function parseDatasources(payload) {
  const list = Array.isArray(payload)
    ? payload
    : payload !== null && typeof payload === 'object'
      ? payload.datasources ?? payload.data ?? payload.result ?? payload.items ?? []
      : [];
  const entries = [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (entry === null || typeof entry !== 'object') continue;
    const uid =
      typeof entry.uid === 'string' ? entry.uid : typeof entry.datasourceUid === 'string' ? entry.datasourceUid : '';
    if (uid === '') continue;
    entries.push({
      uid,
      name: String(entry.name ?? entry.title ?? uid),
      type: String(entry.type ?? entry.typeName ?? entry.pluginType ?? ''),
      isDefault: entry.isDefault === true || entry.default === true,
    });
  }
  return entries;
}

/** The datasource uid one role should query, or '' when nothing matches. */
export function pickDatasource(list, role) {
  const entries = Array.isArray(list) ? list : [];
  if (entries.length === 0) return '';
  const types = ROLE_TYPES[role] ?? [];
  const matched = entries.filter((entry) => types.some((type) => String(entry.type).toLowerCase().includes(type)));
  /* A matching type wins; without one, the datasource Grafana calls default is
     the only defensible guess. */
  const pool = matched.length > 0 ? matched : entries.filter((entry) => entry.isDefault === true);
  const chosen = pool.find((entry) => entry.isDefault === true) ?? pool[0];
  return chosen === undefined ? '' : chosen.uid;
}

/** Find the schema property that plays one role, or null when none does. */
function propertyFor(schema, role) {
  const properties = schema !== null && typeof schema === 'object' && schema.properties !== null && typeof schema.properties === 'object'
    ? schema.properties
    : {};
  const wanted = ARG_KEYS[role] ?? [];
  for (const name of Object.keys(properties)) {
    if (wanted.includes(normalizeKey(name))) return { name, schema: properties[name] };
  }
  return null;
}

/**
 * Put a discovered datasource uid into one tool call, under whatever property the
 * tool declares (`datasourceUid`, `datasource_uid`, `datasource`, …).
 * @param force - overwrite a value the caller supplied; the model cannot know a
 * uid, so model-chosen arguments are forced and page reads are not.
 */
export function withDatasource(tool, args, uid, force = false) {
  if (uid === '' || tool === null || tool === undefined) return args;
  const property = propertyFor(tool.inputSchema ?? {}, 'datasource');
  if (property === null) return args;
  if (!force && args !== null && typeof args === 'object' && args[property.name] !== undefined) return args;
  return { ...args, [property.name]: uid };
}

/** Render one value in the type the schema declares. */
function coerce(property, value) {
  const type = property && typeof property === 'object' ? property.schema?.type : undefined;
  const declared = Array.isArray(type) ? type[0] : type;
  if (declared === 'integer' || declared === 'number') {
    const numeric = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
    return Number.isFinite(numeric) ? numeric : value;
  }
  if (declared === 'boolean') return value === true || value === 'true';
  if (declared === 'array') return Array.isArray(value) ? value : [value];
  return typeof value === 'number' ? String(value) : value;
}

/**
 * Synthesize `tools/call` arguments from the tool's own schema.
 * Only properties the tool declares are sent, so an extra field can never make
 * a strict server reject the call.
 */
export function buildArgs(tool, values) {
  const schema = tool !== null && tool !== undefined && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object' };
  const args = {};
  for (const [role, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') continue;
    const property = propertyFor(schema, role);
    if (property === null) continue;
    args[property.name] = coerce(property, value);
  }
  /* A tool that accepts free-form or conventionally named fields gets the query
     even when its property names are unfamiliar: this is the one field no
     Grafana query tool can do without. */
  if (args[propertyFor(schema, 'expr')?.name] === undefined) {
    const loose = Object.keys(schema.properties ?? {}).find((name) => /^(promql|logql|traceql|query|expr)$/i.test(name));
    if (loose !== undefined && (values.expr ?? values.query) !== undefined) {
      args[loose] = coerce({ schema: schema.properties[loose] }, values.expr ?? values.query);
    }
  }
  return args;
}

/* ---------- result parsing ---------- */

/** A millisecond timestamp from seconds, milliseconds, or nanoseconds. */
export function toMillis(value) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  if (numeric > 1e15) return Math.round(numeric / 1e6);
  if (numeric > 1e12) return Math.round(numeric);
  return Math.round(numeric * 1000);
}

function numberAt(value) {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/** The most telling label of one Prometheus series. */
function seriesNameOf(labels) {
  const source = labels !== null && typeof labels === 'object' ? labels : {};
  for (const key of ['pod', 'instance', 'container', 'service_name', 'service', 'job', 'node']) {
    if (typeof source[key] === 'string' && source[key] !== '') return source[key];
  }
  const keys = Object.keys(source);
  if (keys.length === 0) return 'value';
  return keys.slice(0, 2).map((key) => `${key}=${source[key]}`).join(',');
}

/** Unwrap the common envelopes a metrics tool returns. */
function matrixOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload === null || typeof payload !== 'object') return [];
  for (const key of ['result', 'series', 'metrics']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  if (payload.data !== null && typeof payload.data === 'object' && Array.isArray(payload.data.result)) return payload.data.result;
  return [];
}

/**
 * Parse a Prometheus query result into named series.
 * @returns {{ series: { name: string, points: number[][] }[] }}
 */
export function parseMetrics(payload) {
  const series = [];
  for (const entry of matrixOf(payload)) {
    if (entry === null || typeof entry !== 'object') continue;
    const labels = entry.metric ?? entry.labels ?? entry.stream ?? null;
    const raw = Array.isArray(entry.values)
      ? entry.values
      : Array.isArray(entry.points)
        ? entry.points
        : Array.isArray(entry.samples)
          ? entry.samples
          : Array.isArray(entry.value)
            ? [entry.value]
            : [];
    const points = [];
    for (const sample of raw) {
      if (Array.isArray(sample)) {
        const ts = toMillis(sample[0]);
        const value = numberAt(sample[1]);
        if (ts > 0 && value !== null) points.push([ts, value]);
        continue;
      }
      if (sample !== null && typeof sample === 'object') {
        const ts = toMillis(sample.timestamp ?? sample.time ?? sample.ts);
        const value = numberAt(sample.value);
        if (ts > 0 && value !== null) points.push([ts, value]);
      }
    }
    if (points.length === 0) continue;
    points.sort((left, right) => left[0] - right[0]);
    series.push({ name: seriesNameOf(labels), points });
  }
  return { series };
}

/** Sum every series per timestamp; the chart shows the whole service. */
export function aggregate(series) {
  const buckets = new Map();
  for (const entry of series) {
    for (const [ts, value] of entry.points) {
      buckets.set(ts, (buckets.get(ts) ?? 0) + value);
    }
  }
  return [...buckets.entries()].sort((left, right) => left[0] - right[0]);
}

/** Current / average / peak for one point list. */
export function statsOf(points) {
  if (points.length === 0) return { current: 0, avg: 0, max: 0 };
  let sum = 0;
  let max = 0;
  for (const [, value] of points) {
    sum += value;
    if (value > max) max = value;
  }
  return { current: points[points.length - 1][1], avg: sum / points.length, max };
}

/** Unwrap the common log envelopes. */
function logEntriesOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload === null || typeof payload !== 'object') return [];
  for (const key of ['entries', 'logs', 'lines', 'rows', 'results']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  /* mcp-grafana's own shape: `data` is already a flat entry array. */
  if (Array.isArray(payload.data)) return payload.data;
  if (payload.data !== null && typeof payload.data === 'object') {
    const data = payload.data;
    if (Array.isArray(data.result)) {
      const entries = [];
      for (const stream of data.result) {
        if (stream === null || typeof stream !== 'object') continue;
        const labels = stream.stream ?? stream.labels ?? {};
        const values = Array.isArray(stream.values) ? stream.values : [];
        for (const value of values) {
          if (Array.isArray(value)) entries.push({ timestamp: value[0], line: value[1], labels });
          else entries.push({ ...value, labels });
        }
      }
      return entries;
    }
    for (const key of ['entries', 'logs', 'lines']) if (Array.isArray(data[key])) return data[key];
  }
  if (Array.isArray(payload.result)) return payload.result;
  return [];
}

/** Whether a message looks like a level token, and which one. */
function levelOfText(text) {
  const match = /\b(fatal|panic|error|err|warn|warning|info|debug|trace)\b/i.exec(String(text ?? ''));
  if (match === null) return '';
  const token = match[1].toLowerCase();
  if (token === 'warning') return 'warn';
  if (token === 'err') return 'error';
  return token;
}

/** Parse a log query result into rows the page can print. */
export function parseLogs(payload, text) {
  const rows = [];
  const entries = logEntriesOf(payload);
  const push = (entry) => {
    if (entry === null || typeof entry !== 'object') return;
    const labels = entry.labels !== null && typeof entry.labels === 'object' ? entry.labels : entry.stream ?? {};
    /* Loki's structured metadata carries the level and the k8s coordinates a
       reader needs, so it joins the labels instead of being dropped. */
    const metadata = entry.structuredMetadata !== null && typeof entry.structuredMetadata === 'object' ? entry.structuredMetadata : {};
    const allLabels = { ...metadata, ...labels };
    const message = String(entry.line ?? entry.message ?? entry.msg ?? entry.text ?? '');
    if (message.trim() === '') return;
    const ts = toMillis(entry.timestamp ?? entry.time ?? entry.ts ?? entry.startTime);
    /* An entry-level field wins; otherwise the line itself is read, and only
       then the stream label, which cannot vary per line in Loki. */
    const declared = String(
      entry.level ?? entry.severity ?? entry.detected_level ?? metadata.detected_level ?? '',
    ).toLowerCase();
    const level = declared === 'warning' ? 'warn' : declared || levelOfText(message) || String(labels.level ?? '').toLowerCase();
    rows.push({
      ts,
      time: typeof entry.timeString === 'string' ? entry.timeString : '',
      level,
      message,
      labels: Object.fromEntries(Object.entries(allLabels).slice(0, 14).map(([key, value]) => [key, String(value)])),
    });
  };
  if (entries.length > 0) {
    for (const entry of entries) push(entry);
  } else if (payload === null || payload === undefined) {
    /* Not JSON at all: some servers answer with plain lines. A payload that did
       parse but carried no entries is a real empty result, not one JSON blob. */
    if (typeof text === 'string' && text.trim() !== '') {
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() === '') continue;
        push({ line, labels: {} });
      }
    }
  }
  rows.sort((left, right) => right.ts - left.ts);
  return { rows };
}

/** One span, filled from whatever names the server used. */
function spanOf(raw) {
  const attributes = raw.attributes !== null && typeof raw.attributes === 'object' ? raw.attributes : {};
  const durationNanos = numberAt(raw.durationNanos ?? attributes.durationNanos);
  const durationMs =
    numberAt(raw.durationMs) ??
    (durationNanos !== null ? durationNanos / 1e6 : null) ??
    (numberAt(raw.duration) !== null ? numberAt(raw.duration) / 1e6 : null);
  const status = raw.statusCode ?? raw.status ?? (raw.error === true ? 'error' : '');
  return {
    id: String(raw.spanID ?? raw.spanId ?? raw.id ?? ''),
    parentId: String(raw.parentSpanID ?? raw.parentSpanId ?? raw.parentId ?? ''),
    name: String(raw.name ?? raw.operationName ?? raw.operation ?? raw.spanName ?? ''),
    service: String(
      raw.serviceName ?? raw.service ?? attributes['service.name'] ?? (raw.resource && raw.resource['service.name']) ?? '',
    ),
    start: toMillis(raw.startTimeUnixNano ?? raw.startTimeUnixNanos ?? raw.startTime ?? raw.start ?? 0),
    durationMs: durationMs === null ? 0 : durationMs,
    /* OpenTelemetry encodes span status as 2 for ERROR and 1 for OK. */
    status: status === 2 ? 'error' : status === 1 ? 'ok' : String(status ?? '').toLowerCase(),
  };
}

/** Order spans into a parent-first tree and stamp each one's depth. */
function treeOf(spans) {
  const byId = new Map(spans.map((span) => [span.id, span]));
  const depthOf = (span, guard) => {
    if (guard > 16 || span.parentId === '' || !byId.has(span.parentId)) return 0;
    return depthOf(byId.get(span.parentId), guard + 1) + 1;
  };
  return spans
    .map((span) => ({ ...span, depth: depthOf(span, 0) }))
    .sort((left, right) => left.start - right.start || left.depth - right.depth);
}

/** Unwrap the common trace envelopes into a flat span list plus trace rows. */
function tracePayloadOf(payload) {
  if (payload === null || typeof payload !== 'object') return { traces: [], spans: [], note: '' };
  const traces = [];
  let spans = [];
  const source = payload.data !== null && typeof payload.data === 'object' ? payload.data : payload;
  for (const key of ['traces', 'results']) if (Array.isArray(source[key])) traces.push(...source[key]);
  for (const key of ['spans', 'spansList']) if (Array.isArray(source[key])) spans.push(...source[key]);
  if (source.trace !== null && typeof source.trace === 'object') {
    traces.push(source.trace);
    if (Array.isArray(source.trace.spans)) spans = spans.concat(source.trace.spans);
  }
  const note = typeof source.note === 'string' ? source.note : '';
  return { traces, spans, note };
}

/**
 * The spans of one trace. Tempo's search response puts them in `spanSets`, each
 * set carrying a `matched` count and the spans themselves; a fetched single trace
 * uses a flat `spans` array. A search span often has no name, so the id stands in.
 */
function spansOfTrace(raw) {
  const sets = Array.isArray(raw.spanSets) ? raw.spanSets : [];
  const spans = [];
  let matched = 0;
  for (const set of sets) {
    if (set === null || typeof set !== 'object') continue;
    const batch = Array.isArray(set.spans) ? set.spans : [];
    const declared = numberAt(set.matched);
    matched += declared === null || declared < batch.length ? batch.length : declared;
    for (const span of batch) spans.push(span);
  }
  for (const span of Array.isArray(raw.spans) ? raw.spans : []) spans.push(span);
  if (spans.length > matched) matched = spans.length;
  return { spans, matched };
}

/** Parse a trace search (or one fetched trace) into rows the page can print. */
export function parseTraces(payload, text) {
  const { traces, spans, note } = tracePayloadOf(payload);
  const byTrace = new Map();

  const ensure = (traceId) => {
    const key = traceId === '' ? 'unknown' : traceId;
    if (!byTrace.has(key)) {
      byTrace.set(key, { traceId: key, root: '', service: '', start: 0, durationMs: 0, spans: [], matched: 0, error: false });
    }
    return byTrace.get(key);
  };

  const absorb = (trace, rawSpans) => {
    for (const span of rawSpans) {
      const shaped = spanOf(span);
      trace.spans.push(shaped);
      if (shaped.start > 0 && (trace.start === 0 || shaped.start < trace.start)) trace.start = shaped.start;
      if (shaped.durationMs > trace.durationMs) trace.durationMs = shaped.durationMs;
      if (shaped.status.includes('error')) trace.error = true;
    }
  };

  for (const span of spans) {
    const shaped = spanOf(span);
    const traceId = String(span.traceID ?? span.traceId ?? span.trace_id ?? shaped.id ?? '');
    absorb(ensure(traceId), [span]);
  }

  for (const raw of traces) {
    if (raw === null || typeof raw !== 'object') continue;
    const traceId = String(raw.traceID ?? raw.traceId ?? raw.trace_id ?? raw.id ?? '');
    const trace = ensure(traceId);
    trace.root = String(raw.rootTraceName ?? raw.rootName ?? raw.name ?? trace.root ?? '');
    trace.service = String(raw.rootServiceName ?? raw.serviceName ?? raw.service ?? trace.service ?? '');
    trace.start = trace.start === 0 ? toMillis(raw.startTimeUnixNano ?? raw.startTime ?? raw.start ?? 0) : trace.start;
    const duration = numberAt(raw.durationMs) ?? (numberAt(raw.durationNanos) !== null ? numberAt(raw.durationNanos) / 1e6 : null);
    if (duration !== null && duration > trace.durationMs) trace.durationMs = duration;
    const found = spansOfTrace(raw);
    absorb(trace, found.spans);
    if (found.matched > trace.matched) trace.matched = found.matched;
  }

  const rows = [...byTrace.values()].map((trace) => {
    const ordered = treeOf(trace.spans);
    const rootSpan = ordered.length > 0 ? ordered[0] : undefined;
    return {
      traceId: trace.traceId,
      root: trace.root === '' ? (rootSpan === undefined ? 'trace' : rootSpan.name) : trace.root,
      service: trace.service === '' ? (rootSpan === undefined ? '' : rootSpan.service) : trace.service,
      start: trace.start,
      durationMs: Math.round(trace.durationMs * 10) / 10,
      spanCount: Math.max(trace.matched, ordered.length),
      error: trace.error,
      spans: ordered.map((span) => ({
        id: span.id,
        name: span.name,
        service: span.service,
        start: span.start,
        durationMs: Math.round(span.durationMs * 10) / 10,
        depth: span.depth,
        error: span.status.includes('error'),
      })),
    };
  });
  rows.sort((left, right) => right.start - left.start);

  if (rows.length === 0) {
    /* The server's own explanation ("partial results", "no traces") is worth
       showing; a raw JSON dump is not. Text is only used when the payload was
       not JSON at all. */
    const fallback = payload === null || payload === undefined ? (typeof text === 'string' ? text.trim() : '') : '';
    return { traces: [], note: (note !== '' ? note : fallback).slice(0, 400) };
  }
  return { traces: rows, note: note.slice(0, 400) };
}

/** The strings a label-values tool returned, whatever envelope it used. */
export function valuesOf(payload) {
  const list = Array.isArray(payload)
    ? payload
    : payload !== null && typeof payload === 'object'
      ? payload.values ?? payload.data ?? payload.result ?? []
      : [];
  const values = [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (typeof entry === 'string' && entry !== '') values.push(entry);
    else if (entry !== null && typeof entry === 'object' && typeof entry.value === 'string') values.push(entry.value);
  }
  return [...new Set(values)].slice(0, 500);
}

/**
 * One MCP session plus the query templates: every read the page makes.
 */
export class GrafanaReader {
  constructor(session, config, logger) {
    this.session = session;
    this.config = config;
    this.logger = logger;
    this.roles = categorize(session.tools());
  }

  /** The tool directory, classified; re-read after a reconnect. */
  rolesNow() {
    this.roles = categorize(this.session.tools());
    return this.roles;
  }

  /**
   * The datasource list, discovered once per session through `list_datasources`.
   * A Grafana MCP query tool requires a `datasourceUid`, so the uid always comes
   * from here — never from user configuration.
   */
  async datasources() {
    const cached = DATASOURCE_CACHE.get(this.session);
    if (cached !== undefined) {
      if (cached.pending !== null) return cached.pending;
      if (Date.now() - cached.at < DATASOURCE_TTL_MS) return cached.list;
    }
    const pending = (async () => {
      const tool = this.rolesNow().datasources;
      if (tool === null) return [];
      const result = await this.session.callTool(tool.name, {});
      if (!result.ok) {
        this.logger?.warn?.(`my-deploy: list_datasources failed: ${result.text.slice(0, 200)}`);
        return [];
      }
      const list = parseDatasources(result.json);
      this.logger?.info?.(
        `my-deploy: datasources ${list.map((entry) => `${entry.type}:${entry.uid}`).join(', ') || '(none)'}`,
      );
      return list;
    })();
    DATASOURCE_CACHE.set(this.session, { at: Date.now(), list: cached?.list ?? [], pending });
    const list = await pending.catch(() => []);
    DATASOURCE_CACHE.set(this.session, { at: Date.now(), list, pending: null });
    return list;
  }

  /** The datasource uid one role queries; '' when the server offers none. */
  async uidFor(role) {
    return pickDatasource(await this.datasources(), role);
  }

  /** The auto-picked uid per view, so the page can seed its filter menu. */
  async datasourceDefaults() {
    const list = await this.datasources();
    return {
      monitor: pickDatasource(list, 'metrics'),
      logs: pickDatasource(list, 'logs'),
      traces: pickDatasource(list, 'traces'),
    };
  }

  /** The uid to query with: the page's choice wins, discovery is the fallback. */
  async uidOr(role, chosen) {
    const value = typeof chosen === 'string' ? chosen.trim() : '';
    return value !== '' ? value : this.uidFor(role);
  }

  /** Read one metric panel. */
  async metric(key, service, range, datasource) {
    const tool = this.rolesNow().metrics;
    if (tool === null) return { ok: false, reason: 'no-tool', note: 'no Prometheus query tool on this MCP server' };
    const { start, end, span } = windowOf(range);
    const stepSeconds = Math.max(15, Math.round(span / 1000 / 120));
    const expr = expandQuery(this.config.queries[key], service);
    const uid = await this.uidOr('metrics', datasource);
    const args = withDatasource(
      tool,
      buildArgs(tool, {
        expr,
        query: expr,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        step: stepSeconds,
        queryType: 'range',
      }),
      uid,
      true,
    );
    const result = await this.session.callTool(tool.name, args);
    if (!result.ok) return { ok: false, reason: failureReasonOf(result.text), note: result.text.slice(0, 300) };
    const parsed = parseMetrics(result.json);
    const points = aggregate(parsed.series);
    return {
      ok: true,
      key,
      tool: tool.name,
      datasource: uid,
      query: expr,
      series: parsed.series
        .map((entry) => ({ name: entry.name, points: entry.points, ...statsOf(entry.points) }))
        .sort((left, right) => right.current - left.current)
        .slice(0, 6),
      points,
      empty: points.length === 0,
      ...statsOf(points),
    };
  }

  /** Read the two metric cards the monitor tab shows. */
  async metrics(service, range, datasource) {
    const [cpu, memory] = await Promise.all([
      this.metric('cpu', service, range, datasource),
      this.metric('memory', service, range, datasource),
    ]);
    const failures = [cpu, memory].filter((entry) => !entry.ok);
    return {
      ok: failures.length === 0,
      service,
      range,
      cpu,
      memory,
      reason: failures.length === 0 ? '' : failures[0].reason,
      note: failures.length === 0 ? '' : failures[0].note,
    };
  }

  /**
   * Read the log list for one service.
   * @param keyword - an optional line filter the user typed in the log search box.
   */
  async logs(service, range, limit = 60, datasource, keyword = '') {
    const tool = this.rolesNow().logs;
    if (tool === null) return { ok: false, reason: 'no-tool', note: 'no log query tool on this MCP server' };
    const { start, end } = windowOf(range);
    const query = withKeyword(expandQuery(this.config.queries.logs, service), keyword);
    const uid = await this.uidOr('logs', datasource);
    const args = withDatasource(
      tool,
      buildArgs(tool, {
        query,
        expr: query,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        limit,
      }),
      uid,
      true,
    );
    const result = await this.session.callTool(tool.name, args);
    if (!result.ok) return { ok: false, reason: failureReasonOf(result.text), note: result.text.slice(0, 300) };
    const parsed = parseLogs(result.json, result.text);
    return {
      ok: true,
      tool: tool.name,
      datasource: uid,
      query,
      keyword: String(keyword ?? '').trim(),
      service,
      range,
      rows: parsed.rows.slice(0, limit),
    };
  }

  /** Read the trace list for one service. */
  async traces(service, range, limit = 40, datasource) {
    const tool = this.rolesNow().traces;
    if (tool === null) return { ok: false, reason: 'no-tool', note: 'no trace query tool on this MCP server' };
    const { start, end } = windowOf(range);
    const query = expandQuery(this.config.queries.traces, service);
    const uid = await this.uidOr('traces', datasource);
    const args = withDatasource(
      tool,
      buildArgs(tool, {
        query,
        expr: query,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        limit,
      }),
      uid,
      true,
    );
    const result = await this.session.callTool(tool.name, args);
    if (!result.ok) return { ok: false, reason: failureReasonOf(result.text), note: result.text.slice(0, 300) };
    const parsed = parseTraces(result.json, result.text);
    return {
      ok: true,
      tool: tool.name,
      datasource: uid,
      query,
      service,
      range,
      traces: parsed.traces.slice(0, limit),
      note: parsed.note,
    };
  }

  /**
   * The dashboards the list view shows, through the server's dashboard search
   * tool. `query` is optional; an empty query lists everything the caller may
   * see, up to the tool's page size.
   */
  async dashboards(query = '', limit = 100) {
    const tool = this.rolesNow().dashboards;
    if (tool === null) {
      return { ok: false, reason: 'no-tool', note: 'no dashboard search tool on this MCP server', rows: [] };
    }
    const args = buildArgs(tool, { query, limit });
    const result = await this.session.callTool(tool.name, args);
    if (!result.ok) {
      return { ok: false, reason: failureReasonOf(result.text), note: result.text.slice(0, 300), rows: [] };
    }
    const rows = parseDashboards(result.json);
    const total =
      result.json !== null && typeof result.json === 'object' && typeof result.json.total === 'number'
        ? result.json.total
        : rows.length;
    return { ok: true, tool: tool.name, query, rows, total, note: '' };
  }

  /**
   * The service names the filter offers, read from the datasource's own label
   * values (`service_name` first, then the spellings other stacks use).
   *
   * The window is the one the page is showing, so a service that was active in
   * the selected range is listed even when it has been quiet for the last hour.
   * @param datasource - the Loki uid the filter is scoped to, if any.
   * @param range - the page's range tag; the label query uses the same window.
   */
  async services(datasource, range) {
    const roles = this.rolesNow();
    if (roles.labelValues === null) {
      return { ok: false, values: [], label: '', note: 'no label-values tool on this MCP server' };
    }
    const uid = await this.uidOr('logs', datasource);
    const { start, end } = windowOf(range);
    const window = { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
    let note = '';
    for (const label of ['service_name', 'service', 'job']) {
      const args = withDatasource(
        roles.labelValues,
        buildArgs(roles.labelValues, { label, start: window.start, end: window.end }),
        uid,
        true,
      );
      const result = await this.session.callTool(roles.labelValues.name, args);
      if (!result.ok) {
        note = result.text.slice(0, 300);
        continue;
      }
      const values = valuesOf(result.json);
      if (values.length > 0) {
        return { ok: true, values, label, datasource: uid, tool: roles.labelValues.name, note: '' };
      }
    }
    /* Nothing listed: keep the reason, so an empty menu can explain itself. */
    return { ok: true, values: [], label: '', datasource: uid, note };
  }
}
