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
  traces: [/query_tempo_trace$/i, /tempo.*trace/i, /quer.*trace/i, /find_traces/i, /search_traces/i, /get_trace/i],
  labelValues: [/list_loki_label_values$/i, /label_values/i, /list_.*label_values/i],
  labelNames: [/list_loki_label_names$/i, /label_names/i],
};

/** Normalized property-name keys we recognize across server spellings. */
const ARG_KEYS = {
  expr: ['expr', 'expression'],
  query: ['query', 'logql', 'traceql', 'q', 'search'],
  start: ['start', 'starttime', 'startts', 'from', 'timefrom', 'starttimeunix'],
  end: ['end', 'endtime', 'endts', 'to', 'timeto', 'endtimeunix'],
  step: ['step', 'stepseconds', 'stepsize', 'interval', 'resolution', 'stepsize'],
  limit: ['limit', 'maxentries', 'maxlines', 'pagesize', 'count'],
  datasource: ['datasourceuid', 'datasource', 'datasourceid', 'uid'],
  queryType: ['querytype', 'type'],
  label: ['label', 'labelname'],
  service: ['service', 'servicename', 'service_name'],
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

/** Classify the discovered tools into the four roles this page needs. */
export function categorize(tools) {
  const available = Array.isArray(tools) ? tools : [];
  const pick = (patterns) => {
    for (const pattern of patterns) {
      const found = available.find((tool) => pattern.test(tool.name));
      if (found !== undefined) return found;
    }
    return null;
  };
  return {
    metrics: pick(PATTERNS.metrics),
    logs: pick(PATTERNS.logs),
    traces: pick(PATTERNS.traces),
    labelValues: pick(PATTERNS.labelValues),
    labelNames: pick(PATTERNS.labelNames),
  };
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
    const message = String(entry.line ?? entry.message ?? entry.msg ?? entry.text ?? '');
    if (message.trim() === '') return;
    const ts = toMillis(entry.timestamp ?? entry.time ?? entry.ts ?? entry.startTime);
    /* An entry-level field wins; otherwise the line itself is read, and only
       then the stream label, which cannot vary per line in Loki. */
    const declared = String(entry.level ?? entry.severity ?? entry.detected_level ?? '').toLowerCase();
    const level = declared === 'warning' ? 'warn' : declared || levelOfText(message) || String(labels.level ?? '').toLowerCase();
    rows.push({
      ts,
      time: typeof entry.timeString === 'string' ? entry.timeString : '',
      level,
      message,
      labels: Object.fromEntries(Object.entries(labels).slice(0, 12).map(([key, value]) => [key, String(value)])),
    });
  };
  if (entries.length > 0) {
    for (const entry of entries) push(entry);
  } else if (typeof text === 'string' && text.trim() !== '') {
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === '') continue;
      push({ line, labels: {} });
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
  if (payload === null || typeof payload !== 'object') return { traces: [], spans: [] };
  const traces = [];
  let spans = [];
  const source = payload.data !== null && typeof payload.data === 'object' ? payload.data : payload;
  for (const key of ['traces', 'results']) if (Array.isArray(source[key])) traces.push(...source[key]);
  for (const key of ['spans', 'spansList']) if (Array.isArray(source[key])) spans.push(...source[key]);
  if (source.trace !== null && typeof source.trace === 'object') {
    traces.push(source.trace);
    if (Array.isArray(source.trace.spans)) spans = spans.concat(source.trace.spans);
  }
  return { traces, spans };
}

