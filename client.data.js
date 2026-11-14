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
      const { normalizeDashboards, normalizeLogs, normalizeMetrics, normalizeState, normalizeTraces } = runtime;

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

      /**
       * Refresh the service-name list from the datasource's label values.
       * @param refresh - ask the Host to bypass its own cache.
       * @param datasource - the Loki uid the filter is scoped to.
       * @param range - the window the label values are read over.
       */
      async function fetchServices(refresh, datasource, range) {
        const params = [];
        if (refresh === true) params.push('refresh=1');
        if (typeof datasource === 'string' && datasource !== '') params.push(`datasource=${encodeURIComponent(datasource)}`);
        if (typeof range === 'string' && range !== '') params.push(`range=${encodeURIComponent(range)}`);
        const body = await exchange(`/services${params.length === 0 ? '' : `?${params.join('&')}`}`, GET);
        return {
          ok: body.ok === true,
          note: typeof body.note === 'string' ? body.note : '',
          label: typeof body.label === 'string' ? body.label : '',
          services: Array.isArray(body.services) ? body.services.filter((name) => typeof name === 'string') : [],
        };
      }

      /** The datasource menu and its auto-picked default per view. */
      async function fetchDatasources() {
        const body = await exchange('/datasources', GET);
        const defaults = body.defaults !== null && typeof body.defaults === 'object' ? body.defaults : {};
        return {
          ok: body.ok === true,
          datasources: Array.isArray(body.datasources)
            ? body.datasources
                .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.uid === 'string')
                .map((entry) => ({
                  uid: entry.uid,
                  name: typeof entry.name === 'string' ? entry.name : entry.uid,
                  type: typeof entry.type === 'string' ? entry.type : '',
                  isDefault: entry.isDefault === true,
                }))
            : [],
          defaults: {
            monitor: typeof defaults.monitor === 'string' ? defaults.monitor : '',
            logs: typeof defaults.logs === 'string' ? defaults.logs : '',
            traces: typeof defaults.traces === 'string' ? defaults.traces : '',
          },
        };
      }

      /** The datasource part of a query string, empty when nothing is chosen. */
      function datasourceParam(datasource) {
        return typeof datasource === 'string' && datasource !== '' ? `&datasource=${encodeURIComponent(datasource)}` : '';
      }

      /** Every dashboard the MCP server can list. */
      async function fetchDashboards(query) {
        const params = [];
        if (typeof query === 'string' && query.trim() !== '') params.push(`query=${encodeURIComponent(query.trim())}`);
        return normalizeDashboards(await exchange(`/dashboards${params.length === 0 ? '' : `?${params.join('&')}`}`, GET));
      }

      /** The CPU and memory cards for one service, range, and datasource. */
      async function fetchMetrics(service, range, datasource) {
        const query = `?service=${encodeURIComponent(service)}&range=${encodeURIComponent(range)}${datasourceParam(datasource)}`;
        return normalizeMetrics(await exchange(`/metrics${query}`, GET));
      }

      /** The log rows for one service, range, and datasource; `keyword` filters lines. */
      async function fetchLogs(service, range, limit, datasource, keyword) {
        const params = [
          `service=${encodeURIComponent(service)}`,
          `range=${encodeURIComponent(range)}`,
          `limit=${encodeURIComponent(String(limit))}`,
        ];
        if (typeof datasource === 'string' && datasource !== '') params.push(`datasource=${encodeURIComponent(datasource)}`);
        if (typeof keyword === 'string' && keyword.trim() !== '') params.push(`keyword=${encodeURIComponent(keyword.trim())}`);
        return normalizeLogs(await exchange(`/logs?${params.join('&')}`, GET));
      }

      /** The trace rows for one service, range, and datasource. */
      async function fetchTraces(service, range, limit, datasource) {
        const query = `?service=${encodeURIComponent(service)}&range=${encodeURIComponent(range)}&limit=${encodeURIComponent(String(limit))}${datasourceParam(datasource)}`;
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
          /* A dashboard write tells the page to refetch its list. */
          mutated: body.mutated === true,
          created: Array.isArray(body.created) ? body.created.filter((entry) => entry !== null && typeof entry === 'object') : [],
        };
      }

      return {
        ask,
        connect,
        disconnect,
        fetchDashboards,
        fetchDatasources,
        fetchLogs,
        fetchMetrics,
        fetchServices,
        fetchState,
        fetchTraces,
        saveConfig,
      };
    };
  },
});
