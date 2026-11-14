/**
 * Pure and browser helpers shared by every other chunk: text coercion, time and
 * size formatting, a chart path builder, and clipboard. No React, no state.
 */
window.__ModuleLoader__.load({
  id: 'my-deploy',
  chunk: 'client.utils.js',
  factory() {
    return () => {
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

      /** A stable id without requiring a secure context. */
      function createId() {
        try {
          if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
        } catch (error) {
          /* fall through to the time-based id */
        }
        return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      }

      /** Two-digit pad for clock parts. */
      function pad2(value) {
        return String(value).padStart(2, '0');
      }

      /** `HH:MM:SS` for a millisecond timestamp; empty for a missing one. */
      function formatClock(ms) {
        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
        const date = new Date(ms);
        return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
      }

      /** `YYYY-MM-DD HH:MM:SS`, the full date and time a trace row shows. */
      function formatDateTime(ms) {
        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
        const date = new Date(ms);
        return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
      }

      /** `MM-DD HH:MM:SS` for a millisecond timestamp, the long form a row shows. */
      function formatStamp(ms) {
        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
        const date = new Date(ms);
        return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
      }

      /** A byte count in the largest unit that keeps it readable. */
      function formatBytes(bytes) {
        const value = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0;
        if (value < 1024) return `${Math.round(value)} B`;
        const units = ['KiB', 'MiB', 'GiB', 'TiB'];
        let scaled = value / 1024;
        let index = 0;
        while (scaled >= 1024 && index < units.length - 1) {
          scaled /= 1024;
          index += 1;
        }
        return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1)} ${units[index]}`;
      }

      /** A number with a fixed digit count, never "NaN". */
      function formatNumber(value, digits) {
        const numeric = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(numeric)) return '0';
        return numeric.toFixed(typeof digits === 'number' ? digits : 2);
      }

      /** A duration in the unit that reads best: ms, s, or m. */
      function formatDuration(ms) {
        const value = typeof ms === 'number' && Number.isFinite(ms) ? ms : 0;
        if (value < 1) return `${Math.round(value * 1000)} µs`;
        if (value < 1000) return `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`;
        if (value < 60000) return `${(value / 1000).toFixed(2)} s`;
        return `${(value / 60000).toFixed(1)} min`;
      }

      /** Normalize a level token to one of the chips the page styles, or '' when unknown. */
      function levelOf(value) {
        const token = textOf(value).toLowerCase();
        if (token === 'err' || token === 'error' || token === 'fatal' || token === 'panic' || token === 'critical') return 'error';
        if (token === 'warn' || token === 'warning') return 'warn';
        if (token === 'debug' || token === 'trace') return 'debug';
        if (token === 'info' || token === 'notice') return 'info';
        return '';
      }

      /** The first `length` characters of an id, for a row label. */
      function shortId(value, length) {
        const text = textOf(value);
        return text.length <= length ? text : text.slice(0, length);
      }

      /** Copy through the async API, falling back to a selection copy when the
       *  clipboard API is unavailable (insecure context) or was denied. */
      async function copyText(value) {
        const text = typeof value === 'string' ? value : String(value ?? '');
        if (text === '') return false;
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(text);
            return true;
          }
        } catch (error) {
          /* permission or insecure context: fall through */
        }
        try {
          if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
          const area = document.createElement('textarea');
          area.value = text;
          area.setAttribute('readonly', '');
          area.style.position = 'fixed';
          area.style.top = '-1000px';
          area.style.opacity = '0';
          document.body.appendChild(area);
          area.select();
          const ok = document.execCommand('copy');
          area.remove();
          return ok === true;
        } catch (error) {
          return false;
        }
      }

      /** A clamped ratio in [0, 1] for a bar width. */
      function ratioOf(value, max) {
        const top = typeof max === 'number' && Number.isFinite(max) && max > 0 ? max : 0;
        const bottom = typeof value === 'number' && Number.isFinite(value) ? value : 0;
        if (top === 0) return 0;
        return Math.min(1, Math.max(0, bottom / top));
      }

      return {
        copyText,
        createId,
        formatBytes,
        formatClock,
        formatDateTime,
        formatDuration,
        formatNumber,
        formatStamp,
        isComposing,
        levelOf,
        messageOf,
        pad2,
        ratioOf,
        shortId,
        textOf,
      };
    };
  },
});
