/**
 * The one HTTP exchange with the plugin's Host half.
 *
 * Every route lives under `/api/my-deploy` and answers JSON. A domain failure
 * (no endpoint yet, no matching tool, a failed query) answers 200 with
 * `ok: false` and a `reason`, so callers render an empty state instead of an
 * error; a non-2xx answer is a transport or trust failure and throws.
 */
window.__ModuleLoader__.load({
  id: 'my-deploy',
  chunk: 'client.data.js',
  factory() {
    return (runtime) => {
      const { normalizeLogs, normalizeMetrics, normalizeState, normalizeTraces } = runtime;

      /** Host route prefix owned by the plugin's Host half. */
      const BASE = '/api/my-deploy';

      /** Read a JSON body, or throw the reason the Host gave. */
      async function exchange(path, init) {
        const response = await fetch(`${BASE}${path}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { accept: 'application/json', ...(init && init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
          ...init,
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          const detail = body !== null && typeof body === 'object' ? body.note || body.error : '';
          throw new Error(detail === '' ? `HTTP ${response.status}` : detail);
        }
        if (body === null || typeof body !== 'object') throw new Error('the Host returned an empty answer');
        return body;
      }

      const GET = { method: 'GET' };

      /** Settings, connection state, and the service-name list. */
      async function fetchState() {
        return normalizeState(await exchange('/state', GET));
      }

      /** Save settings; `patch.connect` also dials the endpoint. */
      async function saveConfig(patch) {
        return normalizeState(await exchange('/config', { method: 'PUT', body: JSON.stringify(patch) }));
      }

      /** Dial the stored endpoint. */
      async function connect() {
        return normalizeState(await exchange('/connect', { method: 'POST', body: '{}' }));
      }

      /** Close the live session. */
      async function disconnect() {
        return normalizeState(await exchange('/disconnect', { method: 'POST', body: '{}' }));
      }

      /** Refresh the service-name list from the MCP server. */
      async function fetchServices(refresh) {
        const body = await exchange(`/services${refresh === true ? '?refresh=1' : ''}`, GET);
        return {
          ok: body.ok === true,
          note: typeof body.note === 'string' ? body.note : '',
          services: Array.isArray(body.services) ? body.services.filter((name) => typeof name === 'string') : [],
        };
      }

      /** The CPU and memory cards for one service and range. */
      async function fetchMetrics(service, range) {
        const query = `?service=${encodeURIComponent(service)}&range=${encodeURIComponent(range)}`;
        return normalizeMetrics(await exchange(`/metrics${query}`, GET));
      }

      /** The log rows for one service and range. */
      async function fetchLogs(service, range, limit) {
        const query = `?service=${encodeURIComponent(service)}&range=${encodeURIComponent(range)}&limit=${encodeURIComponent(String(limit))}`;
        return normalizeLogs(await exchange(`/logs${query}`, GET));
      }

      /** The trace rows for one service and range. */
      async function fetchTraces(service, range, limit) {
        const query = `?service=${encodeURIComponent(service)}&range=${encodeURIComponent(range)}&limit=${encodeURIComponent(String(limit))}`;
        return normalizeTraces(await exchange(`/traces${query}`, GET));
      }

      /** One question answered through the MCP tools. */
      async function ask(payload) {
        const body = await exchange('/chat', { method: 'POST', body: JSON.stringify(payload) });
        return {
          ok: body.ok === true,
          reason: typeof body.reason === 'string' ? body.reason : '',
          note: typeof body.note === 'string' ? body.note : '',
          answer: typeof body.answer === 'string' ? body.answer : '',
          calls: Array.isArray(body.calls) ? body.calls : [],
          logs: body.logs === null || body.logs === undefined ? null : normalizeLogs(body.logs),
          traces: body.traces === null || body.traces === undefined ? null : normalizeTraces(body.traces),
          model: typeof body.model === 'string' ? body.model : '',
          degraded: body.degraded === true,
        };
      }

      return { ask, connect, disconnect, fetchLogs, fetchMetrics, fetchServices, fetchState, fetchTraces, saveConfig };
    };
  },
});
