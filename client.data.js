/**
 * The one HTTP exchange with the plugin's Host half.
 *
 * `/api/my-deploy/state` is an exact route registered by `index.js`. It
 * answers `{ ok, state, file, capabilities }`; the capability tags let this
 * bundle detect a stale Host module instead of silently losing fields.
 */
window.__ModuleLoader__.load({
  id: 'my-deploy',
  chunk: 'client.data.js',
  factory() {
    return (runtime) => {
      const { normalizeState, textOf } = runtime;

      /** Host route owned by the plugin's Host half. */
      const API = '/api/my-deploy/state';

      /** Feature tags the Host build must advertise before its echo is trusted. */
      const CAPABILITIES = ['history', 'stamps'];

      /** Whether a Host response advertises every feature this bundle relies on. */
      function supportsCapabilities(advertised) {
        return CAPABILITIES.every((name) => advertised.includes(name));
      }

      /** Feature tags a Host response advertises; an old Host advertises none. */
      function capabilitiesOf(body) {
        return body !== null && body !== undefined && Array.isArray(body.capabilities) ? body.capabilities : [];
      }

      /** Normalize one successful response body. */
      function responseOf(body) {
        if (body === null || body === undefined || body.ok !== true) throw new Error('unexpected response');
        return {
          state: normalizeState(body.state),
          file: textOf(body.file),
          capabilities: capabilitiesOf(body),
        };
      }

      /** Read Host state; resolves with `{ state, file, capabilities }`. */
      async function fetchState() {
        const response = await fetch(API, {
          method: 'GET',
          headers: { accept: 'application/json' },
          cache: 'no-store',
          credentials: 'same-origin',
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error((body && body.error) || `HTTP ${response.status}`);
        return responseOf(body);
      }

      /** Write Host state; resolves with the sanitized echo and its capabilities. */
      async function pushState(state) {
        const response = await fetch(API, {
          method: 'PUT',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          cache: 'no-store',
          credentials: 'same-origin',
          body: JSON.stringify(state),
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error((body && body.error) || `HTTP ${response.status}`);
        return responseOf(body);
      }

      return { CAPABILITIES, fetchState, pushState, supportsCapabilities };
    };
  },
});
