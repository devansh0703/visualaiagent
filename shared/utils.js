/**
 * Small shared utilities (ES module — used by background, UI and tests).
 * Content scripts get a standalone copy of the tiny helpers they need.
 */

export function uuid() {
  if (globalThis.crypto && globalThis.crypto.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  const b = [];
  for (let i = 0; i < 16; i++) b.push(((Math.random() * 0xff) | 0).toString(16).padStart(2, '0'));
  b[6] = ((+('0x' + b[6]) & 0x0f) | 0x40).toString(16);
  b[8] = ((+('0x' + b[8]) & 0x3f) | 0x80).toString(16);
  return `${b.slice(0, 4).join('')}-${b.slice(4, 6).join('')}-${b.slice(6, 8).join('')}-${b.slice(8, 10).join('')}-${b.slice(10, 16).join('')}`;
}

export const now = () => Date.now();

export function truncate(str, max, suffix = '…') {
  if (typeof str !== 'string') return str;
  if (str.length <= max) return str;
  return str.slice(0, Math.max(0, max - suffix.length)) + suffix;
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function round(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function throttle(fn, ms) {
  let last = 0;
  let trailing = null;
  return (...args) => {
    const elapsed = now() - last;
    if (elapsed >= ms) {
      last = now();
      trailing = null;
      return fn(...args);
    }
    trailing = args;
    clearTimeout(trailingTimer);
    trailingTimer = setTimeout(() => {
      if (trailing) {
        last = now();
        const a = trailing;
        trailing = null;
        fn(...a);
      }
    }, ms - elapsed);
  };
}
let trailingTimer = null;

export function throttleLeading(fn, ms) {
  let last = 0;
  return (...args) => {
    const t = now();
    if (t - last >= ms) {
      last = t;
      return fn(...args);
    }
  };
}

/** Base64-encode a Uint8Array / ArrayBuffer. */
export function bytesToBase64(bytes) {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}

/** Strip sensitive query params from a URL for logging. */
export function sanitizeUrl(raw, stripQuery = true) {
  try {
    const u = new URL(raw);
    if (stripQuery) u.search = '';
    u.username = '';
    u.password = '';
    return u.href;
  } catch {
    return String(raw).slice(0, 2048);
  }
}

/** Basic host normalization: google.com / sub.google.com */
export function hostOf(raw) {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function isURL(str) {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

export function safeJSON(str, fallback = null) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

export function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** Simple in-memory LRU used to dedupe bursts. */
export class LRUSet {
  constructor(limit = 500) {
    this.limit = limit;
    this.set = new Set();
  }
  has(k) {
    return this.set.has(k);
  }
  add(k) {
    this.set.add(k);
    if (this.set.size > this.limit) {
      const first = this.set.values().next().value;
      this.set.delete(first);
    }
  }
}
