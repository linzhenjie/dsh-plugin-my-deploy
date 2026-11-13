/**
 * Pure and browser helpers shared by every other chunk: ids, URLs, text
 * coercion, time formatting, clipboard, and row labels. No React, no state.
 */
window.__ModuleLoader__.load({
  id: 'my-deploy',
  chunk: 'client.utils.js',
  factory() {
    return () => {
      /** Stable-enough id without depending on a secure-context crypto API. */
      function createId() {
        try {
          if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
        } catch (error) {
          /* fall through to the time-based id */
        }
        return `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      }

      /** Accept a bare host as an https URL; keep any explicit scheme. */
      function normalizeUrl(value) {
        const raw = String(value ?? '').trim();
        if (raw === '') return '';
        return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) ? raw : `https://${raw}`;
      }

      /** Host used as a link title when the row has no title of its own. */
      function hostOf(url) {
        try {
          return new URL(url).host;
        } catch (error) {
          return '';
        }
      }

      /** Coerce an unknown value to a string without "undefined"/"null" leaks. */
      function textOf(value) {
        return typeof value === 'string' ? value : '';
      }

      /** A readable one-liner for an Error or any thrown value. */
      function messageOf(error) {
        const text = error instanceof Error ? error.message : String(error);
        return text === '' ? 'unknown error' : text;
      }

      /** An Enter inside an IME composition must never submit. */
      function isComposing(event) {
        const native = event.nativeEvent;
        return native !== undefined && (native.isComposing === true || native.keyCode === 229);
      }

      /** Two-digit pad for clock and calendar parts. */
      function pad2(value) {
        return String(value).padStart(2, '0');
      }

      /**
       * Format a creation timestamp for a row's trailing slot: today `HH:mm`,
       * this year `MM-DD HH:mm`, older the full date.
       */
      function formatStamp(ms) {
        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
        const date = new Date(ms);
        const now = new Date();
        const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
        if (date.getFullYear() === now.getFullYear()) {
          if (date.getMonth() === now.getMonth() && date.getDate() === now.getDate()) return clock;
          return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${clock}`;
        }
        return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
      }

      /** The row text a copy action puts on the clipboard. */
      function copyValue(kind, item) {
        return kind === 'nav' ? item.url : item.text;
      }

      /** The one-line label a row shows for itself. */
      function labelOf(kind, item) {
        return kind === 'nav' ? item.title : item.text;
      }

      /** The copy verb for a row kind: links copy their address, rows their text. */
      function copyActionLabel(kind) {
        return kind === 'nav' ? 'copy.link' : 'copy';
      }

      /** Copy through the async API, falling back to a selection copy. */
      async function copyText(value) {
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(value);
            return true;
          }
        } catch (error) {
          /* permission or insecure context: fall through */
        }
        try {
          const area = document.createElement('textarea');
          area.value = value;
          area.setAttribute('readonly', '');
          area.style.position = 'fixed';
          area.style.top = '0';
          area.style.opacity = '0';
          document.body.appendChild(area);
          area.select();
          const done = typeof document.execCommand === 'function' && document.execCommand('copy');
          area.remove();
          return done === true;
        } catch (error) {
          return false;
        }
      }

      return {
        copyActionLabel,
        copyText,
        copyValue,
        createId,
        formatStamp,
        hostOf,
        isComposing,
        labelOf,
        messageOf,
        normalizeUrl,
        textOf,
      };
    };
  },
});
