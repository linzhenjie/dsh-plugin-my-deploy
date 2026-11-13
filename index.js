/**
 * Host half of the `my-deploy` bundle: the Grafana observability page.
 *
 * It owns four things and nothing else:
 *
 *   1. the MCP connection (one live session, dialed on demand, closable),
 *   2. the durable settings in %DSH_HOME%\storages\my-deploy.json,
 *   3. the metric / log / trace reads the page renders,
 *   4. the chat exchange that answers a question through MCP tools.
 *
 * Routes, all under /api/my-deploy and all behind the Web composition's own
 * request gate (the `connection` service) with a same-origin rule for writes:
 *
 *   GET  /api/my-deploy/state          settings, connection, service list
 *   PUT  /api/my-deploy/config         save settings; optionally connect
 *   POST /api/my-deploy/connect        dial the endpoint
 *   POST /api/my-deploy/disconnect     close the session
 *   GET  /api/my-deploy/services       service_name values for the filter
 *   GET  /api/my-deploy/metrics        CPU and memory series
 *   GET  /api/my-deploy/logs           log rows
 *   GET  /api/my-deploy/traces         trace rows
 *   POST /api/my-deploy/chat           one question, answered through MCP tools
 *   POST /api/my-deploy/diagnostic     one page-side failure or mount report
 *
 * A domain failure (no endpoint, no matching tool, a failed query) answers 200
 * with `ok: false` and a `reason`, because the page renders those as empty
 * states rather than as errors. Only a transport failure of the route itself
 * answers a non-2xx status.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ask } from './lib/agent.js';
import { GrafanaReader, windowOf } from './lib/grafana.js';
import { openSession } from './lib/mcp-client.js';
import { createStore, dataFile, isConfigured, maskHeadersText, sanitizeConfig } from './lib/store.js';

/** Services required before this plugin may activate. */
export const inject = ['webServer'];

/** Route prefix owned by this plugin. */
const BASE = '/api/my-deploy';
/** Largest accepted request body; a chat question plus history fits easily. */
const MAX_BODY_BYTES = 128 * 1024;
/**
 * Feature tags this Host build implements. The Client compares them against its
 * own expectations, so a stale Host module surfaces as a message instead of a
 * page that silently does nothing.
 */
const CAPABILITIES = ['mcp', 'metrics', 'logs', 'traces', 'chat', 'services'];
/** Do not redial a failing endpoint on every poll. */
const RETRY_COOLDOWN_MS = 10000;
/** Service-name cache window. */
const SERVICES_TTL_MS = 120000;
/** Page-side reports kept on disk: a bounded trail, never a log file that grows. */
const DIAGNOSTIC_LIMIT = 40;

/** A request failure carrying the status the caller should answer with. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** A domain failure the page renders as an empty state. */
class DomainError extends Error {
  constructor(reason, note = '') {
    super(note === '' ? reason : note);
    this.reason = reason;
    this.note = note;
  }
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-length', String(Buffer.byteLength(payload)));
  res.end(payload);
}

/** A write must come from the page: a browser sends Origin for every unsafe method. */
function writeAllowed(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof origin !== 'string' || typeof host !== 'string') return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host;
  } catch {
    return false;
  }
}

/**
 * Decide whether this request may reach the routes.
 * Delegates to the Web composition's own trust policy when the `connection`
 * service is mounted, so the routes inherit the deployment's trusted
 * authorities and the browser session; without it, writes fall back to a
 * same-origin rule.
 */
function requestRejection(ctx, req) {
  const connection = ctx.get('connection');
  if (connection === undefined || typeof connection.requestRejection !== 'function') return undefined;
  try {
    const status = connection.requestRejection(req);
    return status === 401 || status === 403 ? status : undefined;
  } catch {
    return 403;
  }
}

function hasRequestGate(ctx) {
  const connection = ctx.get('connection');
  return connection !== undefined && typeof connection.requestRejection === 'function';
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        fail(new HttpError(413, 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => fail(error instanceof Error ? error : new Error(String(error))));
  });
}

