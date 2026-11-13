/**
 * Everything the page draws: icons, the chart, the metric cards, the log and
 * trace lists, the chat, the filters, and the MCP connection drawer.
 *
 * A component here never fetches; the page passes data and callbacks down, so a
 * view can be reasoned about from its props alone.
 */
window.__ModuleLoader__.load({
  id: 'my-deploy',
  chunk: 'client.ui.js',
  factory() {
    return (runtime) => {
      const {
        React,
        RANGE_LABELS,
        RANGES,
        TAB_LABELS,
        TABS,
        connectionLabel,
        formatBytes,
        formatClock,
        formatDuration,
        formatNumber,
        formatStamp,
        h,
        isComposing,
        levelOf,
        ratioOf,
        reasonOf,
        reasonText,
        shortId,
      } = runtime;

      /* ---------- icons ---------- */

      function glyph(name, size, children) {
        return h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 16 16',
            fill: 'none',
            'aria-hidden': 'true',
            focusable: 'false',
            'data-glyph': name,
          },
          children,
        );
      }

      /** Sidebar glyph: a rising signal trace, at the size the sidebar allocates. */
      function PanelIcon(props) {
        const size = typeof props.size === 'number' ? props.size : 16;
        return glyph(
          'panel',
          size,
          [
            h('path', { key: 'base', d: 'M1.8 12.6h12.4', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
            h('path', {
              key: 'line',
              d: 'M2.8 10.2 6 6.4l2.3 2 3-4 1.9 2.6',
              stroke: 'currentColor',
              strokeWidth: 1.3,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
            }),
            h('circle', { key: 'a', cx: 6, cy: 6.4, r: 1.1, fill: 'currentColor' }),
            h('circle', { key: 'b', cx: 8.3, cy: 8.4, r: 1.1, fill: 'currentColor' }),
            h('circle', { key: 'c', cx: 11.3, cy: 4.4, r: 1.1, fill: 'currentColor' }),
          ],
        );
      }

      function IconPlug(props) {
        return glyph(
          'plug',
          typeof props.size === 'number' ? props.size : 14,
          [
            h('path', { key: 'a', d: 'M6 2.4v2.8M10 2.4v2.8', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
            h('path', {
              key: 'b',
              d: 'M4.2 5.2h7.6v2.2a3.8 3.8 0 0 1-7.6 0Z',
              stroke: 'currentColor',
              strokeWidth: 1.3,
              strokeLinejoin: 'round',
            }),
            h('path', { key: 'c', d: 'M8 11.2v2.4', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
          ],
        );
      }

      function IconRefresh(props) {
        return glyph(
          'refresh',
          typeof props.size === 'number' ? props.size : 14,
          [
            h('path', {
              key: 'a',
              d: 'M3 8a5 5 0 1 0 1.5-3.6',
              stroke: 'currentColor',
              strokeWidth: 1.3,
              strokeLinecap: 'round',
            }),
            h('path', {
              key: 'b',
              d: 'M2.6 2.8v2.6H5.2',
              stroke: 'currentColor',
              strokeWidth: 1.3,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
            }),
          ],
        );
      }

      function IconClose(props) {
        return glyph(
          'close',
          typeof props.size === 'number' ? props.size : 14,
          h('path', { d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        );
      }

      /* ---------- small pieces ---------- */

      /** A titled empty state; `action` is an optional button below the hint. */
      function EmptyState(props) {
        return h(
          'div',
          { className: 'dp-empty' },
          h('p', { className: 'dp-emptyTitle' }, props.title),
          props.hint ? h('p', { className: 'dp-emptyHint' }, props.hint) : null,
          props.action ?? null,
        );
      }

      /** One status line: a tone, a sentence, and an optional detail. */
      function StatusNote(props) {
        return h(
          'div',
          { className: 'dp-listHead', role: props.tone === 'error' ? 'alert' : 'status' },
          h('span', null, props.text),
          props.detail ? h('span', { className: 'dp-note' }, props.detail) : null,
          props.action ?? null,
        );
      }

      /** A labelled field; the child is the control. */
      function Field(props) {
        return h(
          'label',
          { className: 'dp-field' },
          h('span', null, props.label),
          props.children,
          props.hint ? h('span', { className: 'dp-hint' }, props.hint) : null,
        );
      }

      /** The segmented tab control with its sliding indicator. */
      function Tabs(props) {
        const { t, tab, onSelect } = props;
        const index = Math.max(0, TABS.indexOf(tab));
        const refs = React.useRef([]);
        const onKeyDown = (event, at) => {
          let next;
          if (event.key === 'ArrowLeft') next = (at + TABS.length - 1) % TABS.length;
          else if (event.key === 'ArrowRight') next = (at + 1) % TABS.length;
          else if (event.key === 'Home') next = 0;
          else if (event.key === 'End') next = TABS.length - 1;
          else return;
          event.preventDefault();
          const target = refs.current[next];
          if (target) target.focus();
          onSelect(TABS[next]);
        };
        return h(
          'div',
          { className: 'dp-tabs', role: 'tablist', 'aria-label': t('tabs.label') },
          h('span', {
            className: 'dp-tabIndicator',
            'aria-hidden': 'true',
            style: { width: `calc((100% - 8px) / ${TABS.length})`, transform: `translateX(${index * 100}%)` },
          }),
          TABS.map((id, at) =>
            h(
              'button',
              {
                key: id,
                ref: (node) => {
                  refs.current[at] = node;
                },
                type: 'button',
                role: 'tab',
                className: 'dp-tab',
                'aria-selected': id === tab,
                tabIndex: id === tab ? 0 : -1,
                onClick: () => onSelect(id),
                onKeyDown: (event) => onKeyDown(event, at),
              },
              t(TAB_LABELS[id]),
            ),
          ),
        );
      }

      /** The right-hand connection control: a status dot and the drawer trigger. */
      function ConnectionPill(props) {
        const { t, connection, open, onToggle } = props;
        const label = connectionLabel(t, connection.status);
        return h(
          'button',
          {
            type: 'button',
            className: 'dp-conn',
            'data-state': connection.status,
            'data-open': open ? 'true' : 'false',
            'aria-expanded': open,
            title: connection.error === '' ? label : `${label}: ${connection.error}`,
            onClick: onToggle,
          },
          h('span', { className: 'dp-connDot', 'aria-hidden': 'true' }),
          h('span', { className: 'dp-connText' }, `${label}${connection.status === 'connected' ? ` · MCP` : ''}`),
          h(IconPlug, { size: 13 }),
        );
      }

      /** The service filter: every name the MCP server reported, plus the current one. */
      function ServiceSelect(props) {
        const { t, value, services, onChange } = props;
        const known = services.includes(value) || value === '' ? services : [value, ...services];
        return h(
          'span',
          { className: 'dp-fieldLabel' },
          `${t('filter.service')} `,
          h(
            'select',
            {
              className: 'dp-select',
              value,
              'aria-label': t('filter.service'),
              onChange: (event) => onChange(event.target.value),
            },
            h('option', { value: '' }, t('filter.serviceAll')),
            known.map((name) => h('option', { key: name, value: name }, name)),
          ),
        );
      }

      /** The range filter. */
      function RangeSelect(props) {
        const { t, value, onChange } = props;
        return h(
          'span',
          { className: 'dp-fieldLabel' },
          `${t('filter.range')} `,
          h(
            'select',
            {
              className: 'dp-select',
              value,
              'aria-label': t('filter.range'),
              onChange: (event) => onChange(event.target.value),
            },
            RANGES.map((range) => h('option', { key: range, value: range }, t(RANGE_LABELS[range]))),
          ),
        );
      }

      /* ---------- charts ---------- */

      /**
       * One line chart. A 100x40 viewBox scaled to the card keeps the geometry
       * simple; `vector-effect` keeps the stroke 1.5px at any card width.
       */
      function Chart(props) {
        const { points, tone, label } = props;
        if (!Array.isArray(points) || points.length < 2) {
          return h(
            'svg',
            { className: 'dp-chart', 'data-tone': tone, viewBox: '0 0 100 40', preserveAspectRatio: 'none', role: 'img', 'aria-label': label },
            h('line', { x1: 0, y1: 38, x2: 100, y2: 38, stroke: 'currentColor', strokeWidth: 1, strokeOpacity: 0.25, vectorEffect: 'non-scaling-stroke' }),
          );
        }
        let max = 0;
        for (const point of points) if (point[1] > max) max = point[1];
        const scale = max > 0 ? max : 1;
        const step = 100 / (points.length - 1);
        const yOf = (value) => 38 - Math.min(1, Math.max(0, value / scale)) * 34;
        const line = points
          .map((point, at) => `${at === 0 ? 'M' : 'L'}${(at * step).toFixed(2)} ${yOf(point[1]).toFixed(2)}`)
          .join(' ');
        return h(
          'svg',
          { className: 'dp-chart', 'data-tone': tone, viewBox: '0 0 100 40', preserveAspectRatio: 'none', role: 'img', 'aria-label': label },
          h('path', { d: `${line} L100 40 L0 40 Z`, fill: 'currentColor', fillOpacity: 0.12, stroke: 'none' }),
          h('path', {
            d: line,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            strokeLinejoin: 'round',
            strokeLinecap: 'round',
            vectorEffect: 'non-scaling-stroke',
          }),
        );
      }

      /** One metric card: headline value, chart, stats, and its dimensions. */
      function MetricCard(props) {
        const { t, title, tone, metric, unit } = props;
        const showValue = (value) => (unit === 'bytes' ? formatBytes(value) : formatNumber(value, 2));
        const unitLabel = unit === 'bytes' ? '' : t('monitor.unitCores');
        return h(
          'section',
          { className: 'dp-card', 'data-tone': tone },
          h(
            'div',
            { className: 'dp-cardHead' },
            h('h2', { className: 'dp-cardTitle' }, title),
            metric.ok
              ? h(
                  'span',
                  { className: 'dp-cardValue' },
                  showValue(metric.current),
                  unitLabel === '' ? null : h('span', { className: 'dp-cardUnit' }, unitLabel),
                )
              : h('span', { className: 'dp-cardValue' }, '—'),
          ),
          h(Chart, { points: metric.points, tone, label: title }),
          metric.ok && metric.points.length === 0
            ? h('p', { className: 'dp-note' }, t('monitor.emptySeries'))
            : null,
          metric.ok
            ? h(
                'div',
                { className: 'dp-cardStats' },
                h('span', null, t('monitor.avg'), ' ', h('span', { className: 'dp-statValue' }, showValue(metric.avg))),
                h('span', null, t('monitor.max'), ' ', h('span', { className: 'dp-statValue' }, showValue(metric.max))),
                unitLabel === '' ? null : h('span', null, unitLabel),
              )
            : h('p', { className: 'dp-note' }, `${reasonText(t, metric.reason || 'query-failed')}${metric.note === '' ? '' : ` · ${metric.note}`}`),
          metric.series.length > 1
            ? h(
                'ul',
                { className: 'dp-dims' },
                metric.series.slice(0, 5).map((entry) =>
                  h(
                    'li',
                    { key: entry.name, className: 'dp-dim' },
                    h('span', { className: 'dp-dimName', title: entry.name }, entry.name),
                    h('span', { className: 'dp-dimValue' }, showValue(entry.current)),
                  ),
                ),
              )
            : null,
          metric.tool === ''
            ? null
            : h(
                'p',
                { className: 'dp-note', title: metric.query },
                `${t('monitor.tool')}: ${metric.tool}${metric.query === '' ? '' : ` · ${metric.query}`}`,
              ),
        );
      }

      /* ---------- monitor view ---------- */

      function MonitorView(props) {
        const { t, piece, onConnect, onRetry } = props;
        if (piece.phase === 'loading') return h(StatusNote, { text: t('monitor.loading') });
        if (piece.phase === 'error') {
          return h(StatusNote, {
            tone: 'error',
            text: t('monitor.emptyError'),
            detail: piece.detail,
            action: h('button', { type: 'button', className: 'dp-btn', onClick: onRetry }, t('status.retry')),
          });
        }
        const data = piece.data;
        if (data === null) {
          return h(EmptyState, {
            title: t('monitor.empty'),
            hint: t('monitor.emptyNoService'),
            action: h('button', { type: 'button', className: 'dp-btn', onClick: onConnect }, t('monitor.connect')),
          });
        }
        const reason = reasonOf(data);
        if (reason === 'not-connected' || reason === 'not-configured') {
          return h(EmptyState, {
            title: reasonText(t, reason),
            hint: t('status.connectHint'),
            action: h('button', { type: 'button', className: 'dp-btn', onClick: onConnect }, t('monitor.connect')),
          });
        }
        if (reason === 'no-tool') {
          return h(EmptyState, { title: t('monitor.emptyNoTool'), hint: data.note });
        }
        if (!data.cpu.ok && !data.memory.ok) {
          return h(EmptyState, {
            title: t('monitor.emptyError'),
            hint: data.note,
            action: h('button', { type: 'button', className: 'dp-btn', onClick: onRetry }, t('status.retry')),
          });
        }
        return h(
          'div',
          { className: 'dp-cards' },
          h(MetricCard, { t, title: t('monitor.cpu'), tone: 'cpu', metric: data.cpu, unit: 'cores' }),
          h(MetricCard, { t, title: t('monitor.memory'), tone: 'memory', metric: data.memory, unit: 'bytes' }),
        );
      }

      /* ---------- log view ---------- */

      function LogList(props) {
        const { t, piece, onConnect, onRetry } = props;
        const [expanded, setExpanded] = React.useState('');
        if (piece.phase === 'loading') return h(StatusNote, { text: t('logs.loading') });
        if (piece.phase === 'error') {
          return h(StatusNote, {
            tone: 'error',
            text: t('status.error'),
            detail: piece.detail,
            action: h('button', { type: 'button', className: 'dp-btn', onClick: onRetry }, t('status.retry')),
          });
        }
        const data = piece.data;
        if (data === null) return h(EmptyState, { title: t('logs.empty'), hint: t('logs.emptyHint') });
        const reason = reasonOf(data);
        if (reason !== '') {
          const offline = reason === 'not-connected' || reason === 'not-configured';
          return h(EmptyState, {
            title: reasonText(t, reason),
            hint: offline ? t('status.connectHint') : data.note,
            action: offline
              ? h('button', { type: 'button', className: 'dp-btn', onClick: onConnect }, t('logs.connect'))
              : h('button', { type: 'button', className: 'dp-btn', onClick: onRetry }, t('status.retry')),
          });
        }
        if (data.rows.length === 0) return h(EmptyState, { title: t('logs.empty'), hint: t('logs.emptyHint') });
        return h(
          React.Fragment,
          null,
          h(
            'div',
            { className: 'dp-listHead' },
            h('span', null, t('logs.count').replace('{count}', String(data.rows.length))),
            data.query === '' ? null : h('span', { className: 'dp-note', title: data.query }, `${t('logs.query')}: ${data.query}`),
          ),
          h(
            'div',
            { className: 'dp-rows' },
            data.rows.map((row, at) => {
              const level = levelOf(row.level);
              const key = `${row.ts}-${at}`;
              const hasLabels = Object.keys(row.labels).length > 0;
              return h(
                'button',
                {
                  key,
                  type: 'button',
                  className: 'dp-logRow',
                  'aria-expanded': expanded === key,
                  onClick: () => setExpanded(expanded === key ? '' : key),
                },
                h('span', { className: 'dp-logTime' }, formatClock(row.ts) || row.time || '—'),
                h('span', { className: 'dp-level', 'data-level': level }, level || '·'),
                h('span', { className: 'dp-logMsg' }, row.message),
                expanded === key && hasLabels
                  ? h(
                      'span',
                      { className: 'dp-logDetail' },
                      Object.entries(row.labels)
                        .map(([name, value]) => `${name}=${value}`)
                        .join('\n'),
                    )
                  : null,
              );
            }),
          ),
        );
      }

      /* ---------- trace view ---------- */

      function TraceList(props) {
        const { t, piece, onConnect, onRetry } = props;
        const [expanded, setExpanded] = React.useState('');
        if (piece.phase === 'loading') return h(StatusNote, { text: t('traces.loading') });
        if (piece.phase === 'error') {
          return h(StatusNote, {
            tone: 'error',
            text: t('status.error'),
            detail: piece.detail,
            action: h('button', { type: 'button', className: 'dp-btn', onClick: onRetry }, t('status.retry')),
          });
        }
        const data = piece.data;
        if (data === null) return h(EmptyState, { title: t('traces.empty'), hint: t('traces.emptyHint') });
        const reason = reasonOf(data);
        if (reason !== '') {
          const offline = reason === 'not-connected' || reason === 'not-configured';
          return h(EmptyState, {
            title: reasonText(t, reason),
            hint: offline ? t('status.connectHint') : data.note,
            action: offline
              ? h('button', { type: 'button', className: 'dp-btn', onClick: onConnect }, t('traces.connect'))
              : h('button', { type: 'button', className: 'dp-btn', onClick: onRetry }, t('status.retry')),
          });
        }
        if (data.traces.length === 0) return h(EmptyState, { title: t('traces.empty'), hint: data.note || t('traces.emptyHint') });
        const slowest = data.traces.reduce((top, trace) => (trace.durationMs > top ? trace.durationMs : top), 0);
        return h(
          React.Fragment,
          null,
          h(
            'div',
            { className: 'dp-listHead' },
            h('span', null, t('traces.count').replace('{count}', String(data.traces.length))),
            data.query === '' ? null : h('span', { className: 'dp-note', title: data.query }, `${t('logs.query')}: ${data.query}`),
          ),
          h(
            'div',
            { className: 'dp-rows' },
            data.traces.map((trace, at) => {
              const key = `${trace.traceId}-${at}`;
              const open = expanded === key;
              return h(
                'button',
                {
                  key,
                  type: 'button',
                  className: 'dp-traceRow',
                  'data-error': trace.error ? 'true' : 'false',
                  'aria-expanded': open,
                  onClick: () => setExpanded(open ? '' : key),
                },
                h(
                  'span',
                  null,
                  h('span', { className: 'dp-traceName' }, trace.root || t('traces.spansTitle')),
                  h(
                    'span',
                    { className: 'dp-traceMeta' },
                    `${shortId(trace.traceId, 16)}${trace.service === '' ? '' : ` · ${trace.service}`} · ${formatClock(trace.start) || formatStamp(trace.start)}`,
                  ),
                  h('span', { className: 'dp-durBar', 'aria-hidden': 'true' }, h('span', { className: 'dp-durFill', style: { width: `${Math.round(ratioOf(trace.durationMs, slowest) * 100)}%` } })),
                ),
                h('span', { className: 'dp-spanDur' }, formatDuration(trace.durationMs)),
                h('span', { className: 'dp-spanDur' }, `${trace.spanCount} ${t('traces.spans')}`),
                open
                  ? h(
                      'span',
                      { className: 'dp-spans' },
                      trace.spans.length === 0
                        ? h('span', { className: 'dp-note' }, t('common.none'))
                        : trace.spans.map((span, index) =>
                            h(
                              'span',
                              { key: `${span.id}-${index}`, className: 'dp-span' },
                              h(
                                'span',
                                { className: 'dp-spanName', 'data-depth': String(Math.min(3, span.depth)), title: `${span.service} · ${span.id}` },
                                `${span.error ? '⚠ ' : ''}${span.name || span.id}`,
                              ),
                              h('span', { className: 'dp-spanDur' }, formatDuration(span.durationMs)),
                            ),
                          ),
                    )
                  : null,
              );
            }),
          ),
        );
      }

      /* ---------- chat ---------- */

      function ChatPanel(props) {
        const { t, tab, entries, busy, connection, draft, onChangeDraft, onSend, onClear } = props;
        const log = React.useRef(null);
        React.useEffect(() => {
          const node = log.current;
          if (node !== null) node.scrollTop = node.scrollHeight;
        }, [entries, busy]);
        const connected = connection.status === 'connected';
        const canSend = connected && !busy && draft.trim() !== '';
        return h(
          'section',
          { className: 'dp-chat' },
          h(
            'div',
            { className: 'dp-chatHead' },
            h('h3', null, t('chat.title')),
            h('span', { className: 'dp-spacer' }),
            entries.length === 0 ? null : h('button', { type: 'button', className: 'dp-btn', onClick: onClear }, t('chat.clear')),
          ),
          h(
            'div',
            { className: 'dp-chatLog', ref: log },
            entries.length === 0
              ? h('p', { className: 'dp-hint' }, connected ? t('chat.empty') : t('chat.needConnect'))
              : entries.map((entry) =>
                  h(
                    'div',
                    { key: entry.id, className: 'dp-msg', 'data-role': entry.role, 'data-tone': entry.tone },
                    h('span', { className: 'dp-msgRole' }, entry.role === 'user' ? t('chat.you') : t('chat.assistant')),
                    h('p', { className: 'dp-msgBody' }, entry.text),
                    entry.calls.length === 0
                      ? null
                      : h(
                          'div',
                          { className: 'dp-tools' },
                          h('span', { className: 'dp-msgRole' }, t('chat.tools')),
                          entry.calls.map((call, at) =>
                            h(
                              'span',
                              {
                                key: `${call.name}-${at}`,
                                className: 'dp-tool',
                                'data-ok': call.ok ? 'true' : 'false',
                                title: call.args,
                              },
                              `${call.name} · ${call.ok ? t('chat.toolOk') : t('chat.toolBad')}`,
                            ),
                          ),
                        ),
                    entry.note === '' ? null : h('span', { className: 'dp-hint' }, entry.note),
                  ),
                ),
            busy
              ? h(
                  'div',
                  { className: 'dp-msg', 'data-role': 'assistant' },
                  h('span', { className: 'dp-msgRole' }, t('chat.assistant')),
                  h('p', { className: 'dp-msgBody' }, t('chat.thinking')),
                )
              : null,
          ),
          h(
            'div',
            { className: 'dp-composer' },
            h('textarea', {
              className: 'dp-textarea',
              value: draft,
              rows: 1,
              placeholder: connected ? t('chat.placeholder') : t('chat.needConnect'),
              'aria-label': t('chat.placeholder'),
              disabled: !connected,
              onChange: (event) => onChangeDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key !== 'Enter' || event.shiftKey) return;
                if (isComposing(event)) return;
                event.preventDefault();
                if (canSend) onSend();
              },
            }),
            h('button', { type: 'button', className: 'dp-send', disabled: !canSend, onClick: onSend }, t('chat.send')),
          ),
          h('p', { className: 'dp-hint' }, t('chat.hint')),
        );
      }

      /* ---------- MCP drawer ---------- */

      /** The connection panel: transport, endpoint, headers, status, and tools. */
      function McpDrawer(props) {
        const { t, config, connection, busy, onClose, onSave, onDisconnect } = props;
        const [draft, setDraft] = React.useState(() => ({
          transport: config.transport,
          url: config.url,
          command: config.command,
          argsText: config.args.join('\n'),
          headersText: config.headersText,
          serverName: config.serverName,
          autoConnect: config.autoConnect,
          queries: { ...config.queries },
        }));
        const set = (key, value) => setDraft((previous) => ({ ...previous, [key]: value }));
        const setQuery = (key, value) =>
          setDraft((previous) => ({ ...previous, queries: { ...previous.queries, [key]: value } }));

        /** The body the Host saves; `connect` asks it to dial right after. */
        const payload = (connect) => ({
          transport: draft.transport,
          url: draft.url,
          command: draft.command,
          args: draft.argsText.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== ''),
          headersText: draft.headersText,
          serverName: draft.serverName,
          autoConnect: draft.autoConnect,
          queries: draft.queries,
          ...(connect ? { connect: true } : {}),
        });

        const connected = connection.status === 'connected';
        const label = connectionLabel(t, connection.status);

        return h(
          React.Fragment,
          null,
          h('div', { className: 'dp-scrim', onClick: onClose, 'aria-hidden': 'true' }),
          h(
            'aside',
            { className: 'dp-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('mcp.title') },
            h(
              'div',
              { className: 'dp-drawerHead' },
              h(
                'div',
                { className: 'dp-drawerTitleBox' },
                h('h2', { className: 'dp-drawerTitle' }, t('mcp.title')),
                h('p', { className: 'dp-drawerSub' }, t('mcp.subtitle')),
              ),
              h(
                'button',
                { type: 'button', className: 'dp-iconBtn', 'aria-label': t('mcp.close'), onClick: onClose },
                h(IconClose, { size: 12 }),
              ),
            ),
            h(
              'div',
              { className: 'dp-drawerBody' },
              h(
                'div',
                { className: 'dp-statusBox' },
                h(
                  'div',
                  { className: 'dp-statusRow' },
                  h('span', { className: 'dp-statusKey' }, t('mcp.button')),
                  h(
                    'span',
                    { className: 'dp-statusVal', 'data-tone': connection.status === 'error' ? 'error' : undefined },
                    `${label}${connection.serverInfo.name === '' ? '' : ` · ${connection.serverInfo.name}${connection.serverInfo.version === '' ? '' : ` ${connection.serverInfo.version}`}`}`,
                  ),
                ),
                connection.protocolVersion === ''
                  ? null
                  : h(
                      'div',
                      { className: 'dp-statusRow' },
                      h('span', { className: 'dp-statusKey' }, t('mcp.protocol')),
                      h('span', { className: 'dp-statusVal' }, connection.protocolVersion),
                    ),
                connection.connectedAt === 0
                  ? null
                  : h(
                      'div',
                      { className: 'dp-statusRow' },
                      h('span', { className: 'dp-statusKey' }, t('mcp.since')),
                      h('span', { className: 'dp-statusVal' }, formatStamp(connection.connectedAt)),
                    ),
                h(
                  'div',
                  { className: 'dp-statusRow' },
                  h('span', { className: 'dp-statusKey' }, t('mcp.tools')),
                  h(
                    'span',
                    { className: 'dp-statusVal' },
                    connection.tools.length === 0
                      ? t('common.none')
                      : h(
                          'span',
                          { className: 'dp-toolChips' },
                          connection.tools.slice(0, 18).map((tool) =>
                            h('span', { key: tool.name, className: 'dp-chip', title: tool.description }, tool.name),
                          ),
                        ),
                  ),
                ),
                connection.error === ''
                  ? null
                  : h(
                      'div',
                      { className: 'dp-statusRow' },
                      h('span', { className: 'dp-statusKey' }, t('mcp.error')),
                      h('span', { className: 'dp-statusVal', 'data-tone': 'error' }, connection.error),
                    ),
                props.error === '' || props.error === undefined
                  ? null
                  : h(
                      'div',
                      { className: 'dp-statusRow', role: 'alert' },
                      h('span', { className: 'dp-statusKey' }, t('status.error')),
                      h('span', { className: 'dp-statusVal', 'data-tone': 'error' }, props.error),
                    ),
                connection.instructions === ''
                  ? null
                  : h(
                      'div',
                      { className: 'dp-statusRow' },
                      h('span', { className: 'dp-statusKey' }, t('mcp.instructions')),
                      h('span', { className: 'dp-statusVal' }, connection.instructions.slice(0, 400)),
                    ),
              ),
              h(
                Field,
                { label: t('mcp.transport') },
                h(
                  'select',
                  {
                    className: 'dp-select',
                    value: draft.transport,
                    onChange: (event) => set('transport', event.target.value),
                  },
                  h('option', { value: 'streamable-http' }, t('mcp.transport.http')),
                  h('option', { value: 'stdio' }, t('mcp.transport.stdio')),
                ),
              ),
              h(Field, {
                label: t('mcp.serverName'),
                hint: t('mcp.serverNameHint'),
                children: h('input', {
                  className: 'dp-input',
                  value: draft.serverName,
                  spellCheck: false,
                  onChange: (event) => set('serverName', event.target.value),
                }),
              }),
              draft.transport === 'streamable-http'
                ? h(Field, {
                    label: t('mcp.url'),
                    hint: t('mcp.urlHint'),
                    children: h('input', {
                      className: 'dp-input',
                      value: draft.url,
                      spellCheck: false,
                      placeholder: 'http://127.0.0.1:8000/mcp',
                      onChange: (event) => set('url', event.target.value),
                    }),
                  })
                : h(
                    React.Fragment,
                    null,
                    h(Field, {
                      label: t('mcp.command'),
                      hint: t('mcp.commandHint'),
                      children: h('input', {
                        className: 'dp-input',
                        value: draft.command,
                        spellCheck: false,
                        placeholder: 'docker',
                        onChange: (event) => set('command', event.target.value),
                      }),
                    }),
                    h(Field, {
                      label: t('mcp.args'),
                      hint: t('mcp.argsHint'),
                      children: h('textarea', {
                        className: 'dp-textarea2',
                        value: draft.argsText,
                        spellCheck: false,
                        rows: 3,
                        onChange: (event) => set('argsText', event.target.value),
                      }),
                    }),
                  ),
              h(Field, {
                label: t('mcp.headers'),
                hint: t('mcp.headersHint'),
                children: h('textarea', {
                  className: 'dp-textarea2',
                  value: draft.headersText,
                  spellCheck: false,
                  rows: 3,
                  placeholder: 'Authorization: Bearer <token>',
                  onChange: (event) => set('headersText', event.target.value),
                }),
              }),
              h(
                'label',
                { className: 'dp-hint' },
                h('input', {
                  type: 'checkbox',
                  checked: draft.autoConnect,
                  onChange: (event) => set('autoConnect', event.target.checked),
                }),
                ` ${t('mcp.autoConnect')}`,
              ),
              h(
                'details',
                { className: 'dp-field' },
                h('summary', { className: 'dp-hint' }, t('mcp.advanced')),
                h('p', { className: 'dp-hint' }, t('mcp.datasourceHint')),
                h(Field, {
                  label: 'PromQL · CPU',
                  children: h('textarea', {
                    className: 'dp-textarea2',
                    value: draft.queries.cpu,
                    spellCheck: false,
                    rows: 2,
                    onChange: (event) => setQuery('cpu', event.target.value),
                  }),
                }),
                h(Field, {
                  label: 'PromQL · Memory',
                  children: h('textarea', {
                    className: 'dp-textarea2',
                    value: draft.queries.memory,
                    spellCheck: false,
                    rows: 2,
                    onChange: (event) => setQuery('memory', event.target.value),
                  }),
                }),
                h(Field, {
                  label: 'LogQL',
                  children: h('textarea', {
                    className: 'dp-textarea2',
                    value: draft.queries.logs,
                    spellCheck: false,
                    rows: 2,
                    onChange: (event) => setQuery('logs', event.target.value),
                  }),
                }),
                h(Field, {
                  label: 'TraceQL',
                  children: h('textarea', {
                    className: 'dp-textarea2',
                    value: draft.queries.traces,
                    spellCheck: false,
                    rows: 2,
                    onChange: (event) => setQuery('traces', event.target.value),
                  }),
                }),
                h('p', { className: 'dp-hint' }, t('mcp.help')),
              ),
            ),
            h(
              'div',
              { className: 'dp-drawerFoot' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dp-btn',
                  'data-kind': 'primary',
                  disabled: busy.saving || busy.connecting,
                  onClick: () => onSave(payload(true)),
                },
                busy.connecting ? t('mcp.status.connecting') : connected ? t('mcp.reconnect') : t('mcp.connect'),
              ),
              h(
                'button',
                { type: 'button', className: 'dp-btn', disabled: busy.saving || busy.connecting, onClick: () => onSave(payload(false)) },
                busy.saving ? t('mcp.saving') : t('mcp.save'),
              ),
              connected
                ? h(
                    'button',
                    { type: 'button', className: 'dp-btn', 'data-kind': 'danger', disabled: busy.disconnecting, onClick: onDisconnect },
                    t('mcp.disconnect'),
                  )
                : null,
            ),
          ),
        );
      }

      return {
        ChatPanel,
        Chart,
        ConnectionPill,
        EmptyState,
        Field,
        IconClose,
        IconPlug,
        IconRefresh,
        LogList,
        McpDrawer,
        MetricCard,
        MonitorView,
        PanelIcon,
        RangeSelect,
        ServiceSelect,
        StatusNote,
        Tabs,
        TraceList,
      };
    };
  },
});
