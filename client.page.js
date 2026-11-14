/**
 * The page: header (title, tabs, connection pill, refresh), the service and
 * range filters, the active view, the chat under the logs and traces tabs, and
 * the MCP connection drawer.
 *
 * All Host traffic goes through `client.data.js`. Loads are sequence-guarded, so
 * switching a tab, a service, or a range can never let an older answer overwrite
 * a newer one.
 */
window.__ModuleLoader__.load({
  id: 'my-deploy',
  chunk: 'client.page.js',
  factory() {
    return (runtime) => {
      const {
        DEFAULT_CONFIG,
        IDLE_CONNECTION,
        ConnectionPill,
        ChatPanel,
        DashboardList,
        DatasourceSelect,
        IconRefresh,
        KeywordInput,
        LogList,
        McpDrawer,
        MonitorView,
        RangeSelect,
        ServiceSelect,
        StatusNote,
        TABS,
        Tabs,
        TraceList,
        appendChat,
        ask,
        chatHistory,
        chatKeyOf,
        chatMessage,
        connect,
        datasourcesForTab,
        disconnect,
        fetchDashboards,
        fetchDatasources,
        fetchLogs,
        fetchMetrics,
        fetchServices,
        fetchState,
        fetchTraces,
        h,
        initialChat,
        initialPieces,
        markFailed,
        markLoading,
        markSettled,
        messageOf,
        pieceKeyOf,
        React,
        reasonText,
        readDatasources,
        readKeyword,
        readRange,
        readService,
        readTab,
        saveConfig,
        supportsCapabilities,
        writeDatasource,
        writeKeyword,
        writeRange,
        writeService,
        writeTab,
      } = runtime;

      /** The unloaded piece a tab shows before its first load. */
      const IDLE_PIECE = { phase: 'idle', data: null, detail: '' };

      /** The piece one tab renders, or the idle placeholder for an unknown tab. */
      function activePiece(pieces, tab) {
        const key = pieceKeyOf(tab);
        const found = key === undefined ? undefined : pieces[key];
        return found ?? IDLE_PIECE;
      }

      /**
       * A locale lookup that cannot take the page down: a deployment without the
       * dictionary still renders keys instead of throwing on the first label.
       */
      function localeOf(props) {
        const t = props !== null && props !== undefined ? props.t : undefined;
        if (typeof t === 'function') return t;
        return (key) => String(key);
      }

      /**
       * The panel's own error surface. Without it a render error leaves an empty
       * white panel with the reason only in the browser console; with it the page
       * says what broke, and the Host keeps a record of it.
       */
      class PanelBoundary extends React.Component {
        constructor(props) {
          super(props);
          this.state = { error: null };
        }

        static getDerivedStateFromError(error) {
          return { error };
        }

        componentDidCatch(error, info) {
          if (typeof runtime.report === 'function') {
            runtime.report(
              'panel.crash',
              error instanceof Error ? error.message : String(error),
              `${error instanceof Error ? String(error.stack ?? '') : ''}\n${String(info && info.componentStack ? info.componentStack : '')}`.slice(0, 3000),
            );
          }
        }

        render() {
          if (this.state.error === null) return this.props.children;
          const message = this.state.error instanceof Error ? this.state.error.message : String(this.state.error);
          return h(
            'div',
            { className: 'dp-fail', role: 'alert' },
            h('h1', null, '页面渲染失败 / the panel failed to render'),
            h('p', null, '把下面的信息发给我即可定位。 / Send the text below to fix it.'),
            h('code', null, message),
          );
        }
      }

      function Panel(props) {
        const t = localeOf(props);
        const report = typeof runtime.report === 'function' ? runtime.report : () => {};

        const [boot, setBoot] = React.useState({ phase: 'loading', detail: '' });
        const [view, setView] = React.useState({
          config: DEFAULT_CONFIG,
          connection: IDLE_CONNECTION,
          services: [],
          servicesLabel: '',
          datasources: [],
          datasourceDefaults: { monitor: '', logs: '', traces: '' },
          file: '',
          capabilities: [],
        });
        const [tab, setTab] = React.useState(() => readTab());
        const [service, setService] = React.useState(() => readService());
        const [range, setRange] = React.useState(() => readRange());
        const [keyword, setKeyword] = React.useState(() => readKeyword());
        const [keywordDraft, setKeywordDraft] = React.useState(keyword);
        const [chosen, setChosen] = React.useState(() => readDatasources());
        const [drawer, setDrawer] = React.useState(false);
        const [pieces, setPieces] = React.useState(initialPieces);
        const [chat, setChat] = React.useState(initialChat);
        const [draft, setDraft] = React.useState('');
        const [busyChat, setBusyChat] = React.useState(false);
        const [busy, setBusy] = React.useState({ saving: false, connecting: false, disconnecting: false });
        const [drawerError, setDrawerError] = React.useState('');
        const [flash, setFlash] = React.useState('');
        const [tick, setTick] = React.useState(0);

        const alive = React.useRef(true);
        const seq = React.useRef(0);
        const loaded = React.useRef(false);
        const flashTimer = React.useRef(null);

        /* One heartbeat per mount, with the size the page actually got: a 0x0 box
           is the difference between "never mounted" and "mounted but invisible". */
        React.useEffect(() => {
          const frame =
            typeof requestAnimationFrame === 'function'
              ? requestAnimationFrame(() => {
                  const node = document.querySelector('.dp-page');
                  const rect = node === null ? null : node.getBoundingClientRect();
                  report('panel.mount', 'panel mounted', `tab=${tab} service=${service || '-'} range=${range}`, {
                    w: rect === null ? 0 : Math.round(rect.width),
                    h: rect === null ? 0 : Math.round(rect.height),
                    dpr: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
                    tab,
                    phase: 'mount',
                  });
                })
              : null;
          return () => {
            if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
          };
          // Mount only: later renders are reported through boot/phase below.
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, []);

        React.useEffect(() => {
          if (boot.phase === 'loading') return;
          report('panel.boot', boot.phase, boot.detail);
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [boot.phase, boot.detail]);

        React.useEffect(
          () => () => {
            alive.current = false;
            if (flashTimer.current !== null) clearTimeout(flashTimer.current);
          },
          [],
        );

        const showFlash = React.useCallback((text) => {
          setFlash(text);
          if (flashTimer.current !== null) clearTimeout(flashTimer.current);
          flashTimer.current = setTimeout(() => {
            flashTimer.current = null;
            if (alive.current) setFlash('');
          }, 2400);
        }, []);

        /* ---------- Host state ---------- */

        /** Read the settings, connection, and service list from the Host. */
        const refreshState = React.useCallback(async (first) => {
          try {
            const state = await fetchState();
            if (!alive.current) return;
            setView(state);
            if (first === true && !loaded.current) {
              loaded.current = true;
              if (state.config.service !== '') {
                setService(state.config.service);
                writeService(state.config.service);
              }
              if (state.config.range !== '') {
                setRange(state.config.range);
                writeRange(state.config.range);
              }
            }
            if (!supportsCapabilities(state.capabilities)) {
              setBoot({ phase: 'error', detail: 'capabilities' });
              return;
            }
            setBoot({ phase: 'ready', detail: '' });
          } catch (error) {
            if (!alive.current) return;
            setBoot((previous) => (previous.phase === 'ready' ? previous : { phase: 'error', detail: messageOf(error) }));
          }
        }, []);

        React.useEffect(() => {
          void refreshState(true);
        }, [refreshState]);

        /* Keep the pill honest while the page stays open; cheap, no MCP traffic. */
        React.useEffect(() => {
          const timer = setInterval(() => {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            void refreshState(false);
          }, 15000);
          return () => clearInterval(timer);
        }, [refreshState]);

        /* The datasource menu fills itself once the session is up. */
        React.useEffect(() => {
          if (view.connection.status !== 'connected' || view.datasources.length > 0) return undefined;
          let cancelled = false;
          void (async () => {
            try {
              const result = await fetchDatasources();
              if (cancelled || !alive.current || !result.ok) return;
              setView((previous) => ({
                ...previous,
                datasources: result.datasources,
                datasourceDefaults: result.defaults,
              }));
            } catch (error) {
              /* the menu stays hidden; the Host still resolves a datasource */
            }
          })();
          return () => {
            cancelled = true;
          };
        }, [view.connection.status, view.datasources.length]);

        /* The datasources this view offers, and the one it is querying. */
        const pickDatasource = (viewKey) => {
          const options = datasourcesForTab(view.datasources, viewKey);
          const wanted = chosen[viewKey];
          if (typeof wanted === 'string' && options.some((entry) => entry.uid === wanted)) return wanted;
          const preferred = view.datasourceDefaults[viewKey];
          if (typeof preferred === 'string' && options.some((entry) => entry.uid === preferred)) return preferred;
          return options.length > 0 ? options[0].uid : '';
        };
        const datasourceOptions = datasourcesForTab(view.datasources, tab);
        const datasource = pickDatasource(tab);
        /* The service filter reads Loki's label values, so it follows the logs
           view's datasource rather than the tab in front of it. */
        const logsDatasource = pickDatasource('logs');

        /*
         * The service menu is the datasource's `service_name` label values over
         * the page's own window, read through the MCP label-values tool. It is
         * refetched when the connection, the logs datasource, the range, or the
         * refresh action changes — never from a hard-coded list.
         */
        const servicesKey = `${view.connection.status}|${logsDatasource}|${range}|${tick}`;
        const servicesFetched = React.useRef('');
        React.useEffect(() => {
          if (view.connection.status !== 'connected') return undefined;
          if (servicesFetched.current === servicesKey) return undefined;
          servicesFetched.current = servicesKey;
          let cancelled = false;
          void (async () => {
            try {
              const result = await fetchServices(true, logsDatasource, range);
              if (cancelled || !alive.current || !result.ok) return;
              setView((previous) => ({ ...previous, services: result.services, servicesLabel: result.label }));
            } catch (error) {
              /* retry on the next key change */
              servicesFetched.current = '';
            }
          })();
          return () => {
            cancelled = true;
          };
        }, [servicesKey, logsDatasource, range, view.connection.status]);

        /* One load per view switch, filter change, refresh, or reconnect. */
        const loadPiece = React.useCallback(
          async (kind) => {
            const token = ++seq.current;
            setPieces((previous) => markLoading(previous, kind));
            try {
              let data;
              if (kind === 'metrics') data = await fetchMetrics(service, range, datasource);
              else if (kind === 'logs') data = await fetchLogs(service, range, 60, datasource, keyword);
              else if (kind === 'dashboards') data = await fetchDashboards('');
              else data = await fetchTraces(service, range, 40, datasource);
              if (!alive.current || token !== seq.current) return;
              setPieces((previous) => markSettled(previous, kind, data, ''));
            } catch (error) {
              if (!alive.current || token !== seq.current) return;
              setPieces((previous) => markFailed(previous, kind, messageOf(error)));
            }
          },
          [service, range, datasource, keyword],
        );

        React.useEffect(() => {
          if (boot.phase !== 'ready') return;
          const kind = pieceKeyOf(tab);
          if (kind === undefined) return;
          void loadPiece(kind);
        }, [boot.phase, tab, service, range, datasource, keyword, tick, view.connection.status, loadPiece]);

        /* Escape closes the drawer, like any other panel. */
        React.useEffect(() => {
          if (!drawer) return undefined;
          const onKey = (event) => {
            if (event.key !== 'Escape') return;
            setDrawer(false);
            setDrawerError('');
          };
          window.addEventListener('keydown', onKey);
          return () => window.removeEventListener('keydown', onKey);
        }, [drawer]);

        /* ---------- actions ---------- */

        const selectTab = (next) => {
          if (!TABS.includes(next)) return;
          setTab(next);
          writeTab(next);
        };

        const selectService = (next) => {
          setService(next);
          writeService(next);
        };

        const selectRange = (next) => {
          setRange(next);
          writeRange(next);
        };

        /** Pick a datasource for this view; it is remembered per view. */
        const selectDatasource = (uid) => {
          setChosen((previous) => ({ ...previous, [tab]: uid }));
          writeDatasource(tab, uid);
        };

        /** Apply the log keyword; Enter (or the refresh action) is the trigger. */
        const applyKeyword = () => {
          const next = keywordDraft.trim();
          setKeyword(next);
          writeKeyword(next);
          setTick((value) => value + 1);
        };

        const refresh = () => {
          setTick((value) => value + 1);
          void refreshState(false);
        };

        const openDrawer = () => {
          setDrawer(true);
          setDrawerError('');
        };

        /** Save the drawer's draft; `connect` also dials the endpoint. */
        const saveDraft = async (payload) => {
          setDrawerError('');
          setBusy({ saving: true, connecting: payload.connect === true, disconnecting: false });
          try {
            const state = await saveConfig(payload);
            if (!alive.current) return;
            setView(state);
            showFlash(t('mcp.saved'));
            setTick((value) => value + 1);
            if (state.connection.status === 'error') setDrawerError(state.connection.error);
          } catch (error) {
            if (alive.current) setDrawerError(messageOf(error));
          } finally {
            if (alive.current) setBusy({ saving: false, connecting: false, disconnecting: false });
          }
        };

        const disconnectNow = async () => {
          setDrawerError('');
          setBusy({ saving: false, connecting: false, disconnecting: true });
          try {
            const state = await disconnect();
            if (!alive.current) return;
            setView(state);
            setTick((value) => value + 1);
          } catch (error) {
            if (alive.current) setDrawerError(messageOf(error));
          } finally {
            if (alive.current) setBusy({ saving: false, connecting: false, disconnecting: false });
          }
        };

        /** One chat turn: transcript first, then the Host answer. */
        const sendQuestion = async () => {
          const question = draft.trim();
          if (question === '' || busyChat || tab === 'monitor') return;
          const key = chatKeyOf(tab);
          const history = chatHistory(chat[key]);
          setChat((previous) => appendChat(previous, key, chatMessage('user', question)));
          setDraft('');
          setBusyChat(true);
          try {
            const answer = await ask({ question, tab: key, service, range, datasource, history });
            if (!alive.current) return;
            if (answer.ok !== true) {
              setChat((previous) =>
                appendChat(
                  previous,
                  key,
                  chatMessage('assistant', `${reasonText(t, answer.reason || 'error')}${answer.note === '' ? '' : `\n${answer.note}`}`, {
                    tone: 'error',
                  }),
                ),
              );
              return;
            }
            setChat((previous) =>
              appendChat(
                previous,
                key,
                chatMessage('assistant', answer.answer, {
                  calls: answer.calls,
                  note: answer.degraded ? t('status.noModel') : '',
                }),
              ),
            );
            /* The rows the model fetched replace the list, so both agree. */
            if (key === 'logs' && answer.logs !== null && answer.logs.ok === true) {
              setPieces((previous) => markSettled(previous, 'logs', answer.logs, ''));
            }
            if (key === 'traces' && answer.traces !== null && answer.traces.ok === true) {
              setPieces((previous) => markSettled(previous, 'traces', answer.traces, ''));
            }
            /* A dashboard was created or updated: reload the list so it shows. */
            if (key === 'dashboards' && answer.mutated === true) {
              showFlash(t('dashboards.reloaded'));
              setTick((value) => value + 1);
            }
          } catch (error) {
            if (!alive.current) return;
            setChat((previous) => appendChat(previous, key, chatMessage('assistant', messageOf(error), { tone: 'error' })));
          } finally {
            if (alive.current) setBusyChat(false);
          }
        };

        const clearChat = () => setChat((previous) => ({ ...previous, [chatKeyOf(tab)]: [] }));

        /* ---------- render ---------- */

        const active = activePiece(pieces, tab);
        const connectAction = () => {
          openDrawer();
        };

        return h(
          'div',
          { className: 'dp-page' },
          h(
            'header',
            { className: 'dp-header' },
            h('h1', { className: 'dp-title' }, t('title')),
            h(Tabs, { t, tab, onSelect: selectTab }),
            h(
              'div',
              { className: 'dp-headActions' },
              h(ConnectionPill, {
                t,
                connection: view.connection,
                open: drawer,
                onToggle: () => (drawer ? setDrawer(false) : openDrawer()),
              }),
              h(
                'button',
                { type: 'button', className: 'dp-btn', onClick: refresh, title: t('filter.refresh') },
                h(IconRefresh, { size: 13 }),
                t('filter.refresh'),
              ),
            ),
          ),
          h(
            'div',
            { className: 'dp-toolbar' },
            /* Datasource → range → service → (logs only) keyword. The datasource
               comes first because every query is scoped to it. The dashboards
               view lists Grafana objects, so only the datasource matters there:
               it is what a created panel points at. */
            h(DatasourceSelect, { t, value: datasource, options: datasourceOptions, onChange: selectDatasource }),
            tab === 'dashboards' ? null : h(RangeSelect, { t, value: range, onChange: selectRange }),
            tab === 'dashboards'
              ? null
              : h(ServiceSelect, { t, value: service, services: view.services, onChange: selectService }),
            tab === 'logs'
              ? h(KeywordInput, {
                  t,
                  value: keywordDraft,
                  onChange: setKeywordDraft,
                  onSubmit: applyKeyword,
                })
              : null,
            h('span', { className: 'dp-spacer' }),
            boot.phase === 'loading' ? h('span', { className: 'dp-note' }, t('common.loading')) : null,
            flash === '' ? null : h('span', { className: 'dp-note' }, flash),
          ),
          h(
            'div',
            { className: 'dp-body' },
            h(
              'div',
              { className: 'dp-scroll' },
              h(
                'div',
                { className: 'dp-content' },
                boot.phase === 'error'
                  ? h(StatusNote, {
                      tone: 'error',
                      text: t('status.error'),
                      detail: boot.detail === 'capabilities' ? 'this Host build is older than the page bundle' : boot.detail,
                      action: h(
                        'button',
                        { type: 'button', className: 'dp-btn', onClick: () => void refreshState(true) },
                        t('status.retry'),
                      ),
                    })
                  : null,
                tab === 'dashboards'
                  ? h(DashboardList, { t, piece: active, onConnect: connectAction, onRetry: refresh })
                  : tab === 'monitor'
                    ? h(MonitorView, { t, piece: active, onConnect: connectAction, onRetry: refresh })
                    : tab === 'logs'
                      ? h(LogList, { t, piece: active, onConnect: connectAction, onRetry: refresh })
                      : h(TraceList, { t, piece: active, onConnect: connectAction, onRetry: refresh }),
              ),
            ),
            tab === 'monitor'
              ? null
              : h(ChatPanel, {
                  t,
                  tab,
                  entries: chat[chatKeyOf(tab)],
                  busy: busyChat,
                  connection: view.connection,
                  draft,
                  onChangeDraft: setDraft,
                  onSend: () => void sendQuestion(),
                  onClear: clearChat,
                  placeholder: tab === 'dashboards' ? t('chat.dashboardsPlaceholder') : '',
                  hint: tab === 'dashboards' ? t('chat.dashboardsHint') : '',
                }),
          ),
          drawer
            ? h(McpDrawer, {
                t,
                config: view.config,
                connection: view.connection,
                busy,
                error: drawerError,
                onClose: () => {
                  setDrawer(false);
                  setDrawerError('');
                },
                onSave: (payload) => void saveDraft(payload),
                onDisconnect: () => void disconnectNow(),
              })
            : null,
        );
      }

      return { Page: (props) => h(PanelBoundary, null, h(Panel, props)), Panel };
    };
  },
});
