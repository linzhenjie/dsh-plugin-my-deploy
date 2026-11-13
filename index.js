/**
 * Host half of the `my-deploy` bundle.
 *
 * Owns the durable state of the sidebar page and serves it to the Client half
 * over one loopback route. The file is plugin-owned JSON, published atomically:
 *
 *   %DSH_HOME%\storages\my-deploy.json     (default %USERPROFILE%\.dsh\...)
 *
 * Route: GET /api/my-deploy/state  -> { ok, state, file }
 *        PUT /api/my-deploy/state  -> { ok, state, file }
 *
 * The web server carries no authentication of its own, so this route enforces
 * its policy: loopback-only by binding, a same-origin check for writes, a body
 * limit, and full server-side sanitization — a stored file is never trusted.
 */
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Services required before this plugin may activate. */
export const inject = ['webServer'];

/** Route pathname; also the Client's only endpoint. */
const ROUTE = '/api/my-deploy/state';
/** Largest accepted request body, so one bad client cannot exhaust memory. */
const MAX_BODY_BYTES = 256 * 1024;
/** Tab ids the page understands; a stored tab outside this set is ignored. */
const TABS = ['nav', 'todo', 'note'];
/** Per-field caps: they bound the file and one request, not the user's patience. */
const LIMIT = { items: 500, title: 200, url: 2048, text: 20000, id: 80 };
/**
 * Feature tags this Host build implements. The Client compares them against its
 * own expectations and refuses to adopt a response that would silently drop
 * fields — a stale Host module must surface as a message, not as data loss.
 * `history` = hidden/hiddenAt survive a save; `stamps` = a to-do's createdAt does.
 */
const CAPABILITIES = ['history', 'stamps'];

/** A request failure carrying the status the caller should answer with. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Absolute path of the state file, honoring the harness home. */
function dataFile() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  const home = configured === '' ? join(homedir(), '.dsh') : configured;
  return join(home, 'storages', 'my-deploy.json');
}

