/**
 * Everything the page draws: the icons, the drag-to-reorder plumbing, the shared
 * form and row actions, one list component per tab, the history drawer, and the
 * tab registry that binds an id to its list.
 *
 * Adding a tab means adding one entry to `TAB_DEFS` (plus a list component); no
 * caller switches on a tab id.
 */
window.__ModuleLoader__.load({
  id: 'my-deploy',
  chunk: 'client.ui.js',
  factory() {
    return (runtime) => {
      const { React, copyActionLabel, formatStamp, h, isComposing, labelOf, moveBefore, moveStep, payloadFor } = runtime;

      /* ---------- icons ---------- */

      /** Sidebar glyph: a compass rose at the size the sidebar allocates. */
      function PanelIcon(props) {
        const size = typeof props.size === 'number' ? props.size : 16;
        return h(
          'svg',
          { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
          h('circle', { cx: 8, cy: 8, r: 6.1, stroke: 'currentColor', strokeWidth: 1.3 }),
          h('path', { d: 'M10.6 5.4 9.2 9.2 5.4 10.6 6.8 6.8Z', fill: 'currentColor' }),
        );
      }

      function IconEdit(props) {
        const size = typeof props.size === 'number' ? props.size : 14;
        return h(
          'svg',
          { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
          h('path', {
            d: 'M11.1 2.4a1.7 1.7 0 0 1 2.4 2.4L5.7 12.6 2.4 13.6l1-3.3Z',
            stroke: 'currentColor',
            strokeWidth: 1.3,
            strokeLinejoin: 'round',
          }),
        );
      }

      function IconCopy(props) {
        const size = typeof props.size === 'number' ? props.size : 14;
        return h(
          'svg',
          { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
          h('rect', { x: 5.7, y: 5.7, width: 7.6, height: 7.6, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.3 }),
          h('path', {
            d: 'M10.3 5.7V4.4a1.6 1.6 0 0 0-1.6-1.6H4.4a1.6 1.6 0 0 0-1.6 1.6v4.3a1.6 1.6 0 0 0 1.6 1.6h1.3',
            stroke: 'currentColor',
            strokeWidth: 1.3,
            strokeLinecap: 'round',
          }),
        );
      }

      function IconHistory(props) {
        const size = typeof props.size === 'number' ? props.size : 14;
        return h(
          'svg',
          { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
          h('path', { d: 'M2.7 8a5.3 5.3 0 1 0 1.5-3.7', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
          h('path', {
            d: 'M2.4 2.7v2.4h2.4',
            stroke: 'currentColor',
            strokeWidth: 1.3,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
          h('path', { d: 'M8 5.3V8.2l2.1 1.2', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        );
      }

      /* ---------- drag to reorder ---------- */

      /** The grip every sortable row shows. */
      function DragHandle(props) {
        return h(
          'span',
          {
            className: 'mn-drag',
            role: 'button',
            tabIndex: 0,
            draggable: true,
            'aria-label': props.label,
            title: props.label,
            ...props.handlers,
          },
          '\u283f',
        );
      }

      /**
       * Wire one list's drag state: the handle is the only draggable element (so a
       * link stays clickable and text stays selectable), and each row accepts the
       * drop. Alt+ArrowUp/Down on the handle is the keyboard equivalent.
       */
      function useDragSort(onReorder, onMove) {
        const [dragging, setDragging] = React.useState(null);
        const [over, setOver] = React.useState(null);

        const handleProps = (id) => ({
          draggable: true,
          onDragStart: (event) => {
            setDragging(id);
            if (event.dataTransfer) {
              event.dataTransfer.effectAllowed = 'move';
              try {
                event.dataTransfer.setData('text/plain', id);
              } catch (error) {
                /* some engines require a prior selection; the state above still works */
              }
            }
          },
          onDragEnd: () => {
            setDragging(null);
            setOver(null);
          },
          onKeyDown: (event) => {
            if (!event.altKey) return;
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            event.preventDefault();
            onMove(id, event.key === 'ArrowUp' ? -1 : 1);
          },
        });

        const rowProps = (id) => ({
          'data-dragging': dragging === id ? 'true' : 'false',
          'data-over': over === id && dragging !== null && dragging !== id ? 'true' : 'false',
          onDragOver: (event) => {
            if (dragging === null || dragging === id) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
            if (over !== id) setOver(id);
          },
          onDragLeave: (event) => {
            const next = event.relatedTarget;
            if (next !== null && next !== undefined && event.currentTarget.contains(next)) return;
            if (over === id) setOver(null);
          },
          onDrop: (event) => {
            event.preventDefault();
            const source = dragging;
            setDragging(null);
            setOver(null);
            if (source !== null && source !== id) onReorder(source, id);
          },
        });

        return { dragging, handleProps, over, rowProps };
      }

      /**
       * Bind one list to its own displayed order: a drop or a keyboard move becomes
       * the next id order, which the page then applies to the state.
       */
      function useSortable(items, onOrder) {
        const ids = items.map((item) => item.id);
        return useDragSort(
          (sourceId, targetId) => {
            const next = moveBefore(ids, sourceId, targetId);
            if (next !== null) onOrder(next);
          },
          (id, delta) => {
            const next = moveStep(ids, id, delta);
            if (next !== null) onOrder(next);
          },
        );
      }

      /* ---------- shared row pieces ---------- */

      /**
       * One form for creating (`item === null`) and editing a row. Enter submits,
       * Escape cancels, a note needs Ctrl/Cmd + Enter, and an Enter that belongs to
       * an IME composition never submits.
       */
      function RowForm(props) {
        const { tab, t, item, submitLabel, onSubmit, onCancel } = props;
        const created = item === null || item === undefined;
        const isNav = tab === 'nav';

        const [title, setTitle] = React.useState(isNav && !created ? item.title : '');
        const [url, setUrl] = React.useState(isNav && !created ? item.url : '');
        const [text, setText] = React.useState(isNav || created ? '' : item.text);
        const firstRef = React.useRef(null);

        React.useEffect(() => {
          if (firstRef.current !== null) firstRef.current.focus();
        }, []);

        const draft = { title, url, text };
        const ready = payloadFor(tab, draft, created ? null : item) !== null;

        const submit = () => {
          const payload = payloadFor(tab, draft, created ? null : item);
          if (payload === null) return;
          onSubmit(payload);
        };

        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onCancel();
            return;
          }
          if (event.key !== 'Enter' || isComposing(event)) return;
          if (tab === 'note') {
            if (event.ctrlKey || event.metaKey) {
              event.preventDefault();
              submit();
            }
            return;
          }
          event.preventDefault();
          submit();
        };

        const field = { onKeyDown };
        const fields = isNav
          ? [
              h('input', {
                key: 'title',
                ref: firstRef,
                className: 'mn-field',
                type: 'text',
                value: title,
                placeholder: t('placeholder.title'),
                'aria-label': t('form.title'),
                autoComplete: 'off',
                spellCheck: false,
                onChange: (event) => setTitle(event.target.value),
                ...field,
              }),
              h('input', {
                key: 'url',
                className: 'mn-field',
                type: 'url',
                value: url,
                placeholder: t('placeholder.url'),
                'aria-label': t('form.url'),
                autoComplete: 'off',
                spellCheck: false,
                onChange: (event) => setUrl(event.target.value),
                ...field,
              }),
            ]
          : [
              tab === 'note'
                ? h('textarea', {
                    key: 'text',
                    ref: firstRef,
                    className: 'mn-field mn-fieldText',
                    value: text,
                    placeholder: t('placeholder.note'),
                    'aria-label': t('form.note'),
                    rows: 3,
                    spellCheck: false,
                    onChange: (event) => setText(event.target.value),
                    ...field,
                  })
                : h('input', {
                    key: 'text',
                    ref: firstRef,
                    className: 'mn-field',
                    type: 'text',
                    value: text,
                    placeholder: t('placeholder.todo'),
                    'aria-label': t('form.todo'),
                    autoComplete: 'off',
                    spellCheck: false,
                    onChange: (event) => setText(event.target.value),
                    ...field,
                  }),
            ];

        return h(
          'div',
          { className: created ? 'mn-form' : 'mn-editFields' },
          created ? [h('div', { className: 'mn-formRow', key: 'fields' }, fields)] : fields,
          h(
            'div',
            { className: created ? 'mn-formActions' : 'mn-editActions' },
            h('button', { type: 'button', className: 'mn-ghost', onClick: onCancel }, t('cancel')),
            h('button', { type: 'button', className: 'mn-primary', disabled: !ready, onClick: submit }, submitLabel),
          ),
        );
      }

      /**
       * The copy / edit / delete controls a row shows. The wording comes from the
       * caller (hide vs purge) while the behavior comes from `onDelete`.
       */
      function RowActions(props) {
        const { kind, item, t, flash, onEdit, onCopy, onDelete, deleteLabel, deleteHint } = props;
        const label = labelOf(kind, item);
        const copied = flash !== null && flash.id === item.id;
        const copyLabel = t(copyActionLabel(kind));

        return h(
          'div',
          { className: 'mn-actions' },
          copied ? h('span', { className: 'mn-flash', role: 'status' }, flash.ok ? t('copied') : t('copy.failed')) : null,
          h(
            'button',
            {
              type: 'button',
              className: 'mn-action',
              'aria-label': `${t('edit')}: ${label}`,
              title: t('edit'),
              onClick: () => onEdit(item.id),
            },
            h(IconEdit, {}),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'mn-action',
              'aria-label': `${copyLabel}: ${label}`,
              title: copyLabel,
              onClick: () => onCopy(kind, item),
            },
            h(IconCopy, {}),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'mn-action mn-actionDanger',
              'aria-label': `${deleteLabel}: ${label}`,
              title: deleteHint,
              onClick: () => onDelete(item.id),
            },
            '\u00d7',
          ),
        );
      }

      /** The empty state a list shows when it has nothing to render. */
      function Empty(props) {
        return h('div', { className: 'mn-empty' }, props.label);
      }

      /* ---------- one list per tab ---------- */

      function NavList(props) {
        const { t, items, editingId, flash, onEdit, onCopy, onHide, onSave, onCancelEdit, onOrder } = props;
        const drag = useSortable(items, onOrder);

        if (items.length === 0) return h(Empty, { label: t('empty.nav') });

        return h(
          'ul',
          { className: 'mn-list' },
          items.map((item) => {
            if (editingId === item.id) {
              return h(
                'li',
                { className: 'mn-row mn-rowEditing', key: item.id },
                h(RowForm, {
                  tab: 'nav',
                  t,
                  item,
                  submitLabel: t('save'),
                  onSubmit: (patch) => onSave(item.id, patch),
                  onCancel: onCancelEdit,
                }),
              );
            }

            return h(
              'li',
              { className: 'mn-row', key: item.id, ...drag.rowProps(item.id) },
              h(DragHandle, { label: t('drag.handle'), handlers: drag.handleProps(item.id) }),
              h(
                'a',
                {
                  className: 'mn-rowMain',
                  href: item.url,
                  target: '_blank',
                  rel: 'noreferrer noopener',
                  title: item.url,
                  'aria-label': `${t('open.link')}: ${item.title}`,
                },
                h('span', { className: 'mn-rowTitle' }, item.title),
                h('span', { className: 'mn-rowMeta', title: item.url }, item.url),
              ),
              h(RowActions, {
                kind: 'nav',
                item,
                t,
                flash,
                onEdit,
                onCopy,
                onDelete: onHide,
                deleteLabel: t('delete'),
                deleteHint: t('delete.hint'),
              }),
            );
          }),
        );
      }

      /** Filter ids, their locale keys, and the predicate each one applies. */
      const TODO_FILTERS = [
        { id: 'all', label: 'filter.all', match: () => true },
        { id: 'open', label: 'filter.open', match: (item) => item.done !== true },
        { id: 'done', label: 'filter.done', match: (item) => item.done === true },
      ];

      function TodoList(props) {
        const { t, items, editingId, flash, onEdit, onCopy, onHide, onToggle, onSave, onCancelEdit, onOrder } = props;
        const [filter, setFilter] = React.useState('all');
        const current = TODO_FILTERS.find((entry) => entry.id === filter) ?? TODO_FILTERS[0];
        const shown = items.filter(current.match);
        const drag = useSortable(shown, onOrder);

        const filterBar = h(
          'div',
          { className: 'mn-filter', role: 'group', 'aria-label': t('filter.label') },
          TODO_FILTERS.map((entry) =>
            h(
              'button',
              {
                key: entry.id,
                type: 'button',
                className: 'mn-filterItem',
                'data-filter': entry.id,
                'aria-pressed': filter === entry.id,
                onClick: () => setFilter(entry.id),
              },
              t(entry.label),
            ),
          ),
        );

        const body =
          shown.length === 0
            ? h(Empty, { label: items.length === 0 ? t('empty.todo') : t('empty.filter') })
            : h(
                'ul',
                { className: 'mn-list' },
                shown.map((item) => {
                  if (editingId === item.id) {
                    return h(
                      'li',
                      { className: 'mn-row mn-rowEditing', key: item.id },
                      h(RowForm, {
                        tab: 'todo',
                        t,
                        item,
                        submitLabel: t('save'),
                        onSubmit: (patch) => onSave(item.id, patch),
                        onCancel: onCancelEdit,
                      }),
                    );
                  }

                  const stamp = formatStamp(item.createdAt);
                  return h(
                    'li',
                    { className: 'mn-row', key: item.id, ...drag.rowProps(item.id) },
                    h(DragHandle, { label: t('drag.handle'), handlers: drag.handleProps(item.id) }),
                    h(
                      'label',
                      { className: 'mn-checkLabel' },
                      h('input', {
                        type: 'checkbox',
                        className: 'mn-check',
                        checked: item.done === true,
                        'aria-label': t('toggle.todo'),
                        onChange: () => onToggle(item.id),
                      }),
                      h('span', { className: item.done ? 'mn-rowText mn-rowDone' : 'mn-rowText' }, item.text),
                    ),
                    stamp === '' ? null : h('span', { className: 'mn-rowTime', title: stamp }, stamp),
                    h(RowActions, {
                      kind: 'todo',
                      item,
                      t,
                      flash,
                      onEdit,
                      onCopy,
                      onDelete: onHide,
                      deleteLabel: t('delete'),
                      deleteHint: t('delete.hint'),
                    }),
                  );
                }),
              );

        return [filterBar, body];
      }

      function NoteList(props) {
        const { t, items, editingId, flash, onEdit, onCopy, onHide, onSave, onCancelEdit, onOrder } = props;
        const drag = useSortable(items, onOrder);

        if (items.length === 0) return h(Empty, { label: t('empty.note') });

        return h(
          'div',
          { className: 'mn-noteGrid' },
          items.map((item) => {
            if (editingId === item.id) {
              return h(
                'div',
                { className: 'mn-noteCard mn-rowEditing', key: item.id },
                h(RowForm, {
                  tab: 'note',
                  t,
                  item,
                  submitLabel: t('save'),
                  onSubmit: (patch) => onSave(item.id, patch),
                  onCancel: onCancelEdit,
                }),
              );
            }

            return h(
              'article',
              { className: 'mn-noteCard', key: item.id, ...drag.rowProps(item.id) },
              h('div', { className: 'mn-noteHead' }, h(DragHandle, { label: t('drag.handle'), handlers: drag.handleProps(item.id) })),
              h('div', { className: 'mn-noteText' }, item.text),
              h(RowActions, {
                kind: 'note',
                item,
                t,
                flash,
                onEdit,
                onCopy,
                onDelete: onHide,
                deleteLabel: t('delete'),
                deleteHint: t('delete.hint'),
              }),
            );
          }),
        );
      }

      /* ---------- the tab registry ---------- */

      const TAB_DEFS = [
        { List: NavList, id: 'nav', label: 'tab.nav' },
        { List: TodoList, id: 'todo', label: 'tab.todo' },
        { List: NoteList, id: 'note', label: 'tab.note' },
      ];

      /** Tab ids in display order. */
      const TABS = TAB_DEFS.map((entry) => entry.id);

      /** The locale key of one tab's short label, for text that names its kind. */
      function tabLabelKey(kind) {
        const found = TAB_DEFS.find((entry) => entry.id === kind);
        return found === undefined ? kind : found.label;
      }

      /* ---------- history drawer ---------- */

      function HistoryPane(props) {
        const {
          t,
          entries,
          selected,
          confirmClear,
          editingId,
          flash,
          onToggleSelect,
          onEdit,
          onCopy,
          onSave,
          onCancelEdit,
          onPurge,
          onRestoreSelected,
          onPurgeSelected,
          onClearAll,
          onClose,
        } = props;

        const rows =
          entries.length === 0
            ? h(Empty, { label: t('history.empty') })
            : entries.map(({ kind, item }) => {
                if (editingId === item.id) {
                  return h(
                    'div',
                    { className: 'mn-drawerRow mn-rowEditing', key: item.id },
                    h(RowForm, {
                      tab: kind,
                      t,
                      item,
                      submitLabel: t('save'),
                      onSubmit: (patch) => onSave(item.id, patch),
                      onCancel: onCancelEdit,
                    }),
                  );
                }

                const label = labelOf(kind, item);
                const picked = selected.includes(item.id);
                return h(
                  'div',
                  { className: 'mn-drawerRow', key: item.id, 'data-selected': picked ? 'true' : 'false' },
                  h(
                    'label',
                    { className: 'mn-pick' },
                    h('input', {
                      type: 'checkbox',
                      className: 'mn-check',
                      checked: picked,
                      'aria-label': `${t('history.select')}: ${label}`,
                      onChange: () => onToggleSelect(item.id),
                    }),
                  ),
                  h(
                    'div',
                    { className: 'mn-rowMain' },
                    h('span', { className: 'mn-rowTitle', title: label }, label),
                    h('span', { className: 'mn-rowMeta' }, kind === 'nav' ? item.url : t(tabLabelKey(kind))),
                  ),
                  h(RowActions, {
                    kind,
                    item,
                    t,
                    flash,
                    onEdit,
                    onCopy,
                    onDelete: onPurge,
                    deleteLabel: t('history.delete'),
                    deleteHint: t('history.delete'),
                  }),
                );
              });

        return [
          h('div', { className: 'mn-scrim', key: 'scrim', onClick: onClose, 'aria-hidden': 'true' }),
          h(
            'aside',
            { className: 'mn-drawer', key: 'drawer', role: 'complementary', 'aria-label': t('history.title') },
            h(
              'header',
              { className: 'mn-drawerHead' },
              h(
                'h2',
                { className: 'mn-drawerTitle' },
                t('history.title'),
                entries.length === 0 ? null : h('span', { className: 'mn-badge' }, String(entries.length)),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: confirmClear ? 'mn-ghostSmall mn-ghostDanger' : 'mn-ghostSmall',
                  disabled: entries.length === 0,
                  onClick: onClearAll,
                },
                confirmClear ? t('history.clearConfirm') : t('history.clear'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'mn-action',
                  'aria-label': t('history.close'),
                  title: t('history.close'),
                  onClick: onClose,
                },
                '\u00d7',
              ),
            ),
            h('div', { className: 'mn-drawerBody' }, rows),
            selected.length === 0
              ? null
              : h(
                  'footer',
                  { className: 'mn-drawerFoot' },
                  h(
                    'span',
                    { className: 'mn-drawerCount' },
                    `${t('history.selectedLabel')} ${selected.length} ${t('history.selectedUnit')}`,
                  ),
                  h('button', { type: 'button', className: 'mn-ghostSmall', onClick: onRestoreSelected }, t('restore')),
                  h(
                    'button',
                    { type: 'button', className: 'mn-ghostSmall mn-ghostDanger', onClick: onPurgeSelected },
                    t('history.delete'),
                  ),
                ),
          ),
        ];
      }

      return {
        DragHandle,
        HistoryPane,
        IconHistory,
        NavList,
        NoteList,
        PanelIcon,
        RowActions,
        RowForm,
        TAB_DEFS,
        TABS,
        TodoList,
        tabLabelKey,
        useSortable,
      };
    };
  },
});
