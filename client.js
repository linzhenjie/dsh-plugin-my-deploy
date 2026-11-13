/**
 * my-deploy — bundle entry.
 *
 * This file is only the wiring: it resolves the package's runtime chunks with
 * `require.async`, builds one runtime object they share, and registers the
 * sidebar row and the page. Every chunk is a real file served by the Harness
 * bundle route:
 *
 *   client.i18n.js    zh/en dictionaries   (generated from src/config/*.json)
 *   client.styles.js  page CSS             (generated from src/styles.css)
 *   client.utils.js   pure + browser helpers
 *   client.model.js   state shape, registries, and pure operations
 *   client.data.js    the one HTTP exchange with the Host half
 *   client.ui.js      icons, charts, lists, chat, and the MCP drawer
 *   client.page.js    the page itself: tabs, filters, loads, and actions
 *
 * A chunk may not synchronously require a sibling, so the entry passes one
 * shared `runtime` object and every chunk exports `(runtime) => exports`.
 */
window.__ModuleLoader__.load({
  id: 'my-deploy',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace owned by this plugin. */
    const NS = 'myDeploy';
    /** Stable id shared by the sidebar entry and the main panel key. */
    const PANEL_ID = 'my-deploy';
    /** The Host route a page-side report goes to. */
    const API = '/api/my-deploy';

    /** Every chunk after the dictionaries and the styles, in dependency order. */
    const CHUNKS = ['client.utils.js', 'client.model.js', 'client.data.js', 'client.ui.js'];

    /**
     * Report one page-side event to the Host, which keeps a bounded trail in
     * `<storages>/my-deploy-diagnostics.json`. A page that renders nothing is
     * invisible from the Host, so the mount heartbeat is the one signal that
     * separates "did not mount" from "mounted but looks empty".
     * Never throws and never retries: reporting must not break the page.
     */
    function report(kind, message, detail, view) {
      try {
        const body = JSON.stringify({
          kind: String(kind ?? ''),
          message: String(message ?? ''),
          detail: String(detail ?? ''),
          view: view ?? null,
        });
        const call = fetch(`${API}/diagnostic`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          cache: 'no-store',
          credentials: 'same-origin',
          keepalive: true,
        });
        if (call && typeof call.catch === 'function') call.catch(() => {});
      } catch (error) {
        /* reporting is best effort */
      }
    }

    /** Resolve one package-local chunk through the Harness module loader. */
    const chunk = (file) => require.async(`./${file}`);

    /** Apply one chunk's exports onto the shared runtime. */
    async function extend(runtime, file) {
      const load = await chunk(file);
      return Object.assign(runtime, load(runtime));
    }

    /** The failure surface: a page that still says what happened instead of nothing. */
    function Failure(props) {
      return h(
        'div',
        { className: 'dp-fail', role: 'alert' },
        h('h1', null, '插件加载失败 / this plugin failed to load'),
        h('p', null, '请重启 dsh web 后刷新页面。 / Restart dsh web, then reload.'),
        h('code', null, String(props.error && props.error.message ? props.error.message : props.error)),
      );
    }

    async function apply(ctx) {
      try {
        const [i18n, styles] = await Promise.all([chunk('client.i18n.js'), chunk('client.styles.js')]);
        const { zh, en } = i18n();
        const { css } = styles();

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'my-deploy: dictionaries');
        const t = ctx.locale.bind(NS);

        ctx.effect(() => {
          const style = document.createElement('style');
          style.setAttribute('data-my-deploy', '');
          style.textContent = css;
          document.head.appendChild(style);
          return () => style.remove();
        }, 'my-deploy: styles');

        const runtime = { React, h, NS, PANEL_ID, t, report };
        for (const file of CHUNKS) await extend(runtime, file);
        const page = (await chunk('client.page.js'))(runtime);

        /* Uncaught page errors and rejected promises join the same trail, so a
           broken chunk or a library error is readable without a console. */
        ctx.effect(() => {
          const onError = (event) => {
            const target = event && event.target;
            const where = target && typeof target.src === 'string' ? target.src : `${(event && event.filename) ?? ''}:${(event && event.lineno) ?? 0}`;
            report('window.error', String((event && event.message) || 'script error'), where);
          };
          const onRejection = (event) => {
            const reason = event && event.reason;
            report(
              'window.rejection',
              String(reason && reason.message ? reason.message : reason),
              reason && typeof reason.stack === 'string' ? reason.stack.slice(0, 2000) : '',
            );
          };
          window.addEventListener('error', onError);
          window.addEventListener('unhandledrejection', onRejection);
          return () => {
            window.removeEventListener('error', onError);
            window.removeEventListener('unhandledrejection', onRejection);
          };
        }, 'my-deploy: page reporters');

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 30,
              locale: NS,
              label: () => t('panel.label'),
            },
            runtime.PanelIcon,
          ),
        );

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              locale: NS,
            },
            page.Page,
          ),
        );
        report('apply.ok', 'plugin applied', `chunks=${CHUNKS.join(',')}`);
      } catch (error) {
        report('apply.failed', error instanceof Error ? error.message : String(error), error instanceof Error ? String(error.stack ?? '') : '');
        ctx.effect(() => {
          const style = document.createElement('style');
          style.setAttribute('data-my-deploy', '');
          style.textContent =
            '.dp-fail{display:flex;flex-direction:column;gap:10px;padding:32px clamp(20px,4vw,40px);color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.6}' +
            '.dp-fail h1{margin:0;font-size:18px;font-weight:500;line-height:26px}' +
            '.dp-fail code{color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;word-break:break-word}';
          document.head.appendChild(style);
          return () => style.remove();
        }, 'my-deploy: failure styles');
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, () => h(Failure, { error })),
        );
      }
    }

    return { apply, inject: ['slots', 'locale'] };
  },
});
