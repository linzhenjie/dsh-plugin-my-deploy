/**
 * The stored state: its shape, its pure operations, and the browser mirror.
 *
 * A row is `{ id, title, url }` for a link, `{ id, text, done, createdAt }` for a
 * to-do, and `{ id, text }` for a note. Deleting a row does not remove it: the
 * same object gains `hidden: true` and `hiddenAt`, which is what the history
 * reads. Array order is the display order.
 *
 * Nothing here names a specific tab: every operation walks the state object's
 * own arrays, so a new tab needs no change in this file.
 */
window.__ModuleLoader__.load({
  id: 'my-deploy',
  chunk: 'client.model.js',
  factory() {
    return (runtime) => {
      const { CACHE_KEY, TAB_KEY, createId, hostOf, normalizeUrl, textOf } = runtime;

      /** Whether a row has been deleted into the history. */
      function isHidden(item) {
        return item.hidden === true;
      }

      /** Rows of one tab that are not in the history. */
      function visibleOf(state, tab) {
        return state[tab].filter((item) => !isHidden(item));
      }

      /** Every hidden row across all tabs, newest deletion first. */
      function historyOf(state) {
        const entries = [];
        for (const kind of Object.keys(state)) {
          if (kind === 'version') continue;
          for (const item of state[kind]) if (isHidden(item)) entries.push({ kind, item });
        }
        return entries.sort((left, right) => (right.item.hiddenAt ?? 0) - (left.item.hiddenAt ?? 0));
      }

      /** How many rows carry the hidden marker, used to detect a lossy Host echo. */
      function countHidden(state) {
        let count = 0;
        for (const kind of Object.keys(state)) {
          if (kind === 'version') continue;
          for (const item of state[kind]) if (isHidden(item)) count += 1;
        }
        return count;
      }

      /** Apply `transform` to every tab array, leaving `version` alone. */
      function mapTabs(state, transform) {
        const next = {};
        for (const kind of Object.keys(state)) {
          next[kind] = kind === 'version' ? state[kind] : transform(state[kind], kind);
        }
        return next;
      }

      /** Apply `patch` to the row with `id` in whichever tab holds it. */
      function updateItem(state, id, patch) {
        return mapTabs(state, (items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
      }

      /** Hide or restore rows by id; restoring drops the history markers. */
      function markHidden(state, ids, hidden) {
        const set = new Set(ids);
        return mapTabs(state, (items) =>
          items.map((item) => {
            if (!set.has(item.id)) return item;
            if (hidden) return { ...item, hiddenAt: Date.now(), hidden: true };
            const restored = { ...item };
            delete restored.hidden;
            delete restored.hiddenAt;
            return restored;
          }),
        );
      }

      /** Permanently remove rows by id. */
      function removeItems(state, ids) {
        const set = new Set(ids);
        return mapTabs(state, (items) => items.filter((item) => !set.has(item.id)));
      }

      /**
       * Reorder one tab to the given id order without disturbing rows outside it
       * (hidden rows, and rows a filter currently excludes): each listed id takes
       * an existing slot, so untouched rows keep their positions.
       */
      function applyOrder(state, tab, orderedIds) {
        const items = state[tab];
        const byId = new Map(items.map((item) => [item.id, item]));
        const listed = new Set(orderedIds.filter((id) => byId.has(id)));
        const slots = [];
        items.forEach((item, index) => {
          if (listed.has(item.id)) slots.push(index);
        });
        const next = items.slice();
        let cursor = 0;
        for (const id of orderedIds) {
          if (!listed.has(id)) continue;
          const slot = slots[cursor];
          cursor += 1;
          if (slot === undefined) break;
          next[slot] = byId.get(id);
        }
        return { ...state, [tab]: next };
      }

      /** The id order after dropping `sourceId` onto `targetId`, or null. */
      function moveBefore(order, sourceId, targetId) {
        const from = order.indexOf(sourceId);
        const to = order.indexOf(targetId);
        if (from < 0 || to < 0 || from === to) return null;
        const next = order.slice();
        next.splice(to, 0, next.splice(from, 1)[0]);
        return next;
      }

      /** The id order after moving one row by `delta` positions, or null. */
      function moveStep(order, id, delta) {
        const from = order.indexOf(id);
        if (from < 0) return null;
        const to = from + delta;
        if (to < 0 || to >= order.length) return null;
        const next = order.slice();
        next.splice(to, 0, next.splice(from, 1)[0]);
        return next;
      }

      /**
       * Turn one form draft into the row fields to write.
       * @returns the fields to write, or null when the draft is incomplete.
       */
      function payloadFor(tab, draft, existing) {
        if (tab === 'nav') {
          const title = String(draft.title ?? '').trim();
          const url = normalizeUrl(draft.url);
          if (title === '' || url === '') return null;
          return existing === null ? { id: createId(), title, url } : { title, url };
        }
        const text = String(draft.text ?? '').trim();
        if (text === '') return null;
        if (tab === 'todo') {
          if (existing !== null) return { text };
          return { createdAt: Date.now(), done: false, id: createId(), text };
        }
        return existing === null ? { id: createId(), text } : { text };
      }

      /** Drop rows that lost the fields their tab needs; the Host sanitizes again. */
      function normalizeItem(kind, raw) {
        if (raw === null || typeof raw !== 'object') return null;
        const id = textOf(raw.id) || createId();
        const retain = (item) => {
          if (raw.hidden !== true) return item;
          item.hidden = true;
          item.hiddenAt = typeof raw.hiddenAt === 'number' && Number.isFinite(raw.hiddenAt) ? raw.hiddenAt : Date.now();
          return item;
        };
        if (kind === 'nav') {
          const url = normalizeUrl(raw.url);
          if (url === '') return null;
          return retain({ id, title: textOf(raw.title).trim() || hostOf(url) || url, url });
        }
        const text = textOf(raw.text).trim();
        if (text === '') return null;
        if (kind === 'todo') {
          const item = { done: raw.done === true, id, text };
          item.createdAt = typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : 0;
          return retain(item);
        }
        return retain({ id, text });
      }

      /** Coerce any payload into the shape this plugin stores. */
      function normalizeState(raw) {
        const source = raw !== null && typeof raw === 'object' ? raw : {};
        const pick = (kind) =>
          Array.isArray(source[kind]) ? source[kind].map((item) => normalizeItem(kind, item)).filter(Boolean) : [];
        return { version: 1, nav: pick('nav'), note: pick('note'), todo: pick('todo') };
      }

      /** The state of a profile that has never written anything. */
      function emptyState() {
        return { version: 1, nav: [], note: [], todo: [] };
      }

      /** The last state the Host confirmed, for first paint and offline display. */
      function readCache() {
        try {
          const raw = window.localStorage.getItem(CACHE_KEY);
          return raw === null ? null : normalizeState(JSON.parse(raw));
        } catch (error) {
          return null;
        }
      }

      function writeCache(state) {
        try {
          window.localStorage.setItem(CACHE_KEY, JSON.stringify(state));
        } catch (error) {
          /* cache is optional: a blocked localStorage must not break the page */
        }
      }

      /** The last open tab, a pure UI preference. */
      function readTab(tabs) {
        try {
          const raw = window.localStorage.getItem(TAB_KEY);
          return tabs.includes(raw) ? raw : tabs[0];
        } catch (error) {
          return tabs[0];
        }
      }

      function writeTab(tab) {
        try {
          window.localStorage.setItem(TAB_KEY, tab);
        } catch (error) {
          /* see writeCache */
        }
      }

      return {
        applyOrder,
        countHidden,
        emptyState,
        historyOf,
        isHidden,
        mapTabs,
        markHidden,
        moveBefore,
        moveStep,
        normalizeState,
        payloadFor,
        readCache,
        readTab,
        removeItems,
        updateItem,
        visibleOf,
        writeCache,
        writeTab,
      };
    };
  },
});