function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function makeId() {
  return `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function idOf(value) {
  const candidate = text(value, LIMIT.id).trim();
  return /^[A-Za-z0-9._:-]+$/.test(candidate) ? candidate : makeId();
}

/** Accept a bare host as https; keep any explicit scheme. Mirrors the Client. */
function normalizeUrl(value) {
  const raw = text(value, LIMIT.url).trim();
  if (raw === '') return '';
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) ? raw : `https://${raw}`;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** Normalize one stored row, or drop it when the fields its tab needs are gone. */
function sanitizeItem(kind, raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  /* A row the user deleted stays in the file as history: `hidden` + when. */
  const retain = (item) => {
    if (raw.hidden !== true) return item;
    item.hidden = true;
    item.hiddenAt = Number.isFinite(raw.hiddenAt) ? Math.max(0, Math.floor(raw.hiddenAt)) : Date.now();
    return item;
  };
  if (kind === 'nav') {
    const url = normalizeUrl(raw.url);
    if (url === '') return null;
    return retain({ id: idOf(raw.id), title: text(raw.title, LIMIT.title).trim() || hostOf(url) || url, url });
  }
  const body = text(raw.text, LIMIT.text).trim();
  if (body === '') return null;
  if (kind === 'todo') {
    const item = { done: raw.done === true, id: idOf(raw.id), text: body };
    /* A to-do records when it was captured; the page shows it on the right. */
    if (Number.isFinite(raw.createdAt)) item.createdAt = Math.max(0, Math.floor(raw.createdAt));
    return retain(item);
  }
  return retain({ id: idOf(raw.id), text: body });
}

/** Coerce arbitrary input into the one shape this plugin stores. */
function sanitize(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const pick = (kind) => {
    const list = Array.isArray(source[kind]) ? source[kind] : [];
    const items = [];
    const seen = new Set();
    for (const entry of list.slice(0, LIMIT.items)) {
      const item = sanitizeItem(kind, entry);
      if (item === null) continue;
      if (seen.has(item.id)) item.id = makeId();
      seen.add(item.id);
      items.push(item);
    }
    return items;
  };
  return { version: 1, nav: pick('nav'), todo: pick('todo'), note: pick('note') };
}

function emptyState() {
  return { version: 1, nav: [], todo: [], note: [] };
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
 * Decide whether this request may reach the route.
 *
 * The Web composition's `connection` service owns the policy its own /api uses —
 * Host/Origin trust plus browser login — and exposes it for exactly this purpose.
 * Delegating means the route inherits the deployment's trusted authorities and
 * the browser's session, instead of a second, stricter rule that would break
 * behind a reverse proxy. Compositions without that service fall back to a
 * same-origin rule for writes.
 * @param ctx - host context; `connection` is read per request because it mounts late.
 * @param req - the HTTP request.
 * @returns the status to answer with, or undefined when the request may proceed.
 */
function requestRejection(ctx, req) {
  const connection = ctx.get('connection');
  if (connection === undefined || typeof connection.requestRejection !== 'function') return undefined;
  try {
    const status = connection.requestRejection(req);
    return status === 401 || status === 403 ? status : undefined;
  } catch {
    // A gate that throws has admitted nothing: failing open would expose the route.
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

/**
 * The state file: mtime/size-keyed memory snapshot plus atomic publication.
 * @param file - absolute state file path.
 * @param logger - host logger for non-fatal diagnostics.
 */
function createStore(file, logger) {
  let snapshot = { state: emptyState(), stamp: 'missing' };
  let chain = Promise.resolve();

  /** Publish `state` through a synced temp file and rename; never a partial write. */
  async function publish(state) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    const temp = `${file}.tmp`;
    const handle = await open(temp, 'w', 0o600);
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
    const info = await stat(file);
    snapshot = { state, stamp: `${info.mtimeMs}:${info.size}` };
  }

  /** Park an unreadable file beside the original instead of overwriting it. */
  async function quarantine() {
    const target = `${file}.corrupt-${Date.now()}`;
    try {
      await rename(file, target);
      logger?.warn?.(`my-deploy: stored file was not valid JSON; moved to ${target}`);
    } catch (error) {
      logger?.warn?.(`my-deploy: could not move the invalid stored file: ${String(error)}`);
    }
    snapshot = { state: emptyState(), stamp: 'missing' };
  }

  return {
    async load() {
      let info;
      try {
        info = await stat(file);
      } catch (error) {
        if (error.code === 'ENOENT') {
          snapshot = { state: emptyState(), stamp: 'missing' };
          return snapshot.state;
        }
        throw error;
      }
      const stamp = `${info.mtimeMs}:${info.size}`;
      if (stamp === snapshot.stamp) return snapshot.state;
      const contents = await readFile(file, 'utf8');
      let parsed;
      try {
        parsed = JSON.parse(contents);
      } catch {
        await quarantine();
        return snapshot.state;
      }
      snapshot = { state: sanitize(parsed), stamp };
      return snapshot.state;
    },

    /** Serialize writes so concurrent requests cannot interleave publications. */
    save(state) {
      const next = chain.then(
        () => publish(state),
        () => publish(state),
      );
      chain = next.catch(() => {});
      return next;
    },
  };
}

/**
 * @param ctx - host context; `webServer` supplies the route table.
 */
export function apply(ctx) {
  const file = dataFile();
  const store = createStore(file, ctx.logger);

  const handler = async (req, res) => {
    try {
      const url = new URL(typeof req.url === 'string' ? req.url : '/', 'http://127.0.0.1');
      if (url.pathname !== ROUTE) {
        send(res, 404, { ok: false, error: 'not found' });
        return;
      }

      const rejection = requestRejection(ctx, req);
      if (rejection !== undefined) {
        send(res, rejection, { ok: false, error: rejection === 401 ? 'unauthenticated' : 'forbidden' });
        return;
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        const state = await store.load();
        send(res, 200, { ok: true, state, file, capabilities: CAPABILITIES });
        return;
      }

      if (req.method === 'PUT' || req.method === 'POST') {
        if (!hasRequestGate(ctx) && !writeAllowed(req)) {
          send(res, 403, { ok: false, error: 'untrusted origin' });
          return;
        }
        const raw = await readBody(req, MAX_BODY_BYTES);
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new HttpError(400, 'body is not valid JSON');
        }
        const state = sanitize(parsed);
        await store.save(state);
        send(res, 200, { ok: true, state, file, capabilities: CAPABILITIES });
        return;
      }

      res.setHeader('allow', 'GET, HEAD, PUT, POST');
      send(res, 405, { ok: false, error: 'method not allowed' });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status >= 500) ctx.logger?.warn?.(`my-deploy: ${String(error)}`);
      send(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE, handler }),
    'my-deploy: state route',
  );
}
