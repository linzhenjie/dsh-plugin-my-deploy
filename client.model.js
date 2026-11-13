/**
 * The page's state shape and the pure operations on it: tab registry, range
 * registry, response normalization, and the chat transcript helpers.
 */
window.__ModuleLoader__.load({
  id: 'my-deploy',
  chunk: 'client.model.js',
  factory() {
    return (runtime) => {
      const { textOf } = runtime;

      /** Tabs in render order. Adding a tab means a registry entry and a view. */
      const TABS = ['monitor', 'logs', 'traces'];
      const TAB_LABELS = { monitor: 'tab.monitor', logs: 'tab.logs', traces: 'tab.traces' };
      /** Range tags the Host understands, shortest first. */
      const RANGES = ['5m', '15m', '1h', '6h', '24h'];
      const RANGE_LABELS = {
        '5m': 'range.5m',
        '15m': 'range.15m',
        '1h': 'range.1h',
        '6h': 'range.6h',
        '24h': 'range.24h',
      };
      /** Feature tags the Host build must advertise before its answers are trusted. */
      const CAPABILITIES = ['mcp', 'metrics', 'logs', 'traces', 'chat'];

      const TAB_KEY = 'dsh.my-deploy.tab.v1';
      const RANGE_KEY = 'dsh.my-deploy.range.v1';
      const SERVICE_KEY = 'dsh.my-deploy.service.v1';

      const DEFAULT_CONFIG = {
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
        queries: { cpu: '', memory: '', logs: '', traces: '' },
      };

      const IDLE_CONNECTION = {
        status: 'idle',
        serverName: '',
        serverInfo: { name: '', version: '' },
        protocolVersion: '',
        instructions: '',
        tools: [],
        connectedAt: 0,
        error: '',
      };

      /** One loaded piece of the page: phase, payload, and a detail line. */
      function piece(phase, data, detail) {
        return { phase, data, detail: textOf(detail) };
      }

      /**
       * The piece one tab loads. The monitor tab reads the `metrics` piece, which
       * is *not* named after the tab: every reader and writer of `pieces` goes
       * through this map so a tab id can never be used as a piece key by accident.
       */
      const PIECE_KEYS = { monitor: 'metrics', logs: 'logs', traces: 'traces' };

      /** The piece key for one tab id, or undefined for an unknown id. */
      function pieceKeyOf(tab) {
        return Object.prototype.hasOwnProperty.call(PIECE_KEYS, tab) ? PIECE_KEYS[tab] : undefined;
      }

      /** The three pieces, all unloaded. */
      function initialPieces() {
        return {
          metrics: piece('idle', null, ''),
          logs: piece('idle', null, ''),
          traces: piece('idle', null, ''),
        };
      }

      /**
       * Mark one piece as loading, keeping its last payload on screen.
       * Pure, and tolerant of an unknown key: a load for a piece that does not
       * exist is a no-op instead of a render-time crash.
       */
      function markLoading(pieces, kind) {
        const current = pieces !== null && typeof pieces === 'object' ? pieces[kind] : undefined;
        if (current === undefined) return pieces;
        return { ...pieces, [kind]: piece('loading', current.data, current.detail) };
      }

      /** Mark one piece with its settled payload. */
      function markSettled(pieces, kind, payload, detail) {
        const phase = payload !== null && typeof payload === 'object' && payload.ok === true ? 'ready' : 'empty';
        return { ...pieces, [kind]: piece(phase, payload, detail) };
      }

      /** Mark one piece as failed, keeping no payload. */
      function markFailed(pieces, kind, detail) {
        return { ...pieces, [kind]: piece('error', null, detail) };
      }

      /** Read the last tab from storage, falling back to the first one. */
      function readTab() {
        try {
          const stored = window.localStorage.getItem(TAB_KEY);
          return TABS.includes(stored) ? stored : TABS[0];
        } catch (error) {
          return TABS[0];
        }
      }

      function writeTab(tab) {
        try {
          window.localStorage.setItem(TAB_KEY, tab);
        } catch (error) {
          /* storage is optional */
        }
      }

      function readRange() {
        try {
          const stored = window.localStorage.getItem(RANGE_KEY);
          return RANGES.includes(stored) ? stored : '1h';
        } catch (error) {
          return '1h';
        }
      }

      function writeRange(range) {
        try {
          window.localStorage.setItem(RANGE_KEY, range);
        } catch (error) {
          /* storage is optional */
        }
      }

      function readService() {
        try {
          return textOf(window.localStorage.getItem(SERVICE_KEY));
        } catch (error) {
          return '';
        }
      }

      function writeService(service) {
        try {
          window.localStorage.setItem(SERVICE_KEY, service);
        } catch (error) {
          /* storage is optional */
        }
      }

      /** Normalize a connection view from the Host. */
      function normalizeConnection(raw) {
        const source = raw !== null && typeof raw === 'object' ? raw : {};
        const status = ['idle', 'connecting', 'connected', 'disconnected', 'error'].includes(source.status)
          ? source.status
          : 'idle';
        const info = source.serverInfo !== null && typeof source.serverInfo === 'object' ? source.serverInfo : {};
        return {
          status,
          serverName: textOf(source.serverName),
          serverInfo: { name: textOf(info.name), version: textOf(info.version) },
          protocolVersion: textOf(source.protocolVersion),
          instructions: textOf(source.instructions),
          tools: Array.isArray(source.tools)
            ? source.tools
                .filter((tool) => tool !== null && typeof tool === 'object')
                .map((tool) => ({ name: textOf(tool.name), description: textOf(tool.description) }))
            : [],
          connectedAt: typeof source.connectedAt === 'number' ? source.connectedAt : 0,
          error: textOf(source.error),
        };
      }

      /** Normalize the persisted settings; a missing field keeps its default. */
      function normalizeConfig(raw) {
        const source = raw !== null && typeof raw === 'object' ? raw : {};
        const queries = source.queries !== null && typeof source.queries === 'object' ? source.queries : {};
        return {
          transport: source.transport === 'stdio' ? 'stdio' : 'streamable-http',
          url: textOf(source.url),
          command: textOf(source.command),
          args: Array.isArray(source.args) ? source.args.filter((arg) => typeof arg === 'string') : [],
          headersText: textOf(source.headersText),
          serverName: textOf(source.serverName) || 'grafana',
          autoConnect: source.autoConnect !== false,
          service: textOf(source.service),
          range: RANGES.includes(source.range) ? source.range : '1h',
          datasourceUid: textOf(source.datasourceUid),
          queries: {
            cpu: textOf(queries.cpu),
            memory: textOf(queries.memory),
            logs: textOf(queries.logs),
            traces: textOf(queries.traces),
          },
        };
      }

      /** Normalize one `/state` answer. */
      function normalizeState(body) {
        const source = body !== null && typeof body === 'object' ? body : {};
        return {
          config: normalizeConfig(source.config),
          connection: normalizeConnection(source.connection),
          services: Array.isArray(source.services) ? source.services.filter((name) => typeof name === 'string') : [],
          servicesLabel: textOf(source.servicesLabel),
          file: textOf(source.file),
          capabilities: Array.isArray(source.capabilities) ? source.capabilities.filter((tag) => typeof tag === 'string') : [],
        };
      }

      /** Whether a Host answer advertises every feature this bundle relies on. */
      function supportsCapabilities(advertised) {
        return CAPABILITIES.every((tag) => advertised.includes(tag));
      }

      /** The reason a domain failure carries; success is `''`. */
      function reasonOf(payload) {
        const source = payload !== null && typeof payload === 'object' ? payload : {};
        if (source.ok === true) return '';
        return textOf(source.reason) || 'error';
      }

      /** The localized sentence for a Host reason code. */
      function reasonText(t, reason) {
        switch (reason) {
          case 'not-configured':
            return t('mcp.status.idle');
          case 'not-connected':
            return t('status.notConnected');
          case 'no-tool':
            return t('status.noTool');
          case 'query-failed':
            return t('status.queryFailed');
          case 'grafana-auth':
            return t('status.grafanaAuth');
          case 'connect-failed':
            return t('mcp.status.error');
          case 'no-model':
            return t('status.noModel');
          default:
            return t('status.error');
        }
      }

      /** The localized label of a connection status. */
      function connectionLabel(t, status) {
        switch (status) {
          case 'connected':
            return t('mcp.status.connected');
          case 'connecting':
            return t('mcp.status.connecting');
          case 'disconnected':
            return t('mcp.status.disconnected');
          case 'error':
            return t('mcp.status.error');
          default:
            return t('mcp.status.idle');
        }
      }

      /** The empty transcript for both chat tabs. */
      function initialChat() {
        return { logs: [], traces: [] };
      }

      /** Append one message to one chat tab. */
      function appendChat(chat, tab, entry) {
        const key = tab === 'traces' ? 'traces' : 'logs';
        return { ...chat, [key]: [...chat[key], entry] };
      }

      /** A user or assistant message the transcript renders. */
      function chatMessage(role, text, extra) {
        return {
          id: `${role}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          role,
          text: textOf(text),
          calls: extra !== null && typeof extra === 'object' && Array.isArray(extra.calls) ? extra.calls : [],
          tone: extra !== null && typeof extra === 'object' && extra.tone === 'error' ? 'error' : '',
          note: extra !== null && typeof extra === 'object' ? textOf(extra.note) : '',
        };
      }

      /** The turns the model replays: role plus text, newest last. */
      function chatHistory(entries) {
        return (Array.isArray(entries) ? entries : [])
          .filter((entry) => entry !== null && typeof entry === 'object' && textOf(entry.text) !== '')
          .slice(-8)
          .map((entry) => ({ role: entry.role === 'assistant' ? 'assistant' : 'user', text: entry.text }));
      }

      /** A log payload with every field the list needs. */
      function normalizeLogs(payload) {
        const source = payload !== null && typeof payload === 'object' ? payload : {};
        const rows = Array.isArray(source.rows)
          ? source.rows
              .filter((row) => row !== null && typeof row === 'object')
              .map((row) => ({
                ts: typeof row.ts === 'number' ? row.ts : 0,
                time: textOf(row.time),
                level: textOf(row.level),
                message: textOf(row.message),
                labels: row.labels !== null && typeof row.labels === 'object' ? row.labels : {},
              }))
          : [];
        return {
          ok: source.ok === true,
          reason: textOf(source.reason),
          note: textOf(source.note),
          tool: textOf(source.tool),
          query: textOf(source.query),
          rows,
        };
      }

      /** A trace payload with every field the tree needs. */
      function normalizeTraces(payload) {
        const source = payload !== null && typeof payload === 'object' ? payload : {};
        const traces = Array.isArray(source.traces)
          ? source.traces
              .filter((trace) => trace !== null && typeof trace === 'object')
              .map((trace) => ({
                traceId: textOf(trace.traceId),
                root: textOf(trace.root),
                service: textOf(trace.service),
                start: typeof trace.start === 'number' ? trace.start : 0,
                durationMs: typeof trace.durationMs === 'number' ? trace.durationMs : 0,
                spanCount: typeof trace.spanCount === 'number' ? trace.spanCount : 0,
                error: trace.error === true,
                spans: Array.isArray(trace.spans)
                  ? trace.spans
                      .filter((span) => span !== null && typeof span === 'object')
                      .map((span) => ({
                        id: textOf(span.id),
                        name: textOf(span.name),
                        service: textOf(span.service),
                        start: typeof span.start === 'number' ? span.start : 0,
                        durationMs: typeof span.durationMs === 'number' ? span.durationMs : 0,
                        depth: typeof span.depth === 'number' ? span.depth : 0,
                        error: span.error === true,
                      }))
                  : [],
              }))
          : [];
        return {
          ok: source.ok === true,
          reason: textOf(source.reason),
          note: textOf(source.note),
          tool: textOf(source.tool),
          query: textOf(source.query),
          traces,
        };
      }

      /** One metric card (`cpu` or `memory`) with a point list and its stats. */
      function normalizeMetric(raw) {
        const source = raw !== null && typeof raw === 'object' ? raw : {};
        const points = Array.isArray(source.points)
          ? source.points
              .filter((point) => Array.isArray(point) && point.length >= 2)
              .map((point) => [Number(point[0]), Number(point[1])])
              .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]))
          : [];
        return {
          ok: source.ok === true,
          reason: textOf(source.reason),
          note: textOf(source.note),
          tool: textOf(source.tool),
          query: textOf(source.query),
          points,
          current: typeof source.current === 'number' ? source.current : 0,
          avg: typeof source.avg === 'number' ? source.avg : 0,
          max: typeof source.max === 'number' ? source.max : 0,
          series: Array.isArray(source.series)
            ? source.series
                .filter((entry) => entry !== null && typeof entry === 'object')
                .map((entry) => ({
                  name: textOf(entry.name),
                  current: typeof entry.current === 'number' ? entry.current : 0,
                  avg: typeof entry.avg === 'number' ? entry.avg : 0,
                  max: typeof entry.max === 'number' ? entry.max : 0,
                }))
            : [],
        };
      }

      /** A metrics payload with its two cards. */
      function normalizeMetrics(payload) {
        const source = payload !== null && typeof payload === 'object' ? payload : {};
        return {
          ok: source.ok === true,
          reason: textOf(source.reason),
          note: textOf(source.note),
          service: textOf(source.service),
          range: textOf(source.range),
          cpu: normalizeMetric(source.cpu),
          memory: normalizeMetric(source.memory),
        };
      }

      return {
        CAPABILITIES,
        DEFAULT_CONFIG,
        IDLE_CONNECTION,
        RANGES,
        RANGE_LABELS,
        TABS,
        TAB_LABELS,
        appendChat,
        chatHistory,
        chatMessage,
        connectionLabel,
        initialChat,
        initialPieces,
        markFailed,
        markLoading,
        markSettled,
        normalizeConfig,
        normalizeLogs,
        normalizeMetrics,
        normalizeState,
        normalizeTraces,
        piece,
        pieceKeyOf,
        readRange,
        readService,
        readTab,
        reasonOf,
        reasonText,
        supportsCapabilities,
        writeRange,
        writeService,
        writeTab,
      };
    };
  },
});
