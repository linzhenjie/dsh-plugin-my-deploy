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

    /** Every chunk after the dictionaries and the styles, in dependency order. */
    const CHUNKS = ['client.utils.js', 'client.model.js', 'client.data.js', 'client.ui.js'];

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

        const runtime = { React, h, NS, PANEL_ID, t };
        for (const file of CHUNKS) await extend(runtime, file);
        const page = (await chunk('client.page.js'))(runtime);

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
      } catch (error) {
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
