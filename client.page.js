/**
 * The page: header (title, tabs, history + add), the active tab's own list, and
 * the history drawer. All Host traffic goes through `load` / `enqueue`, which
 * keep the local state optimistic while a write is in flight and ordered so a
 * later state always wins.
 */
window.__ModuleLoader__.load({
  id: 'my-deploy',
  chunk: 'client.page.js',
  factory() {
    return (runtime) => {
      const {
        CONFIRM_MS,
        FLASH_MS,
        HistoryPane,
        IconHistory,
        React,
        RowForm,
        TAB_DEFS,
        TABS,
        applyOrder,
        copyText,
        copyValue,
        countHidden,
        emptyState,
        fetchState,
        h,
        historyOf,
        markHidden,
        messageOf,
        pushState,
        readCache,
        readTab,
        removeItems,
        supportsCapabilities,
        updateItem,
        visibleOf,
        writeCache,
        writeTab,
      } = runtime;

      function Page(props) {
        const { t } = props;
        const [state, setState] = React.useState(() => readCache() ?? emptyState());
        const [tab, setTab] = React.useState(() => readTab(TABS));
        const [formOpen, setFormOpen] = React.useState(false);
        const [editingId, setEditingId] = React.useState(null);
        const [flash, setFlash] = React.useState(null);
        const [historyOpen, setHistoryOpen] = React.useState(false);
        const [selected, setSelected] = React.useState([]);
        const [confirmClear, setConfirmClear] = React.useState(false);
        const [phase, setPhase] = React.useState('loading');
        const [detail, setDetail] = React.useState('');
        const [file, setFile] = React.useState('');

        const alive = React.useRef(true);
        const latest = React.useRef(state);
        const loaded = React.useRef(false);
        const writes = React.useRef(0);
        const sends = React.useRef(Promise.resolve());
        const flashTimer = React.useRef(null);
        const confirmTimer = React.useRef(null);
        const phaseRef = React.useRef(phase);
        phaseRef.current = phase;
        const tabRefs = React.useRef([]);

        React.useEffect(
          () => () => {
            alive.current = false;
            if (flashTimer.current !== null) clearTimeout(flashTimer.current);
            if (confirmTimer.current !== null) clearTimeout(confirmTimer.current);
          },
          [],
        );

        /** Adopt Host truth locally: state, mirror cache, and the ref used by writers. */
        const adopt = React.useCallback((next) => {
          latest.current = next;
          writeCache(next);
          if (alive.current) setState(next);
        }, []);

        const load = React.useCallback(async () => {
          if (!loaded.current && alive.current) setPhase('loading');
          try {
            const result = await fetchState();
            loaded.current = true;
            adopt(result.state);
            if (!alive.current) return;
            setFile(result.file);
            if (!supportsCapabilities(result.capabilities)) {
              setPhase('error');
              setDetail('host-too-old');
              return;
            }
            setPhase('ready');
            setDetail('');
          } catch (error) {
            if (!alive.current) return;
            setPhase('error');
            setDetail(messageOf(error));
          }
        }, [adopt]);

        React.useEffect(() => {
          void load();
        }, [load]);

        /** One write attempt: never rejects, so the send chain stays usable. */
        const attempt = React.useCallback(
          async (next) => {
            writes.current += 1;
            if (alive.current) setPhase('saving');
            try {
              const result = await pushState(next);
              if (!alive.current) return;
              if (result.file !== '') setFile(result.file);
              // A Host that cannot keep `hidden` resurrects deleted rows on echo: keep
              // the local state and say why, instead of silently undoing the action.
              if (!supportsCapabilities(result.capabilities) || countHidden(result.state) < countHidden(next)) {
                setPhase('error');
                setDetail('host-too-old');
                return;
              }
              if (latest.current === next) adopt(result.state);
              if (writes.current === 1) {
                setPhase('ready');
                setDetail('');
              }
            } catch (error) {
              if (!alive.current) return;
              setPhase('error');
              setDetail(messageOf(error));
            } finally {
              writes.current -= 1;
            }
          },
          [adopt],
        );

        /** Ordered, superseding writes: a later state always wins on the Host. */
        const enqueue = React.useCallback(
          (next) => {
            sends.current = sends.current.then(
              () => attempt(next),
              () => attempt(next),
            );
          },
          [attempt],
        );

        const commit = (next) => {
          adopt(next);
          enqueue(next);
        };

        const retry = () => {
          if (loaded.current) enqueue(latest.current);
          else void load();
        };

        // Another tab or a hand-edited file: refresh on focus, but never while a
        // local write is still on its way to the Host.
        React.useEffect(() => {
          const onFocus = () => {
            if (!alive.current) return;
            if (writes.current > 0 || phaseRef.current === 'saving') return;
            void load();
          };
          window.addEventListener('focus', onFocus);
          return () => window.removeEventListener('focus', onFocus);
        }, [load]);

        // Escape closes the history drawer, like any other panel.
        React.useEffect(() => {
          if (!historyOpen) return undefined;
          const onKey = (event) => {
            if (event.key !== 'Escape') return;
            setHistoryOpen(false);
            setSelected([]);
            setConfirmClear(false);
          };
          window.addEventListener('keydown', onKey);
          return () => window.removeEventListener('keydown', onKey);
        }, [historyOpen]);

        const showFlash = (id, ok) => {
          setFlash({ id, ok });
          if (flashTimer.current !== null) clearTimeout(flashTimer.current);
          flashTimer.current = setTimeout(() => {
            flashTimer.current = null;
            if (alive.current) setFlash(null);
          }, FLASH_MS);
        };

        const armConfirm = () => {
          setConfirmClear(true);
          if (confirmTimer.current !== null) clearTimeout(confirmTimer.current);
          confirmTimer.current = setTimeout(() => {
            confirmTimer.current = null;
            if (alive.current) setConfirmClear(false);
          }, CONFIRM_MS);
        };

        const closeHistory = () => {
          setHistoryOpen(false);
          setSelected([]);
          setConfirmClear(false);
          if (confirmTimer.current !== null) clearTimeout(confirmTimer.current);
        };

        const selectTab = (next) => {
          setFormOpen(false);
          setEditingId(null);
          setFlash(null);
          if (tab === next) return;
          setTab(next);
          writeTab(next);
        };

        const onTabKeyDown = (event, index) => {
          let next;
          switch (event.key) {
            case 'ArrowLeft':
              next = (index + TABS.length - 1) % TABS.length;
              break;
            case 'ArrowRight':
              next = (index + 1) % TABS.length;
              break;
            case 'Home':
              next = 0;
              break;
            case 'End':
              next = TABS.length - 1;
              break;
            default:
              return;
          }
          event.preventDefault();
          const target = tabRefs.current[next];
          if (target) target.focus();
          selectTab(TABS[next]);
        };

        const items = visibleOf(state, tab);
        const entries = historyOf(state);

        const addItem = (item) => {
          commit({ ...state, [tab]: [...state[tab], item] });
          setFormOpen(false);
        };

        const saveItem = (id, patch) => {
          commit(updateItem(state, id, patch));
          setEditingId(null);
        };

        /** Deleting hides: the row keeps its place in the file as history. */
        const hideItem = (id) => {
          commit(markHidden(state, [id], true));
          if (editingId === id) setEditingId(null);
        };

        const purgeItem = (id) => {
          commit(removeItems(state, [id]));
          setSelected((previous) => previous.filter((value) => value !== id));
          if (editingId === id) setEditingId(null);
        };

        const toggleItem = (id) => {
          commit({ ...state, todo: state.todo.map((item) => (item.id === id ? { ...item, done: item.done !== true } : item)) });
        };

        const copyItem = async (kind, item) => {
          const ok = await copyText(copyValue(kind, item));
          showFlash(item.id, ok);
        };

        const toggleSelect = (id) => {
          setSelected((previous) => (previous.includes(id) ? previous.filter((value) => value !== id) : [...previous, id]));
        };

        const restoreSelected = () => {
          commit(markHidden(state, selected, false));
          setSelected([]);
        };

        const purgeSelected = () => {
          commit(removeItems(state, selected));
          setSelected([]);
        };

        const clearAllHistory = () => {
          if (!confirmClear) {
            armConfirm();
            return;
          }
          setConfirmClear(false);
          if (confirmTimer.current !== null) clearTimeout(confirmTimer.current);
          commit(removeItems(state, entries.map((entry) => entry.item.id)));
          setSelected([]);
          setEditingId(null);
        };

        /** A list reports its new visible order; the rest of the tab keeps its slots. */
        const reorderTab = (orderedIds) => {
          commit(applyOrder(state, tab, orderedIds));
        };

        const def = TAB_DEFS.find((entry) => entry.id === tab) ?? TAB_DEFS[0];
        const showList = phase === 'ready' || phase === 'error';
        const selectedTabIndex = Math.max(0, TABS.indexOf(def.id));

        return h(
          'div',
          { className: 'mn-page' },
          h(
            'div',
            { className: 'mn-scroll' },
            h(
              'div',
              { className: 'mn-content' },
              h(
                'div',
                { className: 'mn-heading' },
                h('h1', null, t('title')),
                h(
                  'div',
                  { className: 'mn-tabs', role: 'tablist', 'aria-label': t('tabs.label') },
                  h('span', {
                    className: 'mn-tabIndicator',
                    'aria-hidden': 'true',
                    style: {
                      width: `calc((100% - 8px) / ${TABS.length})`,
                      transform: `translateX(${selectedTabIndex * 100}%)`,
                    },
                  }),
                  TAB_DEFS.map((entry, index) =>
                    h(
                      'button',
                      {
                        key: entry.id,
                        ref: (node) => {
                          tabRefs.current[index] = node;
                        },
                        type: 'button',
                        role: 'tab',
                        className: 'mn-tab',
                        'aria-selected': def.id === entry.id,
                        tabIndex: def.id === entry.id ? 0 : -1,
                        onClick: () => selectTab(entry.id),
                        onKeyDown: (event) => onTabKeyDown(event, index),
                      },
                      t(entry.label),
                    ),
                  ),
                ),
                h(
                  'div',
                  { className: 'mn-headActions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'mn-secondary',
                      'aria-expanded': historyOpen,
                      onClick: () => {
                        if (historyOpen) closeHistory();
                        else setHistoryOpen(true);
                      },
                    },
                    h(IconHistory, {}),
                    t('history'),
                    entries.length === 0 ? null : h('span', { className: 'mn-badge' }, String(entries.length)),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'mn-add',
                      'aria-expanded': formOpen,
                      onClick: () => {
                        setEditingId(null);
                        setFormOpen((open) => !open);
                      },
                    },
                    h('span', { className: 'mn-addPlus', 'aria-hidden': 'true' }, '+'),
                    t('add'),
                  ),
                ),
              ),
              phase === 'loading' ? h('div', { className: 'mn-note', role: 'status' }, t('status.loading')) : null,
              phase === 'saving' ? h('div', { className: 'mn-note', role: 'status' }, t('status.saving')) : null,
              phase === 'error'
                ? h(
                    'div',
                    { className: 'mn-status', 'data-tone': 'error', role: 'alert' },
                    h(
                      'span',
                      { className: 'mn-statusText' },
                      t('status.error'),
                      detail === ''
                        ? null
                        : h(
                            'span',
                            { className: 'mn-statusDetail' },
                            detail === 'unauthenticated'
                              ? t('status.auth')
                              : detail === 'host-too-old'
                                ? t('status.hostOld')
                                : detail,
                          ),
                      h('span', { className: 'mn-statusDetail' }, t('storage.cache')),
                    ),
                    detail === 'host-too-old'
                      ? null
                      : h('button', { type: 'button', className: 'mn-retry', onClick: retry }, t('retry')),
                  )
                : null,
              formOpen
                ? h(RowForm, {
                    tab: def.id,
                    t,
                    item: null,
                    submitLabel: t('create'),
                    onSubmit: addItem,
                    onCancel: () => setFormOpen(false),
                  })
                : null,
              showList
                ? h(def.List, {
                    key: def.id,
                    tab: def.id,
                    t,
                    items,
                    editingId,
                    flash,
                    onEdit: setEditingId,
                    onCopy: copyItem,
                    onHide: hideItem,
                    onToggle: toggleItem,
                    onSave: saveItem,
                    onCancelEdit: () => setEditingId(null),
                    onOrder: reorderTab,
                  })
                : null,
              file === ''
                ? null
                : h(
                    'div',
                    { className: 'mn-foot' },
                    h('span', null, t('storage.file')),
                    h('span', { className: 'mn-footPath' }, file),
                  ),
            ),
          ),
          historyOpen
            ? h(HistoryPane, {
                t,
                entries,
                selected,
                confirmClear,
                editingId,
                flash,
                onToggleSelect: toggleSelect,
                onEdit: setEditingId,
                onCopy: copyItem,
                onSave: saveItem,
                onCancelEdit: () => setEditingId(null),
                onPurge: purgeItem,
                onRestoreSelected: restoreSelected,
                onPurgeSelected: purgeSelected,
                onClearAll: clearAllHistory,
                onClose: closeHistory,
              })
            : null,
        );
      }

      return { Page };
    };
  },
});
