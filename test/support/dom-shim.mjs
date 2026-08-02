/**
 * test/support/dom-shim.mjs — a tiny DOM shim sufficient for unit-testing
 * content/element-tools.js inside Node's `vm`.
 */
export function mkEl(tag, opts = {}) {
  const attrs = new Map(Object.entries(opts.attrs || {}));
  const node = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    textContent: opts.text ?? '',
    value: opts.value ?? '',
    style: { cursor: opts.cursor || '' },
    _children: opts.children || [],
    _parent: opts.parent || null,
    _rect: opts.rect || { x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 },
    _form: opts.form || null,
    _querySelector: opts.querySelector || null,
    _querySelectorAll: opts.querySelectorAll || null,
    classList: makeClassList(opts.classes || []),
  };
  node.getAttribute = (k) => (attrs.has(k) ? attrs.get(k) : null);
  node.hasAttribute = (k) => attrs.has(k);
  node.setAttribute = (k, v) => attrs.set(k, v);
  node.getBoundingClientRect = () => node._rect;
  node.click = () => {
    node._clicked = true;
  };
  node.focus = () => {};
  node.scrollIntoView = () => {
    node._scrolledIntoView = true;
  };
  node.dispatchEvent = (e) => {
    node._events = node._events || [];
    node._events.push(e);
  };
  Object.defineProperty(node, 'parentNode', { get: () => node._parent });
  Object.defineProperty(node, 'parentElement', { get: () => (node._parent && node._parent.nodeType === 1 ? node._parent : null) });
  Object.defineProperty(node, 'previousElementSibling', { get: () => node._prevSib || null });
  Object.defineProperty(node, 'children', { get: () => node._children });
  Object.defineProperty(node, 'form', { get: () => node._form });
  Object.defineProperty(node, 'querySelector', { get: () => node._querySelector || (() => null) });
  Object.defineProperty(node, 'querySelectorAll', { get: () => node._querySelectorAll || (() => []) });
  node.classList.contains = (c) => node.classList.includes(c);
  node.append = (c) => node._children.push(c);
  for (const c of node._children) c._parent = node;
  return node;
}

function makeClassList(classes) {
  const arr = [...classes];
  arr.forEach = Array.prototype.forEach;
  return arr;
}

export function makeDocument(htmlEl, opts = {}) {
  const doc = { documentElement: htmlEl, elementFromPoint: () => null };
  doc.querySelectorAll = opts.querySelectorAll || ((sel) => (String(sel).includes(',') ? [htmlEl] : []));
  doc.querySelector = opts.querySelector || (() => null);
  doc.body = opts.body || { innerText: '', textContent: '', scrollHeight: 0 };
  return doc;
}

/**
 * Build a document whose querySelectorAll routes known selectors to labelled
 * element arrays — enough for the agentAbility router unit tests.
 */
export function makeRoutedDoc(htmlEl, routes, bodyText = '') {
  const doc = makeDocument(htmlEl, {
    body: { innerText: bodyText, textContent: bodyText, scrollHeight: 1000 },
  });
  doc.querySelectorAll = (sel) => {
    for (const [pattern, els] of Object.entries(routes || {})) {
      if (String(sel).replace(/\s+/g, ' ').includes(pattern)) return els;
    }
    return [];
  };
  return doc;
}

export function sandboxWith(shims) {
  const sandbox = {
    document: shims.document,
    window: { innerWidth: 1200, innerHeight: 800, scrollY: 0 },
    location: { href: 'https://x.com/a?q=1', pathname: '/a', hash: '' },
    CSS: { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&') },
    console,
  };
  sandbox.globalThis = sandbox;
  return sandbox;
}
