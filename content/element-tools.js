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

  /** Visible interactive DOM nodes (not descriptors) in document order. */
  function interactiveNodes(max = 80) {
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
      out.push(el);
      added++;
    }
    return out;
  }

  /** Extract a compact list of interactive elements currently in the viewport (for AI). */
  function visibleInteractiveElements(max = 80) {
    return interactiveNodes(max).map((el) => {
      const r = el.getBoundingClientRect();
      return {
        tag: (el.tagName || '').toLowerCase(),
        text: truncate(cleanText(el.textContent), 40) || (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder'))) || '',
        type: (el.getAttribute && el.getAttribute('type')) || '',
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      };
    });
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

  /**
   * Agent-grade DOM snapshot: every visible interactive element gets a stable
   * `ref` (el1..elN) in document order, plus page text, links and forms. The
   * same ordering is used by executeAgentAction() so refs round-trip.
   */
  function agentDigest(max = 40) {
    if (typeof document === 'undefined') return { title: '', url: '', elements: [], forms: [], links: { count: 0, top: [] } };
    let text = '';
    try {
      text = document.body && document.body.innerText ? cleanText(document.body.innerText, 3000) : '';
    } catch {
      text = '';
    }
    const nodes = interactiveNodes(max);
    const elements = nodes.map((n, i) => {
      const r = n.getBoundingClientRect();
      return {
        ref: 'el' + (i + 1),
        tag: (n.tagName || '').toLowerCase(),
        text: truncate(cleanText(n.textContent), 40) || (n.getAttribute && (n.getAttribute('aria-label') || n.getAttribute('placeholder'))) || '',
        type: (n.getAttribute && n.getAttribute('type')) || '',
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      };
    });
    const links = { count: 0, top: [] };
    const forms = [];
    try {
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      links.count = anchors.length;
      links.top = anchors.slice(0, 20).map((a) => ({ text: cleanText(a.textContent, 30), url: (a.getAttribute && a.getAttribute('href')) || '' }));
      for (const f of Array.from(document.querySelectorAll('form')).slice(0, 10)) {
        const fields = Array.from(f.querySelectorAll('input,textarea,select')).slice(0, 10).map((inp) => ({
          type: (inp.getAttribute && inp.getAttribute('type')) || 'text',
          name: (inp.getAttribute && inp.getAttribute('name')) || '',
          placeholder: (inp.getAttribute && inp.getAttribute('placeholder')) || '',
          id: (inp.getAttribute && inp.getAttribute('id')) || '',
          sensitive: isSensitiveElement(inp),
        }));
        forms.push({ action: (f.getAttribute && f.getAttribute('action')) || '', fields, fieldCount: fields.length });
      }
    } catch {}
    return {
      title: document.title || '',
      url: (typeof location !== 'undefined' && location.href) || '',
      text,
      elements,
      links,
      forms,
      tables: (document.querySelectorAll && document.querySelectorAll('table').length) || 0,
      viewport: { w: (window && window.innerWidth) || 0, h: (window && window.innerHeight) || 0 },
      scrollY: (window && window.scrollY) || 0,
      scrollHeight: (document.documentElement && document.documentElement.scrollHeight) || 0,
    };
  }

  /**
   * Execute a computer-use action against the current page. `ref` is an elN
   * identifier produced by agentDigest(); refs are resolved against a fresh
   * interactive-node snapshot (same ordering / same `max`), so the element
   * must still be visible.
   */
  function executeAgentAction(a, max = 40) {
    if (!a || !a.type) return { ok: false, error: 'no action type' };
    if (a.type === 'scroll') {
      const amount = (a.dir === 'up' ? -1 : 1) * Math.abs(a.amount || 400);
      try {
        if (typeof window !== 'undefined' && typeof window.scrollBy === 'function') {
          window.scrollBy({ top: amount, behavior: 'auto' });
        } else if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
          window.scrollTo(0, (window.scrollY || 0) + amount);
        }
      } catch (e) {
        return { ok: false, error: 'scroll failed: ' + e.message };
      }
      return { ok: true, type: 'scroll', amount, scrollY: (window && window.scrollY) || 0 };
    }
    if (a.type === 'wait') {
      return { ok: true, type: 'wait', ms: a.amount || 800 };
    }
    if (a.type === 'navigate') {
      if (a.text) {
        try {
          location.href = a.text;
        } catch {
          return { ok: false, error: 'could not navigate' };
        }
        return { ok: true, type: 'navigate', url: a.text, navigating: true };
      }
      return { ok: false, error: 'navigate needs a url' };
    }
    const els = interactiveNodes(max);
    const target = resolveAgentRef(a.ref, els);
    if (!target) return { ok: false, error: 'element no longer visible: ' + a.ref };
    if (a.type === 'click') {
      try {
        target.focus();
        target.click();
      } catch (e) {
        return { ok: false, error: 'click failed: ' + e.message };
      }
      return { ok: true, type: 'click', text: cleanText(target.textContent, 40) };
    }
    if (a.type === 'type') {
      try {
        target.focus();
        const proto = target.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(target, String(a.value || ''));
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (e) {
        return { ok: false, error: 'type failed: ' + e.message };
      }
      return { ok: true, type: 'type', length: String(a.value || '').length };
    }
    return { ok: false, error: 'unsupported action: ' + a.type };
  }

  function resolveAgentRef(ref, els) {
    const m = /^el(\d+)$/.exec(String(ref || ''));
    if (!m) return null;
    const idx = parseInt(m[1], 10) - 1;
    return (els && els[idx]) || null;
  }

  /* ================= agent ability router (DOM ops) ======================
   * Content-side counterpart of background/abilities.js. Every ability is a
   * pure DOM read or a guarded write. Background composes these into the
   * 30-ability agent skill set. All selectors are wrapped so missing DOM APIs
   * degrade to `[]` instead of throwing (also keeps vm unit tests simple).
   */
  function qsa(sel, root) {
    try {
      const r = root || document;
      if (typeof r.querySelectorAll !== 'function') return [];
      const list = r.querySelectorAll(sel);
      return Array.from(list || []);
    } catch {
      return [];
    }
  }

  function allFormControls() {
    return qsa('input,textarea,select');
  }

  /** Resolve either an elN ref (visible interactive) or an fN ref (any form control). */
  function resolveAnyRef(ref) {
    if (!ref) return null;
    const s = String(ref);
    if (/^el\d+$/.test(s)) return resolveAgentRef(s, interactiveNodes(80));
    const m = /^f(\d+)$/.exec(s);
    if (m) return allFormControls()[parseInt(m[1], 10) - 1] || null;
    return null;
  }

  function interactiveRefMap(max) {
    const m = new Map();
    interactiveNodes(max).forEach((el, i) => m.set(el, 'el' + (i + 1)));
    return m;
  }

  function pageText(max) {
    let t = '';
    try {
      t = document.body && document.body.innerText ? document.body.innerText : '';
    } catch {
      t = '';
    }
    return cleanText(t, max || 6000);
  }

  function fieldIndex(el) {
    return allFormControls().indexOf(el); // -1 if not a control
  }

  function fieldLabel(inp) {
    const id = inp.getAttribute && inp.getAttribute('id');
    if (id) {
      const lab = qsa('label[for="' + id.replace(/"/g, '\\"') + '"]')[0];
      if (lab) return cleanText(lab.textContent, 40);
    }
    const wrap = inp.closest ? inp.closest('label') : null;
    if (wrap) return cleanText(wrap.textContent, 40);
    const aria = inp.getAttribute && inp.getAttribute('aria-label');
    if (aria) return cleanText(aria, 40);
    const placeholder = inp.getAttribute && inp.getAttribute('placeholder');
    if (placeholder) return cleanText(placeholder, 40);
    return '';
  }

  function readForms() {
    const forms = [];
    for (const f of qsa('form')) {
      const fields = [];
      for (const inp of qsa('input,textarea,select', f)) {
        const sensitive = isSensitiveElement(inp);
        const isSelect = (inp.tagName || '').toLowerCase() === 'select';
        const field = {
          ref: 'f' + (fieldIndex(inp) + 1),
          tag: (inp.tagName || '').toLowerCase(),
          type: (inp.getAttribute && inp.getAttribute('type')) || 'text',
          name: (inp.getAttribute && inp.getAttribute('name')) || '',
          id: (inp.getAttribute && inp.getAttribute('id')) || '',
          placeholder: (inp.getAttribute && inp.getAttribute('placeholder')) || '',
          label: fieldLabel(inp),
          required: !!(inp.hasAttribute && inp.hasAttribute('required')),
          sensitive,
          value: sensitive ? '[REDACTED]' : String(inp.value || ''),
        };
        if (isSelect) field.options = qsa('option', inp).map((o) => (o && (o.getAttribute('value') || o.textContent)) || '');
        fields.push(field);
      }
      forms.push({
        index: forms.length,
        id: (f.getAttribute && f.getAttribute('id')) || '',
        action: (f.getAttribute && f.getAttribute('action')) || '',
        method: (f.method || 'get').toUpperCase(),
        fieldCount: fields.length,
        fields,
      });
    }
    return forms;
  }

  /** Set a form control's value (input/textarea/select/checkbox/radio) with events. */
  function setFieldValue(ref, value) {
    const el = resolveAnyRef(ref);
    if (!el) return { ok: false, error: 'no form control for ref ' + ref };
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'select') {
      let matched = false;
      for (const o of el.options || []) {
        if (String(o.value) === String(value) || String(o.text || '') === String(value)) {
          el.value = o.value;
          matched = true;
          break;
        }
      }
      if (!matched) el.value = String(value);
      if (typeof el.dispatchEvent === 'function') el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, type: 'select', ref, selected: el.value, options: (el.options && el.options.length) || 0 };
    }
    const ctype = (el.getAttribute && el.getAttribute('type') || '').toLowerCase();
    if (tag === 'input' && (ctype === 'checkbox' || ctype === 'radio')) {
      el.checked = typeof value === 'boolean' ? value : /^(true|1|on|yes|check)$/i.test(String(value));
      if (typeof el.dispatchEvent === 'function') el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, type: ctype, ref, checked: el.checked };
    }
    if (tag === 'input' || tag === 'textarea') {
      const proto = tag === 'textarea'
        ? (typeof HTMLTextAreaElement !== 'undefined' && HTMLTextAreaElement.prototype)
        : (typeof HTMLInputElement !== 'undefined' && HTMLInputElement.prototype);
      const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
      if (setter) setter.call(el, String(value == null ? '' : value));
      else el.value = String(value == null ? '' : value);
      if (typeof el.dispatchEvent === 'function') {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { ok: true, type: 'type', ref, length: String(value == null ? '' : value).length };
    }
    return { ok: false, error: 'not a form control: ' + ref };
  }

  function matchField(form, key) {
    if (/^f\d+$/.test(String(key))) return form.fields.find((f) => f.ref === key) || null;
    const k = String(key || '').toLowerCase();
    return (
      form.fields.find((f) => f.name && f.name.toLowerCase() === k) ||
      form.fields.find((f) => f.id && f.id.toLowerCase() === k) ||
      form.fields.find((f) => f.label && f.label.toLowerCase() === k) ||
      form.fields.find((f) => f.placeholder && f.placeholder.toLowerCase() === k) ||
      form.fields.find((f) => (f.name || f.id || '').toLowerCase().includes(k)) ||
      null
    );
  }

  function fillForm(args) {
    const formIndex = args && args.formIndex != null ? Number(args.formIndex) : 0;
    const data = (args && args.data) || {};
    const forms = readForms();
    const form = forms[formIndex] || null;
    if (!form) return { ok: false, error: 'no form found at index ' + formIndex, formCount: forms.length };
    const applied = [];
    const unmatched = [];
    for (const [key, value] of Object.entries(data)) {
      const target = matchField(form, key);
      if (!target) {
        unmatched.push(key);
        continue;
      }
      const r = setFieldValue(target.ref, value);
      if (r.ok) applied.push({ ref: target.ref, key, value: target.sensitive ? '[REDACTED]' : String(value).slice(0, 40) });
      else unmatched.push(key);
    }
    return { ok: true, formIndex: form.index, action: form.action, fieldCount: form.fields.length, applied, unmatched, filledCount: applied.length };
  }

  function submitForm(args) {
    let form = null;
    if (args && args.formIndex != null) form = qsa('form')[Number(args.formIndex)];
    else if (args && args.ref) {
      const el = resolveAnyRef(args.ref);
      form = el && el.form;
    } else form = qsa('form')[0];
    if (!form) return { ok: false, error: 'no form found' };
    const btn = qsa('button[type=submit],input[type=submit],button:not([type])', form)[0];
    if (btn) {
      if (typeof btn.focus === 'function') btn.focus();
      if (typeof btn.click === 'function') btn.click();
      return { ok: true, via: 'click', button: cleanText(btn.textContent, 20) || btn.value || 'submit' };
    }
    if (typeof form.requestSubmit === 'function') {
      form.requestSubmit();
      return { ok: true, via: 'requestSubmit' };
    }
    return { ok: false, error: 'form has no submit button' };
  }

  function clickElement(args) {
    const ref = args && args.ref;
    const text = args && args.text;
    let target = null;
    if (ref) target = resolveAnyRef(ref);
    else if (text) {
      const ql = String(text).toLowerCase();
      target =
        interactiveNodes(80).find((el) => {
          const hay = [el.textContent, el.getAttribute && el.getAttribute('placeholder'), el.getAttribute && el.getAttribute('aria-label'), el.getAttribute && el.getAttribute('name')].filter(Boolean).join(' | ').toLowerCase();
          return hay.includes(ql);
        }) || null;
    }
    if (!target) return { ok: false, error: 'no clickable element found' + (ref ? ' for ref ' + ref : text ? ' matching "' + text + '"' : '') };
    if (typeof target.focus === 'function') target.focus();
    if (typeof target.click === 'function') target.click();
    return { ok: true, tag: (target.tagName || '').toLowerCase(), text: cleanText(target.textContent, 40) };
  }

  function findElement(args) {
    const q = String((args && (args.text || args.query)) || '').trim();
    if (!q) return { ok: false, error: 'find_element needs text/query' };
    const ql = q.toLowerCase();
    const refMap = interactiveRefMap(80);
    const matches = [];
    for (const el of interactiveNodes(80)) {
      const hay = [el.textContent, el.getAttribute && el.getAttribute('placeholder'), el.getAttribute && el.getAttribute('aria-label'), el.getAttribute && el.getAttribute('name'), el.getAttribute && el.getAttribute('title')].filter(Boolean).join(' | ').toLowerCase();
      if (hay.includes(ql)) {
        const r = el.getBoundingClientRect();
        matches.push({
          ref: refMap.get(el),
          tag: (el.tagName || '').toLowerCase(),
          text: cleanText(el.textContent, 40),
          type: (el.getAttribute && el.getAttribute('type')) || '',
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        });
      }
    }
    return { ok: matches.length > 0, count: matches.length, matches: matches.slice(0, 8) };
  }

  function scrollPage(args) {
    const ref = args && args.ref;
    if (ref) {
      const el = resolveAnyRef(ref);
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ behavior: 'auto', block: 'center' });
        return { ok: true, scrolledTo: ref };
      }
      return { ok: false, error: 'no element for ref ' + ref };
    }
    const dir = (args && args.dir) || 'down';
    const amt = Math.abs(Number((args && args.amount) || 400));
    const delta = (dir === 'up' ? -1 : 1) * amt;
    try {
      if (typeof window !== 'undefined' && typeof window.scrollBy === 'function') {
        window.scrollBy({ top: delta, behavior: 'auto' });
      } else if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
        window.scrollTo(0, (window.scrollY || 0) + delta);
      } else {
        return { ok: false, error: 'no scrolling API available' };
      }
    } catch (e) {
      return { ok: false, error: 'scroll failed: ' + e.message };
    }
    return { ok: true, dir, amount: delta, scrollY: (window && window.scrollY) || 0 };
  }

  function navigatePage(args) {
    const url = (args && args.url) || '';
    if (!url) return { ok: false, error: 'navigate needs a url' };
    if (typeof location === 'undefined' || !location.href) return { ok: false, error: 'cannot navigate in this context' };
    try {
      location.href = url;
      return { ok: true, navigating: true, url };
    } catch (e) {
      return { ok: false, error: 'navigation failed: ' + e.message };
    }
  }

  /* --------------- precise input actions (CUA-style mouse/keyboard) -------- */

  function fireEvent(el, type, init) {
    if (!el || typeof el.dispatchEvent !== 'function') return null;
    let Ctor = typeof Event !== 'undefined' ? Event : null;
    if (/^pointer/.test(type)) Ctor = typeof PointerEvent !== 'undefined' ? PointerEvent : typeof MouseEvent !== 'undefined' ? MouseEvent : Ctor;
    else if (/^key/.test(type)) Ctor = typeof KeyboardEvent !== 'undefined' ? KeyboardEvent : Ctor;
    else if (/^focus|^blur/.test(type)) Ctor = typeof FocusEvent !== 'undefined' ? FocusEvent : Ctor;
    else Ctor = typeof MouseEvent !== 'undefined' ? MouseEvent : Ctor;
    let ev = null;
    try {
      ev = new Ctor(type, init || {});
    } catch {
      ev = { type };
    }
    try {
      el.dispatchEvent(ev);
    } catch {}
    return ev;
  }

  function resolveTarget(args) {
    const ref = args && args.ref;
    const text = args && args.text;
    if (ref) return resolveAnyRef(ref);
    if (text) {
      const ql = String(text).toLowerCase();
      return (
        interactiveNodes(80).find((el) => {
          const hay = [el.textContent, el.getAttribute && el.getAttribute('aria-label'), el.getAttribute && el.getAttribute('placeholder'), el.getAttribute && el.getAttribute('name')].filter(Boolean).join(' | ').toLowerCase();
          return hay.includes(ql);
        }) || null
      );
    }
    return null;
  }

  function hoverElement(args) {
    const target = resolveTarget(args);
    if (!target) return { ok: false, error: 'no element found to hover' };
    const r = target.getBoundingClientRect();
    const cx = Math.round(r.x + r.width / 2);
    const cy = Math.round(r.y + r.height / 2);
    const init = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 };
    ['pointerover', 'pointermove', 'mouseover', 'mouseenter', 'mousemove'].forEach((t) => fireEvent(target, t, init));
    return { ok: true, type: 'hover', x: cx, y: cy, text: cleanText(target.textContent, 40) };
  }

  function doubleClickElement(args) {
    const target = resolveTarget(args);
    if (!target) return { ok: false, error: 'no element found to double-click' };
    const r = target.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, clientX: Math.round(r.x + r.width / 2), clientY: Math.round(r.y + r.height / 2), button: 0 };
    fireEvent(target, 'pointerdown', init);
    fireEvent(target, 'mousedown', init);
    fireEvent(target, 'pointerup', init);
    fireEvent(target, 'mouseup', init);
    fireEvent(target, 'click', init);
    fireEvent(target, 'pointerdown', init);
    fireEvent(target, 'mousedown', init);
    fireEvent(target, 'pointerup', init);
    fireEvent(target, 'mouseup', init);
    fireEvent(target, 'click', init);
    fireEvent(target, 'dblclick', init);
    return { ok: true, type: 'double_click', text: cleanText(target.textContent, 40) };
  }

  function rightClickElement(args) {
    const target = resolveTarget(args);
    if (!target) return { ok: false, error: 'no element found to right-click' };
    const r = target.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, clientX: Math.round(r.x + r.width / 2), clientY: Math.round(r.y + r.height / 2), button: 2 };
    fireEvent(target, 'pointerdown', init);
    fireEvent(target, 'mousedown', init);
    fireEvent(target, 'pointerup', init);
    fireEvent(target, 'mouseup', init);
    fireEvent(target, 'contextmenu', init);
    return { ok: true, type: 'right_click', text: cleanText(target.textContent, 40) };
  }

  function keyPress(args) {
    const key = String((args && args.key) || '').trim();
    if (!key) return { ok: false, error: 'key_press needs a key (e.g. Enter, Escape, Tab, "a", ctrl+s)' };
    const target = (args && args.ref ? resolveAnyRef(args.ref) : null) || (typeof document !== 'undefined' && document.activeElement) || (typeof document !== 'undefined' ? document.body : null);
    if (!target) return { ok: false, error: 'no focused element to send keys to' };
    const init = {
      bubbles: true,
      cancelable: true,
      key,
      code: (args && args.code) || key,
      ctrlKey: !!(args && args.ctrl),
      altKey: !!(args && args.alt),
      shiftKey: !!(args && args.shift),
      metaKey: !!(args && args.meta),
    };
    fireEvent(target, 'keydown', init);
    fireEvent(target, 'keypress', init);
    fireEvent(target, 'keyup', init);
    return { ok: true, type: 'key_press', key, on: (target.tagName || '').toLowerCase() };
  }

  function dragElement(args) {
    const from = args && args.ref ? resolveAnyRef(args.ref) : null;
    if (!from) return { ok: false, error: 'drag needs a source ref' };
    const r = from.getBoundingClientRect();
    const x0 = Math.round(r.x + r.width / 2);
    const y0 = Math.round(r.y + r.height / 2);
    let x1 = x0;
    let y1 = y0;
    if (args.toRef) {
      const to = resolveAnyRef(args.toRef);
      if (!to) return { ok: false, error: 'no target element for toRef ' + args.toRef };
      const tr = to.getBoundingClientRect();
      x1 = Math.round(tr.x + tr.width / 2);
      y1 = Math.round(tr.y + tr.height / 2);
    } else if (args.toX != null && args.toY != null) {
      x1 = Number(args.toX);
      y1 = Number(args.toY);
    } else {
      x1 = x0 + (Number(args.dx) || 0);
      y1 = y0 + (Number(args.dy) || 0);
    }
    const pt = (x, y, button) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: button || 0 });
    fireEvent(from, 'pointerdown', pt(x0, y0, 0));
    fireEvent(from, 'mousedown', pt(x0, y0, 0));
    const steps = 4;
    for (let i = 1; i <= steps; i++) {
      const x = Math.round(x0 + ((x1 - x0) * i) / steps);
      const y = Math.round(y0 + ((y1 - y0) * i) / steps);
      const el = elementFromPoint(x, y) || from;
      fireEvent(el, 'pointermove', pt(x, y, 0));
      fireEvent(el, 'mousemove', pt(x, y, 0));
    }
    fireEvent(elementFromPoint(x1, y1) || from, 'pointerup', pt(x1, y1, 0));
    fireEvent(elementFromPoint(x1, y1) || from, 'mouseup', pt(x1, y1, 0));
    return { ok: true, type: 'drag', from: { x: x0, y: y0 }, to: { x: x1, y: y1 }, dx: x1 - x0, dy: y1 - y0 };
  }

  function focusElement(args) {
    const target = resolveTarget(args);
    if (!target) return { ok: false, error: 'no element found to focus' };
    if (typeof target.focus === 'function') target.focus();
    fireEvent(target, 'focusin', { bubbles: true });
    fireEvent(target, 'focus', { bubbles: false });
    return { ok: true, type: 'focus', tag: (target.tagName || '').toLowerCase(), text: cleanText(target.textContent, 40) };
  }

  function elementState(args) {
    const target = resolveTarget(args);
    if (!target) return { ok: false, error: 'no element found' };
    const r = target.getBoundingClientRect();
    let cs = null;
    if (typeof getComputedStyle === 'function') {
      try {
        cs = getComputedStyle(target);
      } catch {}
    }
    const vw = (window && window.innerWidth) || 1200;
    const vh = (window && window.innerHeight) || 800;
    const visible = r.width > 0 && r.height > 0 && r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0 && (!cs || (cs.visibility !== 'hidden' && cs.display !== 'none'));
    const tag = (target.tagName || '').toLowerCase();
    const ctype = (target.getAttribute && target.getAttribute('type')) || '';
    const sensitive = isSensitiveElement(target);
    return {
      ok: true,
      tag,
      type: ctype,
      visible,
      disabled: !!(target.disabled || (target.hasAttribute && target.hasAttribute('disabled'))),
      checked: tag === 'input' && (ctype === 'checkbox' || ctype === 'radio') ? !!target.checked : undefined,
      value: (tag === 'input' || tag === 'textarea') && !sensitive ? String(target.value || '') : undefined,
      text: cleanText(target.textContent, 40),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    };
  }

  /** Readability-style extraction of the page's main article content. */
  function readableContent() {
    let root = null;
    if (qsa('article').length) root = qsa('article')[0];
    else if (qsa('main').length) root = qsa('main')[0];
    else if (typeof document.querySelector === 'function') {
      try {
        root = document.querySelector('[role="main"]');
      } catch {}
    }
    if (!root) root = document.body;
    const seen = new Set();
    const lines = [];
    for (const p of qsa('p,h1,h2,h3,h4,h5,h6,li,blockquote,pre', root)) {
      const t = cleanText(p.textContent, 300);
      if (!t || seen.has(t)) continue;
      seen.add(t);
      lines.push(t);
    }
    const text = lines.join('\n');
    const words = text.split(/\s+/).filter(Boolean).length;
    return {
      ok: true,
      title: document.title || '',
      url: (typeof location !== 'undefined' && location.href) || '',
      wordCount: words,
      charCount: text.length,
      text: text.slice(0, 8000),
    };
  }

  async function clipboardRead() {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
      try {
        const text = await navigator.clipboard.readText();
        return { ok: true, text: String(text || ''), chars: String(text || '').length, source: 'clipboard-api' };
      } catch {}
    }
    return { ok: false, error: 'clipboard read unavailable (needs focus + permission in this context)' };
  }

  async function clipboardWrite(args) {
    const text = String((args && args.text) || '');
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(text);
        return { ok: true, chars: text.length, source: 'clipboard-api' };
      } catch {}
    }
    try {
      if (typeof document.createElement !== 'function' || typeof document.body === 'undefined') throw new Error('no dom');
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style = { position: 'fixed', left: '-9999px' };
      document.body.appendChild(ta);
      ta.select = () => {};
      const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
      document.body.removeChild(ta);
      if (ok) return { ok: true, chars: text.length, source: 'execCommand' };
    } catch {}
    return { ok: false, error: 'clipboard write unavailable in this context' };
  }

  function extractEntities(text) {
    const emails = new Set();
    const phones = new Set();
    const prices = new Set();
    const dates = new Set();
    const urls = new Set();
    const re = {
      email: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
      phone: /(?:\+\d[\d\s().-]{8,})|\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
      price: /\$\s?\d+(?:[.,]\d+)?|\b\d+(?:\.\d{2})?\s?(?:usd|eur|€|£)\b/g,
      date: /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s\d{1,2}(?:st|nd|rd|th)?,?\s\d{4}\b/g,
      url: /https?:\/\/[^\s<>"']+/g,
    };
    for (const m of String(text || '').matchAll(re.email)) emails.add(m[0]);
    for (const m of String(text || '').matchAll(re.phone)) phones.add(m[0].trim());
    for (const m of String(text || '').matchAll(re.price)) prices.add(m[0].trim());
    for (const m of String(text || '').matchAll(re.date)) dates.add(m[0].trim());
    for (const m of String(text || '').matchAll(re.url)) urls.add(m[0].replace(/[.,;:)]+$/, ''));
    return {
      emails: [...emails].slice(0, 20),
      phones: [...phones].slice(0, 20),
      prices: [...prices].slice(0, 20),
      dates: [...dates].slice(0, 20),
      urls: [...urls].slice(0, 20),
    };
  }

  function accessibilityAudit() {
    const issues = [];
    for (const img of qsa('img')) {
      if (!(img.hasAttribute && img.hasAttribute('alt'))) issues.push({ severity: 'medium', type: 'missing-alt', detail: '<img> without an alt attribute' });
      else if (img.getAttribute('alt') === '') issues.push({ severity: 'low', type: 'empty-alt', detail: 'decorative image with empty alt=""' });
    }
    for (const a of qsa('a')) {
      if (!(a.textContent || '').trim() && !(a.getAttribute && a.getAttribute('aria-label')) && !(a.getAttribute && a.getAttribute('title'))) {
        issues.push({ severity: 'medium', type: 'empty-link', detail: 'link with no accessible name' });
      }
    }
    for (const b of qsa('button')) {
      if (!(b.textContent || '').trim() && !(b.getAttribute && b.getAttribute('aria-label')) && !(b.getAttribute && b.getAttribute('title'))) {
        issues.push({ severity: 'medium', type: 'unnamed-button', detail: 'button with no accessible name' });
      }
    }
    for (const inp of qsa('input,textarea,select')) {
      const type = (inp.getAttribute && inp.getAttribute('type')) || '';
      if (type === 'hidden') continue;
      const id = inp.getAttribute && inp.getAttribute('id');
      const labeled = !!(inp.getAttribute && inp.getAttribute('aria-label')) || (id && qsa('label[for="' + id.replace(/"/g, '\\"') + '"]').length) || (inp.closest && inp.closest('label'));
      if (!labeled) issues.push({ severity: 'low', type: 'unlabeled-control', detail: (inp.getAttribute && (inp.getAttribute('name') || inp.getAttribute('id'))) || inp.tagName + ' has no label' });
    }
    if (document.documentElement && !(document.documentElement.getAttribute && document.documentElement.getAttribute('lang'))) {
      issues.push({ severity: 'low', type: 'missing-lang', detail: '<html> has no lang attribute' });
    }
    const heads = qsa('h1,h2,h3,h4,h5,h6').map((h) => +h.tagName[1]);
    for (let i = 1; i < heads.length; i++) {
      if (heads[i] > heads[i - 1] + 1) issues.push({ severity: 'low', type: 'heading-skip', detail: 'heading h' + heads[i - 1] + ' \u2192 h' + heads[i] + ' skips a level' });
    }
    return { count: issues.length, issues: issues.slice(0, 30) };
  }

  function pageMetadata() {
    const g = (sel, attr) => {
      const el = qsa(sel)[0];
      return el && el.getAttribute ? el.getAttribute(attr) || '' : '';
    };
    return {
      title: document.title || '',
      url: (typeof location !== 'undefined' && location.href) || '',
      description: g('meta[name="description"]', 'content'),
      ogTitle: g('meta[property="og:title"]', 'content'),
      ogImage: g('meta[property="og:image"]', 'content'),
      canonical: g('link[rel="canonical"]', 'href'),
      lang: (document.documentElement && document.documentElement.getAttribute && document.documentElement.getAttribute('lang')) || '',
      viewport: g('meta[name="viewport"]', 'content'),
    };
  }

  const ABILITY_ROUTER = {
    digest: (a) => agentDigest(a && a.max ? Number(a.max) : 40),
    text: (a) => {
      const t = pageText(a && a.max ? Number(a.max) : 6000);
      return { title: document.title || '', url: (typeof location !== 'undefined' && location.href) || '', chars: t.length, text: t };
    },
    links: () => {
      const refMap = interactiveRefMap(80);
      const anchors = qsa('a[href]');
      return {
        count: anchors.length,
        items: anchors.slice(0, 40).map((a) => ({
          ref: refMap.get(a) || null,
          text: cleanText(a.textContent, 40) || (a.getAttribute && a.getAttribute('aria-label')) || '',
          url: (a.getAttribute && a.getAttribute('href')) || '',
        })),
      };
    },
    tables: () => {
      const out = [];
      for (const t of qsa('table')) {
        const rows = [];
        for (const tr of qsa('tr', t)) {
          const cells = qsa('th,td', tr).map((c) => cleanText(c.textContent, 60));
          if (cells.length) rows.push(cells);
        }
        const cap = qsa('caption', t)[0];
        out.push({ caption: cap ? cleanText(cap.textContent, 60) : '', rowCount: rows.length, rows: rows.slice(0, 30) });
      }
      return { count: out.length, tables: out.slice(0, 8) };
    },
    forms: () => {
      const forms = readForms();
      return { count: forms.length, forms };
    },
    form_values: () => readForms(),
    headings: () => {
      const items = qsa('h1,h2,h3,h4,h5,h6').map((h) => ({ level: +h.tagName[1], text: cleanText(h.textContent, 80) }));
      return { count: items.length, items: items.slice(0, 40) };
    },
    entities: () => {
      const t = pageText(12000);
      return extractEntities(t);
    },
    metadata: () => pageMetadata(),
    accessibility: () => accessibilityAudit(),
    errors: () => {
      const log = (globalThis.VAIA && globalThis.VAIA.errorLog) || [];
      return { count: log.length, errors: log.slice(0, 20) };
    },
    viewport: () => ({
      w: (window && window.innerWidth) || 0,
      h: (window && window.innerHeight) || 0,
      scrollY: (window && window.scrollY) || 0,
      scrollHeight: (document.documentElement && document.documentElement.scrollHeight) || 0,
      docHeight: (document.body && document.body.scrollHeight) || 0,
    }),
    find_element: (a) => findElement(a),
    click: (a) => clickElement(a),
    type: (a) => (a && a.ref ? setFieldValue(a.ref, a.value) : { ok: false, error: 'type needs a ref' }),
    clear: (a) => (a && a.ref ? setFieldValue(a.ref, '') : { ok: false, error: 'clear needs a ref' }),
    select: (a) => (a && a.ref ? setFieldValue(a.ref, a.value) : { ok: false, error: 'select needs a ref' }),
    checkbox: (a) => (a && a.ref ? setFieldValue(a.ref, a.value) : { ok: false, error: 'checkbox needs a ref' }),
    scroll: (a) => scrollPage(a),
    navigate: (a) => navigatePage(a),
    fill_form: (a) => fillForm(a),
    submit_form: (a) => submitForm(a),
    hover: (a) => hoverElement(a),
    double_click: (a) => doubleClickElement(a),
    right_click: (a) => rightClickElement(a),
    key_press: (a) => keyPress(a),
    drag: (a) => dragElement(a),
    focus: (a) => focusElement(a),
    element_state: (a) => elementState(a),
    readable: () => readableContent(),
    clipboard_read: () => clipboardRead(),
    clipboard_write: (a) => clipboardWrite(a),
  };

  function normalizeAgentResult(r, ability) {
    if (r && typeof r === 'object' && !Array.isArray(r)) return { ...r, ok: r.ok !== false, ability };
    return { ok: !!r, ability, result: r };
  }

  /** Execute one DOM ability. Returns { ok, ability, ...result }, or a Promise of it. */
  function agentAbility(ability, args) {
    const fn = ABILITY_ROUTER[ability];
    if (!fn) return { ok: false, error: 'unknown ability: ' + ability, available: Object.keys(ABILITY_ROUTER) };
    try {
      const r = fn(args || {});
      if (r && typeof r.then === 'function') {
        return r.then((res) => normalizeAgentResult(res, ability)).catch((e) => ({ ok: false, error: e && e.message ? e.message : String(e), ability }));
      }
      return normalizeAgentResult(r, ability);
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e), ability };
    }
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
    agentDigest,
    executeAgentAction,
    interactiveNodes,
    agentAbility,
    resolveAnyRef,
    readForms,
    resolveTarget,
    elementState,
    readableContent,
    TAG_BLACKLIST,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
