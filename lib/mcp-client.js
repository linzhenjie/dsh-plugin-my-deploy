/**
 * A minimal Model Context Protocol client for the two transports Grafana MCP
 * servers actually use:
 *
 *   streamable-http  one endpoint URL, JSON-RPC over POST, JSON or SSE replies,
 *                    an `Mcp-Session-Id` header once the server issues one.
 *   stdio            a child process, newline-delimited JSON-RPC on its pipes.
 *
 * Only the four methods this page needs are implemented: `initialize`,
 * `notifications/initialized`, `tools/list`, and `tools/call`. Everything else
 * stays on the server side, so a protocol revision this client does not know
 * cannot break the connection.
 *
 *   const session = await openSession(config, { logger });
 *   session.state  -> { status, serverInfo, protocolVersion, instructions, tools }
 *   await session.callTool('query_loki_logs', { ... });   // { ok, text, json }
 *   await session.close();
 */
import { spawn } from 'node:child_process';
import { parseHeaders } from './store.js';

/** The revision this client announces; a server may negotiate a different one. */
const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'my-deploy', version: '0.1.0' };

/** Connect plus `initialize` must settle inside this window. */
const CONNECT_TIMEOUT_MS = 20000;
/** One `tools/call` (or `tools/list` page) budget. */
const CALL_TIMEOUT_MS = 60000;

/** A transport or protocol failure with a message worth showing the user. */
export class McpError extends Error {
  constructor(message, code = 'MCP_ERROR') {
    super(message);
    this.name = 'McpError';
    this.code = code;
  }
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new McpError(`${label} timed out after ${Math.round(ms / 1000)}s`, 'TIMEOUT')), ms);
  });
  return Promise.race([promise, guard]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

function rpcErrorOf(frame) {
  const error = frame && typeof frame === 'object' ? frame.error : null;
  const message = error && typeof error.message === 'string' ? error.message : 'unknown JSON-RPC error';
  return new McpError(message, error && typeof error.code === 'number' ? `RPC_${error.code}` : 'RPC_ERROR');
}

/** Parse one SSE body into the JSON-RPC frames it carried. */
function framesOfEventStream(source) {
  const frames = [];
  const events = source.split(/\r?\n\r?\n/);
  for (const event of events) {
    const data = [];
    for (const line of event.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length === 0) continue;
    const payload = data.join('\n').trim();
    if (payload === '' || payload === '[DONE]') continue;
    try {
      frames.push(JSON.parse(payload));
    } catch {
      /* a keep-alive or a frame this client does not understand */
    }
  }
  return frames;
}

/** One Streamable HTTP session: POST requests, JSON or SSE answers. */
class HttpTransport {
  constructor(url, headers) {
    this.url = url;
    this.headers = headers;
    this.sessionId = '';
    this.protocolVersion = '';
    this.closed = false;
  }

  /** Every request carries the configured headers, the session, and the revision. */
  headersOf(extra) {
    const headers = new Headers(this.headers);
    headers.set('content-type', 'application/json');
    headers.set('accept', 'application/json, text/event-stream');
    if (this.sessionId !== '') headers.set('mcp-session-id', this.sessionId);
    if (this.protocolVersion !== '') headers.set('mcp-protocol-version', this.protocolVersion);
    for (const [name, value] of Object.entries(extra ?? {})) headers.set(name, value);
    return headers;
  }

  async send(frame, timeoutMs) {
    if (this.closed) throw new McpError('the MCP connection is closed', 'CLOSED');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: this.headersOf(),
        body: JSON.stringify(frame),
        signal: controller.signal,
        redirect: 'follow',
      });
    } catch (error) {
      throw new McpError(
        error instanceof Error && error.name === 'AbortError'
          ? `the MCP endpoint did not answer within ${Math.round(timeoutMs / 1000)}s`
          : `cannot reach the MCP endpoint: ${error instanceof Error ? error.message : String(error)}`,
        'TRANSPORT',
      );
    } finally {
      clearTimeout(timer);
    }

    const issued = response.headers.get('mcp-session-id');
    if (typeof issued === 'string' && issued !== '') this.sessionId = issued;
    if (response.status === 202 || response.status === 204) return null;
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const detail = body.trim() === '' ? '' : `: ${body.trim().slice(0, 300)}`;
      throw new McpError(`the MCP endpoint answered HTTP ${response.status}${detail}`, 'HTTP_STATUS');
    }

    const type = (response.headers.get('content-type') ?? '').toLowerCase();
    const raw = await response.text();
    if (raw.trim() === '') return null;
    if (type.includes('text/event-stream')) {
      for (const frame of framesOfEventStream(raw)) {
        if (frame !== null && typeof frame === 'object' && ('result' in frame || 'error' in frame)) return frame;
      }
      return null;
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw new McpError(`the MCP endpoint answered with a body this client cannot read: ${raw.slice(0, 200)}`, 'BAD_BODY');
    }
  }

  /** Issue one JSON-RPC request and return its `result`. */
  async request(method, params, timeoutMs) {
    const frame = await this.send({ jsonrpc: '2.0', id: this.nextId++, method, params }, timeoutMs);
    if (frame === null) throw new McpError(`${method} returned no response`, 'EMPTY');
    if ('error' in frame) throw rpcErrorOf(frame);
    return 'result' in frame ? frame.result : null;
  }

  /** Issue one JSON-RPC notification (no id, no reply expected). */
  async notify(method, params) {
    await this.send({ jsonrpc: '2.0', method, params }, CONNECT_TIMEOUT_MS);
  }

  async close() {
    this.closed = true;
    if (this.sessionId === '') return;
    try {
      await fetch(this.url, { method: 'DELETE', headers: this.headersOf(), signal: AbortSignal.timeout(2000) });
    } catch {
      /* a server that keeps the session open is not an error here */
    }
  }

  nextId = 1;
}

