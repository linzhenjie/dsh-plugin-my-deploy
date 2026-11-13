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
import { parseLogs, parseTraces } from './grafana.js';

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
function systemPrompt({ tab, service, range, start, end }) {
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
 * @param options - question, tab, service, range, history, session, reader, logger.
 * @returns `{ answer, calls, logs, traces, model, degraded, error }`
 */
export async function ask(ctx, options) {
  const { question, tab, service, range, history, session, reader, start, end } = options;
  const trimmed = String(question ?? '').trim();
  if (trimmed === '') return { answer: '', calls: [], model: '', degraded: false, error: '' };

  const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined;
  const defaults = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined;
  const selection = defaults !== undefined && typeof defaults.currentSelection === 'function' ? defaults.currentSelection() : undefined;
  if (llm === undefined || typeof llm.stream !== 'function' || selection === undefined) {
    return degrade(reader, { question: trimmed, tab, service, range, reason: 'no-model' });
  }

  const { schemas, names } = toolSchemas(session.tools());
  if (schemas.length === 0) {
    return degrade(reader, { question: trimmed, tab, service, range, reason: 'no-tool' });
  }

  const system = systemPrompt({ tab, service, range, start, end });
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
          return degrade(reader, { question: trimmed, tab, service, range, reason: 'empty-answer' });
        }
        return {
          answer,
          calls,
          logs: observed.logs,
          traces: observed.traces,
          model: `${selection.provider}/${selection.model}`,
          degraded: false,
          error: '',
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
        const args = argumentsOf(block);
        const result = await session.callTool(raw, args);
        calls.push({
          name: raw,
          ok: result.ok,
          args: JSON.stringify(args).slice(0, 400),
          preview: result.text.slice(0, 400),
        });
        if (result.ok) observed = observe(reader, observed, raw, result);
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
    return degrade(reader, { question: trimmed, tab, service, range, reason: 'rounds', calls });
  } catch (error) {
    options.logger?.warn?.(`my-deploy: chat failed: ${error instanceof Error ? error.message : String(error)}`);
    return degrade(reader, {
      question: trimmed,
      tab,
      service,
      range,
      reason: 'model-failed',
      detail: error instanceof Error ? error.message : String(error),
      calls,
    });
  }
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
async function degrade(reader, { question, tab, service, range, reason, detail = '', calls = [] }) {
  const chinese = isChinese(question);
  const wanted = tab === 'traces' ? 'traces' : tab === 'monitor' ? 'metrics' : 'logs';
  let logs = null;
  let traces = null;
  let metrics = null;
  try {
    if (wanted === 'traces') traces = await reader.traces(service, range);
    else if (wanted === 'metrics') metrics = await reader.metrics(service, range);
    else logs = await reader.logs(service, range);
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
  const note =
    reason === 'no-model'
      ? chinese
        ? '没有可用的默认模型，已直接调用 MCP 工具查询。'
        : 'No default model is available, so the MCP tools were called directly.'
      : chinese
        ? `模型调用未成功（${detail || reason}），已回退到直接查询 MCP 工具。`
        : `The model call did not succeed (${detail || reason}); the MCP tools were called directly instead.`;
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
  };
}