/** Parse a JSON body, or reject with the status the page should see. */
async function readJson(req) {
  const raw = await readBody(req, MAX_BODY_BYTES);
  if (raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
}

/** The range tag a query asked for, or the stored default. */
function rangeOf(params, config) {
  const asked = params.get('range');
  return asked !== null && asked !== '' ? asked : config.range;
}

/** A bounded integer query parameter. */
function limitOf(params, fallback, max) {
  const raw = Number.parseInt(params.get('limit') ?? '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(raw, max);
}

/**
 * @param ctx - host context; `webServer` supplies the route table.
 */
export function apply(ctx) {
  const file = dataFile();
  const store = createStore(file, ctx.logger);
  /**
   * Where the page's own reports land. A page that cannot reach this route (or
   * cannot render at all) is invisible from the Host, so the page posts a mount
   * heartbeat and every uncaught failure here, and the trail is one small file
   * that can be read without a browser console.
   */
  const diagnosticsFile = join(dirname(file), 'my-deploy-diagnostics.json');
  const reports = [];

  /** Keep one bounded trail of page-side reports. */
  async function recordDiagnostic(entry) {
    reports.push(entry);
    if (reports.length > DIAGNOSTIC_LIMIT) reports.splice(0, reports.length - DIAGNOSTIC_LIMIT);
    const body = `${JSON.stringify({ updatedAt: Date.now(), entries: reports }, null, 2)}\n`;
    try {
      await mkdir(dirname(diagnosticsFile), { recursive: true, mode: 0o700 });
      await writeFile(diagnosticsFile, body, 'utf8');
    } catch (error) {
      ctx.logger?.warn?.(`my-deploy: could not write the diagnostics file: ${String(error)}`);
    }
  }

  /** The one live MCP session and its observable state. */
  const link = {
    session: null,
    phase: 'idle',
    error: '',
    failedAt: 0,
    pending: null,
    /** Set by an explicit disconnect: then nothing dials the endpoint again. */
    manual: false,
    services: [],
    servicesAt: 0,
    servicesLabel: '',
  };

  /** The connection view the page renders. */
  function connectionView() {
    const session = link.session;
    const state = session === null ? null : session.state;
    return {
      status: link.phase,
      serverName: state === null ? '' : state.serverName,
      serverInfo: state === null ? { name: '', version: '' } : state.serverInfo,
      protocolVersion: state === null ? '' : state.protocolVersion,
      instructions: state === null ? '' : state.instructions,
      tools: state === null ? [] : state.tools.map((tool) => ({ name: tool.name, description: tool.description })),
      connectedAt: state === null ? 0 : state.connectedAt,
      error: link.error,
    };
  }

  /** The persisted settings with every secret-bearing value masked. */
  function publicConfig(config) {
    return {
      transport: config.transport,
      url: config.url,
      command: config.command,
      args: config.args,
      headersText: maskHeadersText(config.headersText),
      serverName: config.serverName,
      autoConnect: config.autoConnect,
      service: config.service,
      range: config.range,
      datasourceUid: config.datasourceUid,
      queries: config.queries,
    };
  }

  async function snapshot() {
    const config = await store.load();
    return {
      ok: true,
      capabilities: CAPABILITIES,
      file,
      config: publicConfig(config),
      connection: connectionView(),
      services: link.services,
      servicesLabel: link.servicesLabel,
    };
  }

  /** Dial the configured endpoint; concurrent callers share one attempt. */
  async function connect() {
    if (link.pending !== null) return link.pending;
    const config = await store.load();
    if (!isConfigured(config)) {
      link.phase = 'idle';
      link.error = '';
      return;
    }
    link.manual = false;
    link.phase = 'connecting';
    link.error = '';
    link.pending = (async () => {
      try {
        const session = await openSession(config, { logger: ctx.logger });
        if (link.session !== null) await link.session.close().catch(() => {});
        link.session = session;
        link.phase = 'connected';
        link.servicesAt = 0;
        /* Warm the filter in the background: a page load never waits on it. */
        void refreshServices(false).catch(() => {});
      } catch (error) {
        link.session = null;
        link.phase = 'error';
        link.error = error instanceof Error ? error.message : String(error);
        ctx.logger?.warn?.(`my-deploy: MCP connection failed: ${link.error}`);
      } finally {
        link.pending = null;
        link.failedAt = Date.now();
      }
    })();
    return link.pending;
  }

  /** The live session, dialing or explaining why there is none. */
  async function ensure() {
    const config = await store.load();
    if (link.session !== null && link.phase === 'connected') return { session: link.session, config };
    if (link.manual) throw new DomainError('not-connected', 'the connection was closed from the page');
    if (link.pending !== null) {
      await link.pending;
      if (link.session !== null && link.phase === 'connected') return { session: link.session, config };
    }
    if (!isConfigured(config)) {
      throw new DomainError('not-configured', 'no MCP endpoint is configured yet');
    }
    if (Date.now() - link.failedAt < RETRY_COOLDOWN_MS && link.phase === 'error') {
      throw new DomainError('not-connected', link.error);
    }
    await connect();
    if (link.session === null) throw new DomainError('not-connected', link.error);
    return { session: link.session, config: await store.load() };
  }

  /** Refresh the cached service-name list. */
  async function refreshServices(force) {
    if (link.session === null) return { ok: false, values: [] };
    if (!force && Date.now() - link.servicesAt < SERVICES_TTL_MS) {
      return { ok: true, values: link.services, label: link.servicesLabel };
    }
    const config = await store.load();
    const reader = new GrafanaReader(link.session, config, ctx.logger);
    const result = await reader.services();
    link.services = result.values;
    link.servicesLabel = result.label ?? '';
    link.servicesAt = Date.now();
    return result;
  }

  async function disconnect() {
    if (link.pending !== null) await link.pending.catch(() => {});
    const session = link.session;
    link.session = null;
    link.phase = 'disconnected';
    link.manual = true;
    link.services = [];
    link.servicesAt = 0;
    if (session !== null) await session.close().catch(() => {});
  }

  /** Run one read against the live session, mapping domain failures. */
  async function read(run) {
    const { session, config } = await ensure();
    const reader = new GrafanaReader(session, config, ctx.logger);
    return run(reader, config);
  }

  /** Domain failures answer 200 with a reason; real failures keep their status. */
  function fail(res, error) {
    if (error instanceof DomainError) {
      send(res, 200, { ok: false, reason: error.reason, note: error.note });
      return;
    }
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) ctx.logger?.warn?.(`my-deploy: ${String(error)}`);
    send(res, status, { ok: false, reason: 'error', note: error instanceof Error ? error.message : String(error) });
  }

  /* ---------- handlers ---------- */

  async function handleState(req, res) {
    send(res, 200, await snapshot());
  }

  async function handleConfig(req, res) {
    const body = await readJson(req);
    const previous = await store.load();
    const config = sanitizeConfig(body, previous);
    await store.save(config);
    /* A saved configuration is an explicit intent: it may dial again. */
    link.manual = false;
    const wantsConnect = body.connect === true || (config.autoConnect && !isConnected());
    if (wantsConnect) await connect();
    send(res, 200, await snapshot());
  }

  function isConnected() {
    return link.session !== null && link.phase === 'connected';
  }

  async function handleConnect(req, res) {
    await connect();
    send(res, 200, await snapshot());
  }

  async function handleDisconnect(req, res) {
    await disconnect();
    send(res, 200, await snapshot());
  }

  async function handleServices(req, res, params) {
    const force = params.get('refresh') === '1';
    const { config } = await ensure();
    const result = await refreshServices(force);
    send(res, 200, { ok: true, services: result.values ?? [], label: result.label ?? '', service: config.service });
  }

  async function handleMetrics(req, res, params) {
    const result = await read(async (reader, config) => reader.metrics(params.get('service') ?? config.service, rangeOf(params, config)));
    send(res, 200, result);
  }

  async function handleLogs(req, res, params) {
    const result = await read(async (reader, config) =>
      reader.logs(params.get('service') ?? config.service, rangeOf(params, config), limitOf(params, 60, 400)),
    );
    send(res, 200, result);
  }

  async function handleTraces(req, res, params) {
    const result = await read(async (reader, config) =>
      reader.traces(params.get('service') ?? config.service, rangeOf(params, config), limitOf(params, 40, 200)),
    );
    send(res, 200, result);
  }

  async function handleChat(req, res) {
    const body = await readJson(req);
    const question = typeof body.question === 'string' ? body.question.trim().slice(0, 4000) : '';
    if (question === '') throw new HttpError(400, 'question is empty');
    const tab = body.tab === 'traces' ? 'traces' : body.tab === 'monitor' ? 'monitor' : 'logs';
    const history = Array.isArray(body.history)
      ? body.history
          .slice(-8)
          .map((turn) => (turn !== null && typeof turn === 'object' ? { role: turn.role === 'assistant' ? 'assistant' : 'user', text: String(turn.text ?? '').slice(0, 4000) } : null))
          .filter((turn) => turn !== null && turn.text !== '')
      : [];

    const { session, config } = await ensure();
    const service = typeof body.service === 'string' ? body.service.slice(0, 200) : config.service;
    const range = typeof body.range === 'string' && body.range !== '' ? body.range : config.range;
    const reader = new GrafanaReader(session, config, ctx.logger);

    /* The window the model is told about is the one the page used. */
    const window = windowOf(range);
    const answer = await ask(ctx, {
      question,
      tab,
      service,
      range,
      history,
      session,
      reader,
      start: window.start,
      end: window.end,
      logger: ctx.logger,
    });
    send(res, 200, {
      ok: true,
      answer: answer.answer,
      calls: answer.calls,
      logs: answer.logs,
      traces: answer.traces,
      model: answer.model,
      degraded: answer.degraded === true,
      error: answer.error ?? '',
    });
  }

  /**
   * Record one page-side report: a mount heartbeat, an uncaught error, or a
   * failed chunk load. Answers even when the report is malformed, because a page
   * that cannot report is exactly the case this route exists for.
   */
  async function handleDiagnostic(req, res) {
    const body = await readJson(req);
    const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
    const view = body.view !== null && typeof body.view === 'object' ? body.view : null;
    const entry = {
      at: Date.now(),
      kind: text(body.kind, 40) || 'report',
      message: text(body.message, 2000),
      detail: text(body.detail, 4000),
      view:
        view === null
          ? null
          : {
              w: Number(view.w) || 0,
              h: Number(view.h) || 0,
              dpr: Number(view.dpr) || 0,
              tab: text(view.tab, 40),
              phase: text(view.phase, 80),
            },
    };
    await recordDiagnostic(entry);
    ctx.logger?.info?.(`my-deploy: page ${entry.kind}: ${entry.message.slice(0, 200)}`);
    send(res, 200, { ok: true, entries: reports.length });
  }

  /**
   * The route table: one exact prefix owner, with each path naming the methods
   * it accepts, so a GET can never write and a POST can never read the list.
   */
  const ROUTES = [
    { path: '/state', methods: ['GET', 'HEAD'], run: handleState },
    { path: '/config', methods: ['PUT', 'POST'], run: handleConfig },
    { path: '/connect', methods: ['POST'], run: handleConnect },
    { path: '/disconnect', methods: ['POST'], run: handleDisconnect },
    { path: '/services', methods: ['GET', 'HEAD'], run: handleServices },
    { path: '/metrics', methods: ['GET', 'HEAD'], run: handleMetrics },
    { path: '/logs', methods: ['GET', 'HEAD'], run: handleLogs },
    { path: '/traces', methods: ['GET', 'HEAD'], run: handleTraces },
    { path: '/chat', methods: ['POST'], run: handleChat },
    { path: '/diagnostic', methods: ['POST'], run: handleDiagnostic },
  ];

  const handler = async (req, res) => {
    try {
      const url = new URL(typeof req.url === 'string' ? req.url : '/', 'http://127.0.0.1');
      const rejection = requestRejection(ctx, req);
      if (rejection !== undefined) {
        send(res, rejection, { ok: false, reason: 'forbidden', note: 'untrusted request' });
        return;
      }
      if ((req.method === 'PUT' || req.method === 'POST') && !hasRequestGate(ctx) && !writeAllowed(req)) {
        send(res, 403, { ok: false, reason: 'forbidden', note: 'untrusted origin' });
        return;
      }

      const route = ROUTES.find((entry) => url.pathname === `${BASE}${entry.path}`);
      if (route === undefined) {
        send(res, 404, { ok: false, reason: 'not-found', note: url.pathname });
        return;
      }
      if (!route.methods.includes(req.method ?? 'GET')) {
        res.setHeader('allow', route.methods.join(', '));
        send(res, 405, { ok: false, reason: 'method-not-allowed', note: route.methods.join(', ') });
        return;
      }
      await route.run(req, res, url.searchParams);
    } catch (error) {
      fail(res, error);
    }
  };

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: BASE, handler }),
    'my-deploy: observability routes',
  );

  /* Connect once at activation, so the page opens with a real status. */
  ctx.effect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const config = await store.load();
        if (cancelled || !config.autoConnect || !isConfigured(config)) return;
        await connect();
      } catch (error) {
        ctx.logger?.warn?.(`my-deploy: initial MCP connection failed: ${String(error)}`);
      }
    })();
    return () => {
      cancelled = true;
      void disconnect().catch(() => {});
    };
  }, 'my-deploy: MCP lifecycle');
}