/** One stdio session: a child process speaking newline-delimited JSON-RPC. */
class StdioTransport {
  constructor(command, args, cwd) {
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.stderr = '';
    this.proc = spawn(command, args, {
      cwd: cwd === '' ? undefined : cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc.on('error', (error) => this.fail(new McpError(`cannot start "${command}": ${error.message}`, 'SPAWN')));
    this.proc.on('exit', (code, signal) => {
      const detail = this.stderr.trim().split(/\r?\n/).slice(-3).join(' | ');
      this.fail(
        new McpError(`the MCP process exited (${signal ?? `code ${code}`})${detail === '' ? '' : `: ${detail}`}`, 'EXITED'),
      );
    });
    this.proc.stderr?.on('data', (chunk) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-4000);
    });
    let buffer = '';
    this.proc.stdout?.on('data', (chunk) => {
      buffer += String(chunk);
      let at = buffer.indexOf('\n');
      while (at !== -1) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (line !== '') this.accept(line);
        at = buffer.indexOf('\n');
      }
    });
  }

  accept(line) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return; /* a log line on stdout, not protocol traffic */
    }
    if (frame === null || typeof frame !== 'object') return;
    const waiter = typeof frame.id === 'number' ? this.pending.get(frame.id) : undefined;
    if (waiter === undefined) return;
    this.pending.delete(frame.id);
    waiter(frame);
  }

  /** Reject everything outstanding; the process is gone or unusable. */
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const [, reject] of this.pending.values()) reject(error);
    this.pending.clear();
  }

  write(frame) {
    if (this.closed) throw new McpError('the MCP process is not running', 'CLOSED');
    this.proc.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  async request(method, params, timeoutMs) {
    const id = this.nextId++;
    const frame = await withTimeout(
      new Promise((resolve, reject) => {
        this.pending.set(id, (answer) => ('error' in answer ? reject(rpcErrorOf(answer)) : resolve(answer.result ?? null)));
        try {
          this.write({ jsonrpc: '2.0', id, method, params });
        } catch (error) {
          this.pending.delete(id);
          reject(error);
        }
      }),
      timeoutMs,
      method,
    );
    return frame;
  }

  async notify(method, params) {
    this.write({ jsonrpc: '2.0', method, params });
  }

  async close() {
    this.closed = true;
    for (const [, reject] of this.pending.values()) reject(new McpError('the MCP connection is closed', 'CLOSED'));
    this.pending.clear();
    try {
      this.proc.stdin.end();
    } catch {
      /* already gone */
    }
    try {
      this.proc.kill();
    } catch {
      /* already gone */
    }
  }

  stderrTail() {
    return this.stderr;
  }
}

/** Collect the text a `tools/call` result carries, in block order. */
function resultText(result) {
  if (result === null || result === undefined) return '';
  const blocks = Array.isArray(result.content) ? result.content : [];
  const parts = [];
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'resource' && block.resource && typeof block.resource.uri === 'string') {
      parts.push(`${block.resource.name ?? block.resource.uri}: ${block.resource.uri}`);
    } else if (block.type === 'resource_link' && typeof block.uri === 'string') {
      parts.push(`${block.name ?? block.uri}: ${block.uri}`);
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  return parts.join('\n');
}

/** The first JSON value inside a text block, or null when there is none. */
export function jsonOf(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return null;
  const attempts = [trimmed];
  const objectAt = trimmed.indexOf('{');
  const arrayAt = trimmed.indexOf('[');
  const starts = [objectAt, arrayAt].filter((at) => at >= 0);
  if (starts.length > 0) attempts.push(trimmed.slice(Math.min(...starts)));
  for (const attempt of attempts) {
    try {
      const value = JSON.parse(attempt);
      if (value !== null && typeof value === 'object') return value;
    } catch {
      /* try the next shape */
    }
  }
  return null;
}

