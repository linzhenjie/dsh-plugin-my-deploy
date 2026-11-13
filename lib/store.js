/**
 * The durable settings of the my-deploy page.
 *
 * The file is plugin-owned JSON, published atomically, and never trusted on the
 * way in or out:
 *
 *   %DSH_HOME%\storages\my-deploy.json     (default %USERPROFILE%\.dsh\...)
 *
 * It holds the MCP endpoint, the request headers (so a token may live here), the
 * service and range the page last used, and the PromQL / LogQL / TraceQL
 * templates. Header values are masked before they reach the browser: the page
 * can show which headers exist, and a value the user did not retype is kept.
 */
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Transport tags this build speaks. */
export const TRANSPORTS = ['streamable-http', 'stdio'];

/** Ranges the page offers, in milliseconds. */
export const RANGES = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

/** Replacement shown for a header value the page should not receive. */
export const MASK = '\u2022\u2022\u2022\u2022\u2022\u2022';

/** Caps that bound the file and one request, not the user's patience. */
const LIMIT = { url: 2000, command: 400, arg: 400, args: 32, header: 4000, headers: 32, name: 32, service: 200 };

/**
 * Default query templates. `$SERVICE` expands to a label filter, so an empty
 * service means "everything" rather than a broken selector.
 */
export const DEFAULT_QUERIES = {
  cpu: 'sum by (pod) (rate(container_cpu_usage_seconds_total{$SERVICE,container!=""}[5m]))',
  memory: 'sum by (pod) (container_memory_working_set_bytes{$SERVICE,container!=""})',
  logs: '{service_name="$SERVICE_VALUE"}',
  traces: '{ resource.service.name = "$SERVICE_VALUE" }',
};

function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

/** Accept a bare host as http; keep any explicit scheme. Mirrors the Client. */
export function normalizeUrl(value) {
  const raw = text(value, LIMIT.url).trim();
  if (raw === '') return '';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return raw;
  return `http://${raw}`;
}

/** The server name is a display label and a tool prefix, never a path. */
export function normalizeServerName(value) {
  const raw = text(value, LIMIT.name).trim();
  return /^[A-Za-z0-9_-]{1,32}$/.test(raw) ? raw : 'grafana';
}

/** One `Name: Value` per line; blank lines and `#` comments are ignored. */
export function parseHeaders(source) {
  const headers = [];
  const seen = new Set();
  for (const line of text(source, LIMIT.header).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf(':');
    if (at <= 0) continue;
    const name = trimmed.slice(0, at).trim();
    const value = trimmed.slice(at + 1).trim();
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,80}$/.test(name)) continue;
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    headers.push([name, value]);
    if (headers.length >= LIMIT.headers) break;
  }
  return headers;
}

/** Render header pairs back into the editable text form. */
export function formatHeaders(pairs) {
  return pairs.map(([name, value]) => `${name}: ${value}`).join('\n');
}

/** Replace every non-empty header value with the mask, keeping the names. */
export function maskHeadersText(source) {
  return parseHeaders(source)
    .map(([name, value]) => `${name}: ${value === '' ? '' : MASK}`)
    .join('\n');
}

/**
 * Merge a submitted header text over the stored one: a value the page echoed
 * back as the mask means "unchanged", so the real value is preserved.
 */
export function mergeHeadersText(submitted, stored) {
  const previous = new Map(parseHeaders(stored).map(([name, value]) => [name.toLowerCase(), value]));
  const pairs = parseHeaders(submitted).map(([name, value]) => {
    if (value !== MASK) return [name, value];
    const kept = previous.get(name.toLowerCase());
    return [name, kept === undefined ? '' : kept];
  });
  return formatHeaders(pairs);
}

function defaultConfig() {
  return {
    version: 1,
    transport: 'streamable-http',
    url: '',
    command: '',
    args: [],
    headersText: '',
    serverName: 'grafana',
    autoConnect: true,
    service: '',
    range: '1h',
    datasourceUid: '',
    queries: { ...DEFAULT_QUERIES },
  };
}

