/**
 * privacy-scan.js — caches a WeakSet of sensitive DOM elements (password,
 * card, SSN, OTP fields) so hot paths (keystroke / input tracking) can check
 * sensitivity in O(1) instead of re-scanning attributes on every event.
 */
(function (global) {
  'use strict';
  const VAIA = (global.VAIA = global.VAIA || {});
  const privacy = (VAIA.privacy = VAIA.privacy || {});
  const sensitive = new WeakSet();

  function scan() {
    if (typeof document === 'undefined') return 0;
    let count = 0;
    const inputs = document.querySelectorAll('input,textarea');
    for (const el of inputs) {
      const isSensitive =
        VAIA.tools && VAIA.tools.isSensitiveElement ? VAIA.tools.isSensitiveElement(el) : false;
      if (isSensitive) {
        if (!sensitive.has(el)) count++;
        sensitive.add(el);
      }
    }
    return count;
  }

  let timer = null;
  function start(intervalMs = 4000) {
    scan();
    if (timer) return;
    timer = setInterval(scan, intervalMs);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', scan, { once: true });
    }
  }
  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  privacy.isSensitive = (el) => (el ? sensitive.has(el) : false);
  privacy.scan = scan;
  privacy.start = start;
  privacy.stop = stop;
})(typeof globalThis !== 'undefined' ? globalThis : this);
