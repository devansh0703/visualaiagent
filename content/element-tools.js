/**
 * element-tools.js — pure DOM/attribution helpers for the content script.
 *
 * Loaded BEFORE content.js as a classic script. Attaches to globalThis.VAIA.
 * No chrome APIs used — also unit-testable in Node via `vm`.
 */
(function (global) {
  'use strict';
  const VAIA = (global.VAIA = global.VAIA || {});
  const tools = (VAIA.tools = VAIA.tools || {});

  const TAG_BLACKLIST = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE', 'BR', 'WBR']);

  /** Get an element's viewport-relative bounding rect (scaled to device pixels irrelevant). */
  function elementRect(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') {
      return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
    }
    try {
      const r = el.getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        top: r.top,
        left: r.left,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      };
    } catch {
      return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
    }
  }

  function truncate(str, max = 120) {
    if (typeof str !== 'string') return str;
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
  }

  /** Keep at most `max` words and collapse whitespace. */
  function cleanText(str, max = 60) {
    if (typeof str !== 'string') return '';
    const t = str.replace(/\s+/g, ' ').trim();
    return truncate(t, max);
  }

  /** Get approximate accessibility role for an element. */
  function getRole(el) {
    if (!el || el.nodeType !== 1) return '';
    const aria = el.getAttribute && el.getAttribute('role');
    if (aria) return aria.toLowerCase();
    const tag = (el.tagName || '').toLowerCase();
    switch (tag) {
      case 'a': return el.hasAttribute('href') ? 'link' : 'anchor';
      case 'button': return 'button';
      case 'input':
        switch ((el.type || (el.getAttribute && el.getAttribute('type')) || 'text').toLowerCase()) {
          case 'checkbox': return 'checkbox';
          case 'radio': return 'radio';
          case 'range': return 'slider';
          case 'button': return 'button';
          case 'submit': return 'button';
          case 'reset': return 'button';
          case 'color': return 'colorwell';
          case 'number': return 'spinbutton';
          case 'password': return 'password';
          case 'search': return 'searchbox';
          default: return 'textbox';
        }
      case 'textarea': return 'textbox';
      case 'select': return 'combobox';
      case 'option': return 'option';
      case 'form': return 'form';
      case 'img': return 'image';
      case 'img' + '': return 'image';
      case 'nav': return 'navigation';
      case 'main': return 'main';
      case 'header': return 'banner';
      case 'footer': return 'contentinfo';
      case 'aside': return 'complementary';
      case 'section': return 'region';
      case 'article': return 'article';
      case 'li': return 'listitem';
      case 'ul': return 'list';
      case 'ol': return 'list';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      case 'dialog': return 'dialog';
      case 'details': return 'group';
      case 'summary': return 'button';
      case 'video': return 'video';
      case 'audio': return 'audio';
      case 'iframe': return 'iframe';
      case 'canvas': return 'canvas';
      case 'table': return 'table';
      case 'label': return 'label';
      case 'menu': case 'menubar': return 'menu';
      default: return '';
    }
  }

  const SENSITIVE_TYPES = new Set(['password', 'credit-card', 'ssn', 'cvv', 'cvc', 'card-number', 'token']);
  const SENSITIVE_ATTRS = [/^password$/i, /^pass$/, /credit.?card/i, /card.?number/i, /^cvv/i, /^cvc/i, /ssn/i, /social.?security/i, /secret/i, /token/i, /api.?key/i, /pin/i];

  function isSensitiveElement(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = (el.tagName || '').toLowerCase();
    const type = (el.getAttribute && el.getAttribute('type') || '').toLowerCase();
    if (tag === 'input' && type === 'password') return true;
    if (SENSITIVE_TYPES.has(type)) return true;
    const name = (el.getAttribute && el.getAttribute('name') || '').toLowerCase();
    const id = (el.getAttribute && el.getAttribute('id') || '').toLowerCase();
    const ariaLabel = (el.getAttribute && el.getAttribute('aria-label') || '').toLowerCase();
    const autocomplete = (el.getAttribute && el.getAttribute('autocomplete') || '').toLowerCase();
    const hay = `${name} ${id} ${ariaLabel} ${autocomplete} ${type}`;
    if (/password|current-password|new-password|one-time|otp|card|cvv|cvc|ssn/.test(hay)) return true;
    for (const re of SENSITIVE_ATTRS) if (re.test(hay)) return true;
    // context: a descendant of a <form autocomplete=off> styled like a login form with a password sibling
    if (tag === 'input') {
      const form = el.form;
      if (form && form.querySelector && form.querySelector('input[type=password]')) {
        const fname = (form.getAttribute('name') || '').toLowerCase();
        if (/login|signin|sign-in|auth|password|credit|card|payment/.test(fname)) return true;
      }
    }
    return false;
  }

  /** Mask obvious sensitive data patterns in arbitrary text (PII hygiene). */
  function sanitizeText(str) {
    if (typeof str !== 'string' || !str) return str;
    let s = str;
    s = s.replace(/\b\d{13,19}\b/g, '[CARD]'); // card numbers
    s = s.replace(/\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g, '[SSN]'); // SSN
    s = s.replace(/\b\d{9}\b/g, '[ID]'); // generic ids
    return s;
  }

  function getXPath(el) {
    if (!el || el.nodeType !== 1) return '';
    let node = el;
    const parts = [];
    let guard = 0;
    while (node && node.nodeType === 1 && guard++ < 30) {
      const tag = (node.nodeName || '').toLowerCase();
      if (node === document.documentElement || tag === 'html') {
        parts.unshift('/html');
        break;
      }
      if (node.getAttribute && node.getAttribute('id')) {
        parts.unshift(`//*[@id="${node.getAttribute('id').replace(/"/g, '\\"')}"]`);
        break;
      }
      let idx = 1;
      let sib = node.previousElementSibling;
      while (sib) {
        if (sib.tagName === node.tagName) idx++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(`${tag}[${idx}]`);
      node = node.parentNode;
    }
    return parts.join('/');
  }

  /** A best-effort unique CSS selector for the element. */
  function getCssSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    const escape = (s) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
    let node = el;
    const parts = [];
    let guard = 0;
    while (node && node.nodeType === 1 && guard++ < 8) {
      const tag = (node.tagName || '').toLowerCase();
      const nodeId = node.id || (node.getAttribute && node.getAttribute('id')) || '';
      if (nodeId) {
        parts.unshift('#' + escape(nodeId));
        break;
      }
      const parent = node.parentElement;
      const siblings = parent ? Array.from(parent.children).filter((c) => c.tagName === node.tagName) : [];
      let selector = tag;
      const classes = Array.from(node.classList || []).slice(0, 3);
      if (classes.length) selector += '.' + classes.map(escape).join('.');
      if (siblings.length > 1) {
        selector += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(selector);
      node = parent;
    }
    return parts.join(' > ');
  }

  /** Stable fingerprint of an element used to group repeated interactions. */
  function fingerprint(el) {
    if (!el || el.nodeType !== 1) return '';
    const tag = (el.tagName || '').toLowerCase();
    const id = (el.getAttribute && el.getAttribute('id')) || '';
    const cls = Array.from(el.classList || []).slice(0, 4).join('.');
    const text = cleanText(el.textContent || '', 24);
    const aria = (el.getAttribute && el.getAttribute('aria-label')) || '';
    const name = (el.getAttribute && el.getAttribute('name')) || '';
    const href = (el.getAttribute && el.getAttribute('href')) || '';
    return `${tag}#${id}.${cls}|${aria}|${name}|${text}|${href}`.slice(0, 300);
  }

  function getTextContent(el, max = 60) {
    if (!el) return '';
    if (el.nodeType === 3) return cleanText(el.nodeValue, max);
    if (el.nodeType !== 1) return '';
    const value = el.getAttribute && el.getAttribute('value');
    const placeholder = el.getAttribute && el.getAttribute('placeholder');
    const ariaLabel = el.getAttribute && el.getAttribute('aria-label');
    const title = el.getAttribute && el.getAttribute('title');
    const alt = el.getAttribute && el.getAttribute('alt');
    const label = el.getAttribute && el.getAttribute('data-label');
    // For inputs, prefer value/placeholder/label over child text
    if ((el.tagName || '').toLowerCase() === 'input' || (el.tagName || '').toLowerCase() === 'textarea') {
      const sensitive = isSensitiveElement(el);
      const v = value != null && !sensitive && value.length ? value : '';
      return cleanText([ariaLabel || label, placeholder, v, title, alt].filter(Boolean).join(' '), max);
    }
    const directText = cleanText(el.textContent, max);
    const meaningful = [ariaLabel || label, title, alt, directText].filter(Boolean).join(' ');
    return cleanText(meaningful, max);
  }

  /** Find the closest interactive ancestor (or self) for a clicked nested node. */
  function closestInteractive(el) {
    const INTERACTIVE = new Set(['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'LABEL', 'SUMMARY', 'DETAILS']);
    let node = el;
    let guard = 0;
    while (node && node.nodeType === 1 && guard++ < 12) {
      if (INTERACTIVE.has((node.tagName || '').toUpperCase())) return node;
      const role = node.getAttribute && node.getAttribute('role');
      if (role && /button|link|menuitem|tab|checkbox|radio|combobox|switch|textbox/.test(role)) return node;
      const style = node.nodeType === 1 && node.style;
      if (style && style.cursor === 'pointer') return node;
      node = node.parentNode;
    }
    return el && el.nodeType === 1 ? el : null;
  }

  /** Whether element (or interactive ancestor) has a native default action that matters. */
  function isLikelyInteractive(el) {
    const t = closestInteractive(el);
    if (!t) return false;
    const tag = (t.tagName || '').toLowerCase();
    if (['a', 'button', 'input', 'select', 'textarea', 'option', 'label'].includes(tag)) return true;
    if (t.getAttribute && /button|link|menuitem|tab|checkbox|radio|combobox|switch|textbox|slider/.test((t.getAttribute('role') || '').toLowerCase())) return true;
    if (t.style && t.style.cursor === 'pointer') return true;
    if (t.hasAttribute && t.hasAttribute('onclick')) return true;
    return false;
  }

  /** Shallow accessibility snapshot of the element (for AI context). */
  function a11yOf(el, maxDepth = 3) {
    const role = getRole(el);
    const name = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') ? '' : '')) || '';
    const props = {};
    if (el.hasAttribute && el.hasAttribute('aria-checked')) props.checked = el.getAttribute('aria-checked');
    if (el.hasAttribute && el.hasAttribute('aria-expanded')) props.expanded = el.getAttribute('aria-expanded');
    if (el.hasAttribute && el.hasAttribute('aria-selected')) props.selected = el.getAttribute('aria-selected');
    if (el.hasAttribute && el.hasAttribute('aria-current')) props.current = el.getAttribute('aria-current');
    if (el.hasAttribute && el.hasAttribute('disabled')) props.disabled = true;
    if (el.hasAttribute && el.hasAttribute('required')) props.required = true;
    if (el.hasAttribute && el.hasAttribute('aria-disabled')) props.disabled = el.getAttribute('aria-disabled') === 'true';
    const rect = elementRect(el);
    return {
      role,
      name: truncate(name, 60),
      label: truncate((el.getAttribute && el.getAttribute('aria-label')) || '', 60),
      props,
      rect: rect.width > 0 && rect.height > 0 ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } : null,
    };
  }

  /** Full descriptor of an element for telemetry. */
  function describeElement(el, opts = {}) {
    if (!el || el.nodeType !== 1) return null;
    const tag = (el.tagName || '').toLowerCase();
    const rect = elementRect(el);
    const interactive = closestInteractive(el);
    const target = opts.targetIsInteractive ? el : interactive || el;
    const role = getRole(target);
    const sensitive = isSensitiveElement(el) || isSensitiveElement(target);
    const isInput = (el.tagName || '').toLowerCase() === 'input' || (el.tagName || '').toLowerCase() === 'textarea';
    const d = {
      tag,
      role,
      id: (el.getAttribute && el.getAttribute('id')) || '',
      classes: Array.from(el.classList || []).slice(0, 8),
      name: (el.getAttribute && el.getAttribute('name')) || '',
      type: (el.getAttribute && el.getAttribute('type')) || '',
      href: tag === 'a' ? ((el.getAttribute && el.getAttribute('href')) || '') : '',
      value: opts.includeValue && !sensitive && isInput ? (el.value || '') : '',
      placeholder: (el.getAttribute && el.getAttribute('placeholder')) || '',
      ariaLabel: (el.getAttribute && el.getAttribute('aria-label')) || '',
      title: (el.getAttribute && el.getAttribute('title')) || '',
      text: sensitive ? '[REDACTED]' : truncate(cleanText(el.textContent), opts.textMax || 80),
      xpath: getXPath(target),
      cssSelector: getCssSelector(target),
      fingerprint: fingerprint(target),
      rect: rect.width > 0 || rect.height > 0 ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } : null,
      depth: domDepth(el),
      sensitive,
      interactive: isLikelyInteractive(target),
    };
    if (opts.a11y) d.a11y = a11yOf(target);
    return d;
  }

  function domDepth(el, max = 40) {
    let d = 0;
    let n = el;
    while (n && n.parentElement && d < max) {
      d++;
      n = n.parentElement;
    }
    return d;
  }

  function elementFromPoint(x, y) {
    if (typeof document === 'undefined' || !document.elementFromPoint) return null;
    try {
      return document.elementFromPoint(x, y);
    } catch {
      return null;
    }
  }

  /** Extract a compact list of interactive elements currently in the viewport (for AI). */
  function visibleInteractiveElements(max = 80) {
    if (typeof document === 'undefined') return [];
    if (typeof document.querySelectorAll !== 'function') return [];
    const out = [];
    const tags = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary']);
    let all;
    try {
      all = document.querySelectorAll('a,button,input,select,textarea,summary,[role="button"],[role="link"],[role="menuitem"],[role="tab"]');
    } catch {
      return [];
    }
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1200;
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
    let added = 0;
    for (const el of all) {
      if (added >= max) break;
      if (!tags.has((el.tagName || '').toLowerCase())) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.top > vh || r.bottom < 0 || r.left > vw || r.right < 0) continue;
      const hidden = getComputedStyle(el).visibility === 'hidden' || getComputedStyle(el).display === 'none';
      if (hidden) continue;
      const size = r.width * r.height;
      if (size < 25) continue;
      out.push({
        tag: (el.tagName || '').toLowerCase(),
        text: truncate(cleanText(el.textContent), 40) || (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder'))) || '',
        type: (el.getAttribute && el.getAttribute('type')) || '',
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      });
      added++;
    }
    return out;
  }

  /** Compact page summary for vision/scan requests. */
  function pageSummary(maxElements = 80) {
    if (typeof document === 'undefined') return { title: '', url: '', elements: [] };
    let text = '';
    try {
      text = document.body && document.body.innerText ? cleanText(document.body.innerText, 2000) : '';
    } catch {
      text = '';
    }
    return {
      title: document.title || '',
      url: (typeof location !== 'undefined' && location.href) || '',
      text,
      elements: visibleInteractiveElements(maxElements),
      viewport: { w: (window && window.innerWidth) || 0, h: (window && window.innerHeight) || 0 },
      scrollY: (window && window.scrollY) || 0,
      scrollHeight: (document.documentElement && document.documentElement.scrollHeight) || 0,
    };
  }

  Object.assign(tools, {
    elementRect,
    cleanText,
    truncate,
    getRole,
    isSensitiveElement,
    sanitizeText,
    getXPath,
    getCssSelector,
    fingerprint,
    getTextContent,
    closestInteractive,
    isLikelyInteractive,
    a11yOf,
    describeElement,
    domDepth,
    elementFromPoint,
    visibleInteractiveElements,
    pageSummary,
    TAG_BLACKLIST,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