/** The stable shape the rest of the plugin reads from one live session. */
export class McpSession {
  constructor(transport, config) {
    this.transport = transport;
    this.config = config;
    this.state = {
      status: 'connected',
      serverName: config.serverName,
      serverInfo: { name: '', version: '' },
      protocolVersion: '',
      instructions: '',
      tools: [],
      connectedAt: Date.now(),
      error: '',
    };
  }

  /** Read the tool directory discovered at connect time. */
  tools() {
    return this.state.tools;
  }

  /** Refresh `tools/list`, following the server's pagination cursor. */
  async listTools() {
    const tools = [];
    let cursor;
    for (let page = 0; page < 20; page += 1) {
      const result = await this.transport.request('tools/list', cursor === undefined ? {} : { cursor }, CALL_TIMEOUT_MS);
      const batch = result !== null && Array.isArray(result.tools) ? result.tools : [];
      for (const tool of batch) {
        if (tool === null || typeof tool !== 'object' || typeof tool.name !== 'string' || tool.name === '') continue;
        tools.push({
          name: tool.name,
          description: typeof tool.description === 'string' ? tool.description : '',
          inputSchema: tool.inputSchema !== null && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object' },
        });
      }
      cursor = result !== null && typeof result.nextCursor === 'string' && result.nextCursor !== '' ? result.nextCursor : undefined;
      if (cursor === undefined) break;
    }
    this.state.tools = tools;
    return tools;
  }

  /**
   * Call one tool. Never throws for a tool-level failure: the caller decides
   * whether a failed call is an answer or an error.
   * @param name - the raw tool name the server advertised.
   * @param args - JSON arguments.
   */
  async callTool(name, args = {}) {
    try {
      const result = await this.transport.request('tools/call', { name, arguments: args }, CALL_TIMEOUT_MS);
      const text = resultText(result);
      const isError = result !== null && typeof result === 'object' && result.isError === true;
      return { ok: !isError, isError, text, json: jsonOf(text), raw: result };
    } catch (error) {
      return {
        ok: false,
        isError: true,
        text: error instanceof Error ? error.message : String(error),
        json: null,
        raw: null,
      };
    }
  }

  async close() {
    this.state.status = 'disconnected';
    await this.transport.close();
  }
}

/**
 * Open one session: build the transport, negotiate, then discover tools.
 * @param config - sanitized plugin config.
 * @param options.logger - host logger for diagnostics.
 */
export async function openSession(config, options = {}) {
  const headers = Object.fromEntries(parseHeaders(config.headersText));
  if (config.transport === 'stdio') {
    if (config.command === '') throw new McpError('no command is configured for the stdio transport', 'CONFIG');
    const transport = new StdioTransport(config.command, config.args, '');
    try {
      const session = await handshake(transport, config);
      options.logger?.info?.(`my-deploy: connected to MCP server "${config.serverName}" over stdio`);
      return session;
    } catch (error) {
      await transport.close();
      const tail = transport.stderrTail().trim();
      const suffix = tail === '' ? '' : ` (stderr: ${tail.split(/\r?\n/).slice(-2).join(' | ')})`;
      throw new McpError(`${error instanceof Error ? error.message : String(error)}${suffix}`, 'CONNECT');
    }
  }

  if (config.url === '') throw new McpError('no endpoint URL is configured', 'CONFIG');
  const transport = new HttpTransport(config.url, headers);
  try {
    const session = await handshake(transport, config);
    options.logger?.info?.(`my-deploy: connected to MCP server "${config.serverName}" at ${config.url}`);
    return session;
  } catch (error) {
    await transport.close();
    throw error instanceof McpError ? error : new McpError(String(error), 'CONNECT');
  }
}

/** `initialize` then `notifications/initialized` then `tools/list`. */
async function handshake(transport, config) {
  const result = await withTimeout(
    transport.request(
      'initialize',
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
      CONNECT_TIMEOUT_MS,
    ),
    CONNECT_TIMEOUT_MS,
    'initialize',
  );
  const negotiated = result !== null && typeof result.protocolVersion === 'string' ? result.protocolVersion : '';
  transport.protocolVersion = negotiated;
  await transport.notify('notifications/initialized', {});
  const session = new McpSession(transport, config);
  session.state.protocolVersion = negotiated;
  if (result !== null && typeof result.serverInfo === 'object' && result.serverInfo !== null) {
    session.state.serverInfo = {
      name: typeof result.serverInfo.name === 'string' ? result.serverInfo.name : '',
      version: typeof result.serverInfo.version === 'string' ? result.serverInfo.version : '',
    };
  }
  session.state.instructions = typeof result?.instructions === 'string' ? result.instructions : '';
  await session.listTools();
  return session;
}