function sanitizeQueryMap(raw, previous) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const pick = (key) => {
    const value = text(source[key], 4000).trim();
    return value === '' ? previous[key] : value;
  };
  return {
    cpu: pick('cpu'),
    memory: pick('memory'),
    logs: pick('logs'),
    traces: pick('traces'),
  };
}

/**
 * Coerce arbitrary input into the one shape this plugin stores.
 * @param raw - untrusted input, e.g. a request body.
 * @param previous - the last stored config, used for masked or omitted fields.
 */
export function sanitizeConfig(raw, previous = defaultConfig()) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const transport = oneOf(source.transport, TRANSPORTS, previous.transport);
  const args = Array.isArray(source.args)
    ? source.args.slice(0, LIMIT.args).map((arg) => text(arg, LIMIT.arg).trim()).filter((arg) => arg !== '')
    : previous.args;
  const headersText =
    typeof source.headersText === 'string' ? mergeHeadersText(source.headersText, previous.headersText) : previous.headersText;
  return {
    version: 1,
    transport,
    url: 'url' in source ? normalizeUrl(source.url) : previous.url,
    command: 'command' in source ? text(source.command, LIMIT.command).trim() : previous.command,
    args,
    headersText,
    serverName: 'serverName' in source ? normalizeServerName(source.serverName) : previous.serverName,
    autoConnect: typeof source.autoConnect === 'boolean' ? source.autoConnect : previous.autoConnect,
    service: 'service' in source ? text(source.service, LIMIT.service).trim() : previous.service,
    range: 'range' in source ? oneOf(source.range, Object.keys(RANGES), previous.range) : previous.range,
    datasourceUid: 'datasourceUid' in source ? text(source.datasourceUid, 200).trim() : previous.datasourceUid,
    queries: sanitizeQueryMap(source.queries, previous.queries),
  };
}

/** Whether the stored config names an endpoint this build can dial. */
export function isConfigured(config) {
  if (config.transport === 'stdio') return config.command !== '';
  return config.url !== '';
}

/** The file path, honoring the harness home. */
export function dataFile() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  const home = configured === '' ? join(homedir(), '.dsh') : configured;
  return join(home, 'storages', 'my-deploy.json');
}

/**
 * @param file - absolute state file path.
 * @param logger - host logger for non-fatal diagnostics.
 */
export function createStore(file, logger) {
  let snapshot = { config: defaultConfig(), stamp: 'missing' };
  let chain = Promise.resolve();

  /** Publish through a synced temp file and rename; never a partial write. */
  async function publish(config) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const payload = `${JSON.stringify(config, null, 2)}\n`;
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
    snapshot = { config, stamp: `${info.mtimeMs}:${info.size}` };
  }

  /** Park an unreadable file beside the original instead of overwriting it. */
  async function quarantine() {
    const target = `${file}.corrupt-${Date.now()}`;
    try {
      await rename(file, target);
      logger?.warn?.(`my-deploy: stored settings were not valid JSON; moved to ${target}`);
    } catch (error) {
      logger?.warn?.(`my-deploy: could not move the invalid settings file: ${String(error)}`);
    }
    snapshot = { config: defaultConfig(), stamp: 'missing' };
  }

  return {
    async load() {
      let info;
      try {
        info = await stat(file);
      } catch (error) {
        if (error.code === 'ENOENT') {
          snapshot = { config: defaultConfig(), stamp: 'missing' };
          return snapshot.config;
        }
        throw error;
      }
      const stamp = `${info.mtimeMs}:${info.size}`;
      if (stamp === snapshot.stamp) return snapshot.config;
      const contents = await readFile(file, 'utf8');
      let parsed;
      try {
        parsed = JSON.parse(contents);
      } catch {
        await quarantine();
        return snapshot.config;
      }
      snapshot = { config: sanitizeConfig(parsed, defaultConfig()), stamp };
      return snapshot.config;
    },

    /** Serialize writes so concurrent requests cannot interleave publications. */
    save(config) {
      const next = chain.then(
        () => publish(config),
        () => publish(config),
      );
      chain = next.catch(() => {});
      return next;
    },
  };
}
