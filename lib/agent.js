/**
 * The chat behind the logs and traces tabs.
 *
 * A question is answered by the Harness default model with the discovered MCP
 * tools attached: the model decides which tool to call, this module executes it
 * against the live session, and the loop repeats until the model answers. The
 * tool results are also parsed into the same shapes the panel renders, so an
 * answer and the list above it never disagree.
 *
 * When no model is configured (or the model call fails), the question is routed
 * to the tool the tab implies and answered from the raw result instead of an
 * error, with `degraded: true` telling the page why.
 */
import { parseLogs, parseTraces, withDatasource } from './grafana.js';

/** Rounds of tool calls one question may provoke. */
const MAX_ROUNDS = 4;
/** Tools sent to the model: observability ones only, so the request stays small. */
const TOOL_PATTERN = /prometheus|loki|tempo|trace|log|datasource|dashboard|alert|metric/i;
const MAX_TOOLS = 24;
/** Previous turns replayed to the model. */
const MAX_HISTORY = 6;

/** Whether a question is written in Chinese, so the fallback can match it. */
function isChinese(text) {
  return /[\u4e00-\u9fff]/.test(String(text ?? ''));
}

/** The model-facing tool list, with names this deployment's tool contract accepts. */
function toolSchemas(tools) {
  const chosen = tools.filter((tool) => TOOL_PATTERN.test(tool.name)).slice(0, MAX_TOOLS);
  const names = new Map();
  const used = new Set();
  const schemas = [];
  for (const tool of chosen) {
    let name = tool.name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 56);
    let suffix = 2;
    while (used.has(name)) name = `${name.slice(0, 54)}_${suffix++}`;
    used.add(name);
    names.set(name, tool.name);
    const schema = tool.inputSchema !== null && typeof tool.inputSchema === 'object' ? tool.inputSchema : {};
    const parameters =
      schema.type === 'object' && schema.properties !== null && typeof schema.properties === 'object'
        ? schema
        : { type: 'object', properties: {}, additionalProperties: true };
    schemas.push({
      name,
      description: `${tool.description}`.slice(0, 700) || `MCP tool ${tool.name}`,
      parameters,
    });
  }
  return { schemas, names };
}

/** One text block, in the shape a request message carries. */
function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }] };
}