/** Parse a trace search (or one fetched trace) into rows the page can print. */
export function parseTraces(payload, text) {
  const { traces, spans } = tracePayloadOf(payload);
  const byTrace = new Map();

  const ensure = (traceId) => {
    const key = traceId === '' ? 'unknown' : traceId;
    if (!byTrace.has(key)) {
      byTrace.set(key, { traceId: key, root: '', service: '', start: 0, durationMs: 0, spans: [], error: false });
    }
    return byTrace.get(key);
  };

  for (const span of spans) {
    const shaped = spanOf(span);
    const traceId = String(span.traceID ?? span.traceId ?? span.trace_id ?? shaped.id ?? '');
    const trace = ensure(traceId);
    trace.spans.push(shaped);
    if (shaped.start > 0 && (trace.start === 0 || shaped.start < trace.start)) trace.start = shaped.start;
    if (shaped.durationMs > trace.durationMs) trace.durationMs = shaped.durationMs;
    if (shaped.status.includes('error')) trace.error = true;
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
    if (Array.isArray(raw.spans)) {
      for (const span of raw.spans) {
        const shaped = spanOf(span);
        trace.spans.push(shaped);
        if (shaped.start > 0 && (trace.start === 0 || shaped.start < trace.start)) trace.start = shaped.start;
        if (shaped.durationMs > trace.durationMs) trace.durationMs = shaped.durationMs;
        if (shaped.status.includes('error')) trace.error = true;
      }
    }
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
      spanCount: ordered.length,
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

  if (rows.length === 0 && typeof text === 'string' && text.trim() !== '') {
    return { traces: [], note: text.trim().slice(0, 400) };
  }
  return { traces: rows, note: '' };
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

  /** Read one metric panel. */
  async metric(key, service, range) {
    const tool = this.rolesNow().metrics;
    if (tool === null) return { ok: false, reason: 'no-tool', note: 'no Prometheus query tool on this MCP server' };
    const { start, end, span } = windowOf(range);
    const stepSeconds = Math.max(15, Math.round(span / 1000 / 120));
    const expr = expandQuery(this.config.queries[key], service);
    const args = buildArgs(tool, {
      expr,
      query: expr,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      step: stepSeconds,
      queryType: 'range',
      datasource: this.config.datasourceUid,
    });
    const result = await this.session.callTool(tool.name, args);
    if (!result.ok) return { ok: false, reason: 'query-failed', note: result.text.slice(0, 300) };
    const parsed = parseMetrics(result.json);
    const points = aggregate(parsed.series);
    return {
      ok: true,
      key,
      tool: tool.name,
      query: expr,
      series: parsed.series
        .map((entry) => ({ name: entry.name, points: entry.points, ...statsOf(entry.points) }))
        .sort((left, right) => right.current - left.current)
        .slice(0, 6),
      points,
      ...statsOf(points),
    };
  }

  /** Read the two metric cards the monitor tab shows. */
  async metrics(service, range) {
    const [cpu, memory] = await Promise.all([
      this.metric('cpu', service, range),
      this.metric('memory', service, range),
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

  /** Read the log list for one service. */
  async logs(service, range, limit = 60) {
    const tool = this.rolesNow().logs;
    if (tool === null) return { ok: false, reason: 'no-tool', note: 'no log query tool on this MCP server' };
    const { start, end } = windowOf(range);
    const query = expandQuery(this.config.queries.logs, service);
    const args = buildArgs(tool, {
      query,
      expr: query,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      limit,
      datasource: this.config.datasourceUid,
    });
    const result = await this.session.callTool(tool.name, args);
    if (!result.ok) return { ok: false, reason: 'query-failed', note: result.text.slice(0, 300) };
    const parsed = parseLogs(result.json, result.text);
    return { ok: true, tool: tool.name, query, service, range, rows: parsed.rows.slice(0, limit) };
  }

  /** Read the trace list for one service. */
  async traces(service, range, limit = 40) {
    const tool = this.rolesNow().traces;
    if (tool === null) return { ok: false, reason: 'no-tool', note: 'no trace query tool on this MCP server' };
    const { start, end } = windowOf(range);
    const query = expandQuery(this.config.queries.traces, service);
    const args = buildArgs(tool, {
      query,
      expr: query,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      limit,
      datasource: this.config.datasourceUid,
    });
    const result = await this.session.callTool(tool.name, args);
    if (!result.ok) return { ok: false, reason: 'query-failed', note: result.text.slice(0, 300) };
    const parsed = parseTraces(result.json, result.text);
    return { ok: true, tool: tool.name, query, service, range, traces: parsed.traces.slice(0, limit), note: parsed.note };
  }

  /** The service names the filter offers. */
  async services() {
    const roles = this.rolesNow();
    if (roles.labelValues === null) return { ok: false, values: [], note: 'no label-values tool on this MCP server' };
    for (const label of ['service_name', 'service', 'job']) {
      const args = buildArgs(roles.labelValues, { label, datasource: this.config.datasourceUid });
      const result = await this.session.callTool(roles.labelValues.name, args);
      if (!result.ok) continue;
      const values = valuesOf(result.json);
      if (values.length > 0) return { ok: true, values, label, tool: roles.labelValues.name };
    }
    return { ok: true, values: [], label: '' };
  }
}