/** A stable-enough message id; the provider treats it as history identity. */
function messageId() {
  return `md${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** The system prompt: evidence only, tool first, answer in the question's language. */
function systemPrompt({ tab, service, range, start, end, datasources = [], chosen = '' }) {
  if (tab === 'dashboards') {
    const list = datasources.map((entry) => `${entry.uid} (${entry.type || 'unknown'}) "${entry.name}"`).join(', ');
    return [
      'You are the Grafana assistant of a local harness page, on its Dashboards view.',
      'Two jobs: list the dashboards that exist, and CREATE a dashboard from the conversation.',
      '',
      'Listing:',
      '1. Call search_dashboards (optionally with a query) and summarise title, folder and uid.',
      '',
      'Creating:',
      '1. Call update_dashboard with a COMPLETE dashboard JSON and overwrite: false.',
      '2. Use the classic v1 shape: {"title": "...", "panels": [...], "schemaVersion": 39,',
      '   "time": {"from": "now-6h", "to": "now"}, "refresh": "30s"}.',
      '3. Every panel needs: "type" ("timeseries", "stat", "table", "logs", "gauge"), "title",',
      '   "gridPos": {"x": 0, "y": 0, "w": 12, "h": 8}, "datasource": {"type": "<type>", "uid": "<uid>"},',
      '   and "targets": [{"refId": "A", "expr": "<PromQL or LogQL>"}].',
      '4. Use ONLY the datasource uid/type pairs listed below. Never invent a uid.',
      `   Available datasources: ${list === '' ? '(none reported)' : list}.`,
      chosen === '' ? '   No datasource is selected on the page.' : `   The page has "${chosen}" selected.`,
      '5. Prefer the user\'s own words for the title. Do not fabricate metric data: a new panel with an',
      '   empty result is acceptable, a fabricated value is not.',
      '6. After the write succeeds, report the title and the uid/url the tool returned; if it failed,',
      '   report the server\'s error verbatim and nothing else.',
      '',
      'Answer in the language of the user question, briefly, without pasting the dashboard JSON back.',
    ].join('\n');
  }
  return [
    'You are the Grafana observability assistant of a local harness page.',
    'Answer strictly from MCP tool results. Never invent log lines, traces, spans, metric values, or ids.',
    '',
    'Working rules:',
    '1. Call a tool before answering: log tools for logs, trace/tempo tools for traces, Prometheus tools for metrics.',
    '2. Scope every query to the selected service and the given window. LogQL: {service_name="<service>"}. ',
    '   TraceQL: { resource.service.name = "<service>" }. PromQL: a service_name="<service>" label matcher.',
    '3. Prefer one or two focused queries. Narrow with level/status filters when the question asks for errors.',
    '4. Answer in the language of the user question. Lead with the conclusion, then at most six pieces of',
    '   concrete evidence (time, level, trace id, duration). Do not paste raw JSON.',
    '5. If a tool returns nothing or fails, say so plainly and suggest what to change (service, range, labels, tool).',
    '',
    `Context: view=${tab}; service=${service === '' ? '(all services)' : service}; range=${range};`,
    `window starts ${new Date(start).toISOString()} and ends ${new Date(end).toISOString()}.`,
  ].join('\n');
}

/** Collect one streamed model step into its completed blocks plus its finish reason. */
async function step(stream) {
  const blocks = new Map();
  let finish = { kind: 'stop' };
  for await (const chunk of stream) {
    if (chunk === null || typeof chunk !== 'object') continue;
    if (chunk.type === 'block-end') blocks.set(chunk.index, chunk.block);
    else if (chunk.type === 'finish') finish = chunk.reason ?? { kind: 'stop' };
  }
  const ordered = [...blocks.entries()].sort((left, right) => left[0] - right[0]).map(([, block]) => block);
  return { blocks: ordered.filter((block) => block !== null), finish };
}

/** The plain text of one assistant step. */
function textOf(blocks) {
  return blocks
    .filter((block) => block !== null && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/** The tool calls one assistant step asked for. */
function callsOf(blocks) {
  return blocks.filter((block) => block !== null && block.type === 'tool-call' && typeof block.name === 'string');
}

/** Parse JSON arguments without letting a malformed call abort the loop. */
function argumentsOf(block) {
  if (typeof block.arguments !== 'string' || block.arguments.trim() === '') return {};
  try {
    const parsed = JSON.parse(block.arguments);
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** The failure text of a finish reason, when it has one. */
function failureOf(finish) {
  const failure = finish && finish.failure;
  if (failure === null || failure === undefined) return 'the model call failed';
  const code = typeof failure.code === 'string' ? failure.code : '';
  const message = typeof failure.message === 'string' ? failure.message : '';
  return [code, message].filter((part) => part !== '').join(': ') || 'the model call failed';
}

/**
 * Ask the default model with the MCP tools attached.
 * @param ctx - host context; `llm` and `agentDefaultModel` are read lazily.
 * @param options - question, tab, service, range, datasource, history, session, reader, logger.
 * @returns `{ answer, calls, logs, traces, model, degraded, error }`
 */
export async function ask(ctx, options) {
  const { question, tab, service, range, datasource, history, session, reader, start, end } = options;
  const trimmed = String(question ?? '').trim();
  if (trimmed === '') return { answer: '', calls: [], model: '', degraded: false, error: '' };
  const preferred = { role: tab === 'traces' ? 'traces' : tab === 'monitor' ? 'metrics' : 'logs', uid: datasource };

  const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined;
  const defaults = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined;
  const selection = defaults !== undefined && typeof defaults.currentSelection === 'function' ? defaults.currentSelection() : undefined;
  if (llm === undefined || typeof llm.stream !== 'function' || selection === undefined) {
    return degrade(reader, { question: trimmed, tab, service, range, datasource, reason: 'no-model' });
  }

  const { schemas, names } = toolSchemas(session.tools());
  if (schemas.length === 0) {
    return degrade(reader, { question: trimmed, tab, service, range, datasource, reason: 'no-tool' });
  }

  /* The dashboards view needs to know the real datasources so a created panel
     can point at one; the other views do not ask. */
  const datasources = tab === 'dashboards' ? await reader.datasources().catch(() => []) : [];
  const system = systemPrompt({ tab, service, range, start, end, datasources, chosen: datasource });
  const messages = [];
  for (const turn of Array.isArray(history) ? history.slice(-MAX_HISTORY) : []) {
    if (turn === null || typeof turn !== 'object') continue;
    const text = typeof turn.text === 'string' ? turn.text.trim() : '';
    if (text === '') continue;
    if (turn.role === 'assistant') {
      messages.push({
        role: 'assistant',
        id: messageId(),
        source: { kind: 'model', provider: selection.provider, model: selection.model },
        content: [{ type: 'text', text }],
      });
    } else {
      messages.push(userMessage(text));
    }
  }
  messages.push(
    userMessage(
      service === ''
        ? trimmed
        : `${trimmed}\n\n(Selected service: ${service}. Use it as the query scope.)`,
    ),
  );

  const calls = [];
  const created = [];
  let mutated = false;
  let observed = { logs: null, traces: null };

  try {
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const request = {
        provider: selection.provider,
        model: selection.model,
        messages: [...messages],
        system,
        tools: schemas,
      };
      if (selection.reasoningEffort !== undefined) request.reasoningEffort = selection.reasoningEffort;

      const { blocks, finish } = await step(llm.stream(request));
      if (finish.kind === 'error' || finish.kind === 'aborted') {
        return degrade(reader, {
          question: trimmed,
          tab,
          service,
          range,
          reason: 'model-failed',
          detail: failureOf(finish),
        });
      }

      const requested = callsOf(blocks);
      if (finish.kind !== 'tool-calls' || requested.length === 0) {
        const answer = textOf(blocks);
        if (answer === '') {
          return degrade(reader, { question: trimmed, tab, service, range, datasource, reason: 'empty-answer' });
        }
        return {
          answer,
          calls,
          logs: observed.logs,
          traces: observed.traces,
          model: `${selection.provider}/${selection.model}`,
          degraded: false,
          error: '',
          mutated,
          created,
        };
      }

      messages.push({
        role: 'assistant',
        id: messageId(),
        source: { kind: 'model', provider: selection.provider, model: selection.model },
        content: blocks,
      });

      for (const block of requested) {
        const raw = names.get(block.name) ?? block.name;
        const args = await argumentsWithDatasource(reader, raw, argumentsOf(block), preferred);
        const result = await session.callTool(raw, args);
        calls.push({
          name: raw,
          ok: result.ok,
          args: JSON.stringify(args).slice(0, 400),
          preview: result.text.slice(0, 400),
        });
        if (result.ok) observed = observe(reader, observed, raw, result);
        if (result.ok && writesDashboard(raw, args)) {
          mutated = true;
          const touched = createdOf(result.json);
          if (touched !== null && created.length < 5) created.push(touched);
        }
        messages.push({
          role: 'tool',
          id: messageId(),
          toolCallId: block.id,
          source: { kind: 'tool', callId: block.id },
          isError: result.ok ? undefined : true,
          content: [
            {
              type: 'text',
              text: result.ok ? result.text.slice(0, 12000) : `tool call failed: ${result.text.slice(0, 1000)}`,
            },
          ],
        });
      }
    }
    return {
      ...degrade(reader, { question: trimmed, tab, service, range, datasource, reason: 'rounds', calls }),
      mutated,
      created,
    };
  } catch (error) {
    options.logger?.warn?.(`my-deploy: chat failed: ${error instanceof Error ? error.message : String(error)}`);
    return {
      ...degrade(reader, {
        question: trimmed,
        tab,
        service,
        range,
        datasource,
        reason: 'model-failed',
        detail: error instanceof Error ? error.message : String(error),
        calls,
      }),
      mutated,
      created,
    };
  }
}

/** The dashboard a write tool reported creating or updating, if it said so. */
export function createdOf(payload) {
  if (payload === null || typeof payload !== 'object') return null;
  const dashboard = payload.dashboard !== null && typeof payload.dashboard === 'object' ? payload.dashboard : {};
  const meta = payload.meta !== null && typeof payload.meta === 'object' ? payload.meta : {};
  const pick = (...values) => values.find((value) => typeof value === 'string' && value !== '');
  const uid = pick(payload.uid, dashboard.uid, meta.uid);
  const url = pick(payload.url, meta.url, dashboard.url);
  const title = pick(dashboard.title, payload.title, meta.slug);
  if (uid === undefined && url === undefined && title === undefined) return null;
  return { uid: uid ?? '', url: url ?? '', title: title ?? '' };
}

/** Whether one tool call writes a dashboard. */
function writesDashboard(name, args) {
  if (/^(update|create|save)_dashboard$/i.test(name)) return true;
  if (/^grafana_api_request$/i.test(name)) {
    const method = String(args?.method ?? '').toUpperCase();
    const path = String(args?.path ?? args?.url ?? '');
    return (method === 'POST' || method === 'PUT') && /dashboards/i.test(path);
  }
  return false;
}

/**
 * Put a datasource uid into a model-chosen query call. A Grafana MCP query tool
 * requires a `datasourceUid` and the model cannot know one, so the page's own
 * choice wins over whatever the model guessed.
 * @param preferred - `{ role, uid }` of the view the question came from.
 */
async function argumentsWithDatasource(reader, rawName, args, preferred = {}) {
  const roles = reader.rolesNow();
  for (const role of ['metrics', 'logs', 'traces']) {
    const tool = roles[role];
    if (tool === null || tool === undefined || tool.name !== rawName) continue;
    /* The page's choice applies to the view the question came from; any other
       role falls back to that role's own discovered datasource. */
    const chosen = preferred.role === role && typeof preferred.uid === 'string' && preferred.uid !== '' ? preferred.uid : '';
    const uid = await reader.uidOr(role, chosen).catch(() => '');
    return withDatasource(tool, args, uid, true);
  }
  return args;
}

/** Parse a tool result into the panel shapes when the tool plays that role. */
function observe(reader, observed, rawName, result) {
  const roles = reader.rolesNow();
  const next = { ...observed };
  if (roles.logs !== null && roles.logs.name === rawName) {
    const parsed = parseLogs(result.json, result.text);
    next.logs = { rows: parsed.rows.slice(0, 200), tool: rawName, service: '', range: '' };
  }
  if (roles.traces !== null && roles.traces.name === rawName) {
    const parsed = parseTraces(result.json, result.text);
    next.traces = { traces: parsed.traces.slice(0, 60), tool: rawName, service: '', range: '' };
  }
  return next;
}

/** Answer without a model: query the tool the tab implies, then summarize. */
async function degrade(reader, { question, tab, service, range, datasource, reason, detail = '', calls = [] }) {
  const chinese = isChinese(question);
  const note =
    reason === 'no-model'
      ? chinese
        ? '没有可用的默认模型，已直接调用 MCP 工具查询。'
        : 'No default model is available, so the MCP tools were called directly.'
      : chinese
        ? `模型调用未成功（${detail || reason}），已回退到直接查询 MCP 工具。`
        : `The model call did not succeed (${detail || reason}); the MCP tools were called directly instead.`;

  /* The dashboards view has no query to fall back on: it lists, and it says that
     creating one needs a model. */
  if (tab === 'dashboards') {
    const lines = [note, ''];
    let listed = null;
    try {
      listed = await reader.dashboards('', 100);
    } catch (error) {
      listed = null;
    }
    if (listed === null || listed.ok === false) {
      lines.push(
        chinese
          ? `列仪表盘失败：${listed !== null && listed.reason === 'no-tool' ? '服务端没有 search_dashboards 工具' : (listed?.note ?? '未知错误')}`
          : `Listing dashboards failed: ${listed !== null && listed.reason === 'no-tool' ? 'the server has no dashboard search tool' : (listed?.note ?? 'unknown error')}`,
      );
    } else {
      lines.push(chinese ? `当前共 ${listed.rows.length} 个仪表盘。` : `${listed.rows.length} dashboards found.`);
      for (const row of listed.rows.slice(0, 12)) {
        lines.push(`- ${row.title}${row.folder === '' ? '' : ` · ${row.folder}`}${row.uid === '' ? '' : ` · ${row.uid}`}`);
      }
      lines.push(
        chinese
          ? '创建仪表盘需要可用的默认模型；当前只能列出。'
          : 'Creating a dashboard needs a default model; this fallback can only list.',
      );
    }
    return {
      answer: lines.join('\n').trim(),
      calls,
      logs: null,
      traces: null,
      model: '',
      degraded: true,
      error: reason,
      mutated: false,
      created: [],
    };
  }

  const wanted = tab === 'traces' ? 'traces' : tab === 'monitor' ? 'metrics' : 'logs';
  let logs = null;
  let traces = null;
  let metrics = null;
  try {
    if (wanted === 'traces') traces = await reader.traces(service, range, 40, datasource);
    else if (wanted === 'metrics') metrics = await reader.metrics(service, range, datasource);
    else logs = await reader.logs(service, range, 60, datasource);
  } catch (error) {
    return {
      answer: chinese ? `查询失败：${error instanceof Error ? error.message : String(error)}` : `Query failed: ${error instanceof Error ? error.message : String(error)}`,
      calls,
      logs: null,
      traces: null,
      model: '',
      degraded: true,
      error: reason,
    };
  }

  const lines = [];
  lines.push(note);
  lines.push('');

  const scope = `${service === '' ? (chinese ? '全部服务' : 'all services') : service} · ${range}`;
  if (logs !== null) {
    if (logs.ok === false) {
      lines.push(
        chinese
          ? `${scope} 的日志查询失败：${logs.reason === 'no-tool' ? 'MCP 服务端没有日志查询工具' : logs.note || logs.reason}`
          : `Log query for ${scope} failed: ${logs.reason === 'no-tool' ? 'the MCP server has no log tool' : logs.note || logs.reason}`,
      );
    } else {
      const errors = logs.rows.filter((row) => row.level === 'error' || row.level === 'fatal').length;
      lines.push(
        chinese
          ? `${scope} 共 ${logs.rows.length} 条日志，其中 error 级别 ${errors} 条。`
          : `${logs.rows.length} log lines for ${scope}, ${errors} of them error level.`,
      );
      for (const row of logs.rows.slice(0, 6)) {
        lines.push(`- ${row.time || new Date(row.ts).toISOString()} [${row.level || 'info'}] ${row.message.slice(0, 180)}`);
      }
      if (logs.rows.length === 0) lines.push(chinese ? '没有匹配的日志。' : 'No matching log lines.');
    }
  }
  if (traces !== null) {
    if (traces.ok === false) {
      lines.push(
        chinese
          ? `${scope} 的链路查询失败：${traces.reason === 'no-tool' ? 'MCP 服务端没有链路查询工具' : traces.note || traces.reason}`
          : `Trace query for ${scope} failed: ${traces.reason === 'no-tool' ? 'the MCP server has no trace tool' : traces.note || traces.reason}`,
      );
    } else {
      const failed = traces.traces.filter((trace) => trace.error).length;
      lines.push(
        chinese
          ? `${scope} 共 ${traces.traces.length} 条链路，其中 ${failed} 条含错误标记。`
          : `${traces.traces.length} traces for ${scope}, ${failed} carrying an error status.`,
      );
      for (const trace of traces.traces.slice(0, 6)) {
        lines.push(
          `- ${trace.root} · ${trace.traceId.slice(0, 16)} · ${trace.durationMs}ms · ${trace.spanCount} spans${trace.error ? ' · error' : ''}`,
        );
      }
      if (traces.traces.length === 0) lines.push(chinese ? '没有匹配的链路。' : 'No matching traces.');
    }
  }
  if (metrics !== null) {
    const cpu = metrics.cpu !== undefined && metrics.cpu.ok === true ? metrics.cpu : null;
    const memory = metrics.memory !== undefined && metrics.memory.ok === true ? metrics.memory : null;
    if (cpu === null && memory === null) {
      lines.push(chinese ? '指标查询没有返回数据。' : 'The metric queries returned nothing.');
    } else {
      if (cpu !== null) lines.push(`${chinese ? 'CPU 均值' : 'CPU avg'}: ${cpu.avg.toFixed(3)} ${chinese ? '核' : 'cores'}`);
      if (memory !== null) lines.push(`${chinese ? '内存均值' : 'Memory avg'}: ${Math.round(memory.avg / (1024 * 1024))} MiB`);
    }
  }
  return {
    answer: lines.join('\n').trim(),
    calls,
    logs,
    traces,
    model: '',
    degraded: true,
    error: reason,
    mutated: false,
    created: [],
  };
}
