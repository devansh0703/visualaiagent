/**
 * test/unit/abilities.test.mjs — the 73-ability registry (background) and the
 * content-side DOM router that backs it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { mkEl, makeRoutedDoc, sandboxWith } from '../support/dom-shim.mjs';
import * as abilities from '../../background/abilities.js';

const code = readFileSync(fileURLToPath(new URL('../../content/element-tools.js', import.meta.url)), 'utf8');

/* ------------------------- element-tools router --------------------------- */

function loadTools(routes, opts = {}) {
  const html = mkEl('html', { attrs: { lang: opts.lang || '' } });
  const doc = makeRoutedDoc(html, routes, opts.text || '');
  const sandbox = sandboxWith({ document: doc });
  sandbox.getComputedStyle = () => ({ visibility: 'visible', display: 'block' });
  sandbox.HTMLInputElement = function () {};
  sandbox.HTMLInputElement.prototype = {};
  sandbox.HTMLTextAreaElement = function () {};
  sandbox.HTMLTextAreaElement.prototype = {};
  sandbox.Event = class Event {
    constructor(type) {
      this.type = type;
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'element-tools.js' });
  return sandbox.VAIA.tools;
}

function buildFormFixture() {
  const html = mkEl('html');
  const form = mkEl('form', { attrs: { action: '/submit', id: 'main' } });
  const email = mkEl('input', { attrs: { type: 'email', name: 'email' }, parent: form });
  const first = mkEl('input', { attrs: { type: 'text', name: 'first' }, parent: form });
  const country = mkEl('select', { attrs: { name: 'country' }, parent: form });
  const o1 = mkEl('option', { attrs: { value: 'us' }, text: 'United States', parent: country });
  const o2 = mkEl('option', { attrs: { value: 'in' }, text: 'India', parent: country });
  country._querySelectorAll = (sel) => (sel.includes('option') ? [o1, o2] : []);
  const agree = mkEl('input', { attrs: { type: 'checkbox', name: 'agree' }, parent: form });
  const submit = mkEl('button', { attrs: { type: 'submit' }, text: 'Go', parent: form });
  form._querySelectorAll = (sel) => {
    if (sel.includes('option')) return [o1, o2];
    if (sel.includes('input,textarea,select')) return [email, first, country, agree];
    if (sel.includes('button')) return [submit];
    return [];
  };
  const buttons = [submit, mkEl('button', { text: 'Secondary', parent: html })];
  const interactive = [email, first, country, agree, submit, buttons[1]];
  const routes = {
    'a,button,input,select,textarea,summary': interactive,
    'input,textarea,select': [email, first, country, agree],
    form: [form],
    'button[type=submit],input[type=submit],button:not([type])': [submit],
    'a[href]': [],
    'img': [],
    'label[for=': [],
  };
  return { html, form, email, first, country, o1, o2, agree, submit, buttons, interactive, routes };
}

test('forms ability exposes fN refs with field metadata', () => {
  const fx = buildFormFixture();
  const tools = loadTools(fx.routes);
  const res = tools.agentAbility('forms', {});
  assert.equal(res.ok, true);
  assert.equal(res.count, 1);
  const f = res.forms[0];
  assert.equal(f.id, 'main');
  assert.equal(f.action, '/submit');
  assert.equal(f.fields.length, 4);
  assert.equal(f.fields[0].ref, 'f1');
  assert.equal(f.fields[0].type, 'email');
  assert.equal(f.fields[0].name, 'email');
  assert.equal(f.fields[1].ref, 'f2');
  assert.equal(f.fields[2].ref, 'f3');
  assert.equal(f.fields[2].tag, 'select');
  assert.ok(Array.isArray(f.fields[2].options) && f.fields[2].options.includes('us'));
  assert.equal(f.fields[3].ref, 'f4');
});

test('fill_form applies values to matched fields and reports unmatched', () => {
  const fx = buildFormFixture();
  const tools = loadTools(fx.routes);
  const res = tools.agentAbility('fill_form', { formIndex: 0, data: { email: 'a@b.com', first: 'Ada', nope: 'x' } });
  assert.equal(res.ok, true);
  assert.equal(res.filledCount, 2);
  assert.equal(res.unmatched.join(','), 'nope');
  assert.equal(fx.email.value, 'a@b.com');
  assert.equal(fx.first.value, 'Ada');
});

test('type_text / select_option / toggle_checkbox write through fN refs', () => {
  const fx = buildFormFixture();
  const tools = loadTools(fx.routes);
  assert.equal(tools.agentAbility('type', { ref: 'f1', value: 'x@y.z' }).ok, true);
  assert.equal(fx.email.value, 'x@y.z');
  const sel = tools.agentAbility('select', { ref: 'f3', value: 'in' });
  assert.equal(sel.ok, true);
  assert.equal(fx.country.value, 'in');
  const chk = tools.agentAbility('checkbox', { ref: 'f4', value: true });
  assert.equal(chk.ok, true);
  assert.equal(fx.agree.checked, true);
  const cleared = tools.agentAbility('clear', { ref: 'f1' });
  assert.equal(cleared.ok, true);
  assert.equal(fx.email.value, '');
});

test('click_element matches by visible label text', () => {
  const fx = buildFormFixture();
  const tools = loadTools(fx.routes);
  const res = tools.agentAbility('click', { text: 'secondary' });
  assert.equal(res.ok, true);
  assert.equal(fx.buttons[1]._clicked, true);
});

test('find_element returns ref + rect for a matching element', () => {
  const fx = buildFormFixture();
  const tools = loadTools(fx.routes);
  const res = tools.agentAbility('find_element', { text: 'country' });
  assert.equal(res.ok, true);
  assert.equal(res.count, 1);
  assert.equal(res.matches[0].ref, 'el3');
  assert.equal(res.matches[0].tag, 'select');
});

test('read abilities return structured data', () => {
  const links = [mkEl('a', { attrs: { href: '/about' }, text: 'About' })];
  const imgs = [mkEl('img')];
  const heading = mkEl('h1', { text: 'Hello' });
  const routes = {
    'a,button,input,select,textarea,summary': [],
    'input,textarea,select': [],
    'a[href]': links,
    img: imgs,
    'h1,h2,h3,h4,h5,h6': [heading],
    form: [],
    'label[for=': [],
    'table': [],
    'tr': [],
    'th,td': [],
    'caption': [],
    'meta[name="viewport"]': [],
    'link[rel="canonical"]': [],
    'meta[name="description"]': [],
  };
  const tools = loadTools(routes, { text: 'hello a@b.com · $5.99 · (555) 010-1234 · https://x.io/p · 2026-01-01' });
  const linksRes = tools.agentAbility('links', {});
  assert.equal(linksRes.count, 1);
  assert.equal(linksRes.items[0].url, '/about');
  const heads = tools.agentAbility('headings', {});
  assert.equal(heads.count, 1);
  assert.equal(heads.items[0].text, 'Hello');
  const ents = tools.agentAbility('entities', {});
  assert.ok(ents.emails.includes('a@b.com'));
  assert.ok(ents.prices.some((p) => p.includes('5.99')));
  assert.ok(ents.urls.includes('https://x.io/p'));
  const a11y = tools.agentAbility('accessibility', {});
  assert.equal(a11y.ok, true);
  assert.ok(a11y.issues.some((i) => i.type === 'missing-alt'));
  const vp = tools.agentAbility('viewport', {});
  assert.equal(vp.w, 1200);
});

test('agentAbility rejects unknown abilities', () => {
  const tools = loadTools({});
  const res = tools.agentAbility('does_not_exist', {});
  assert.equal(res.ok, false);
  assert.match(res.error, /unknown ability/);
  assert.ok(Array.isArray(res.available));
});

test('hover / double_click / right_click / focus fire the right events on the target', () => {
  const fx = buildFormFixture();
  const tools = loadTools(fx.routes);
  const btn = fx.buttons[1];
  assert.equal(tools.agentAbility('hover', { text: 'secondary' }).ok, true);
  assert.ok(btn._events.some((e) => e.type === 'mouseover'));
  assert.equal(tools.agentAbility('double_click', { text: 'secondary' }).ok, true);
  assert.ok(btn._events.some((e) => e.type === 'dblclick'));
  assert.equal(tools.agentAbility('right_click', { text: 'secondary' }).ok, true);
  assert.ok(btn._events.some((e) => e.type === 'contextmenu' && e.button === 2));
  assert.equal(tools.agentAbility('focus', { text: 'secondary' }).ok, true);
  assert.ok(btn._events.some((e) => e.type === 'focusin'));
});

test('key_press sends keydown/keypress/keyup to the ref target', () => {
  const fx = buildFormFixture();
  const tools = loadTools(fx.routes);
  const res = tools.agentAbility('key_press', { ref: 'f1', key: 'Enter' });
  assert.equal(res.ok, true);
  assert.ok(fx.email._events.some((e) => e.type === 'keydown' && e.key === 'Enter'));
  assert.ok(fx.email._events.some((e) => e.type === 'keyup' && e.key === 'Enter'));
});

test('drag_element dispatches pointer/mouse sequence from the source ref', () => {
  const fx = buildFormFixture();
  const tools = loadTools(fx.routes);
  const res = tools.agentAbility('drag', { ref: 'el6', dx: 50, dy: 30 });
  assert.equal(res.ok, true);
  assert.equal(res.dx, 50);
  assert.equal(res.dy, 30);
  assert.ok(fx.buttons[1]._events.some((e) => e.type === 'pointerdown'));
  assert.ok(fx.buttons[1]._events.some((e) => e.type === 'pointerup'));
});

test('element_state reports visibility, tag and rect for a ref', () => {
  const fx = buildFormFixture();
  const tools = loadTools(fx.routes);
  const res = tools.agentAbility('element_state', { ref: 'el6' });
  assert.equal(res.ok, true);
  assert.equal(res.tag, 'button');
  assert.equal(res.visible, true);
  assert.equal(res.text, 'Secondary');
  assert.ok(res.rect && res.rect.w > 0);
});

test('readable extracts the article content into plain text', () => {
  const p1 = mkEl('p', { text: 'First paragraph text.' });
  const p2 = mkEl('p', { text: 'Second paragraph text.' });
  const article = mkEl('article', { querySelectorAll: (sel) => (sel.includes('p') ? [p1, p2] : []) });
  const tools = loadTools({ article: [article], 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre': [p1, p2] });
  const res = tools.agentAbility('readable', {});
  assert.equal(res.ok, true);
  assert.equal(res.wordCount, 6);
  assert.match(res.text, /First paragraph text\./);
});

test('clipboard_write / clipboard_read round-trip through navigator.clipboard', async () => {
  const fx = buildFormFixture();
  const tools = loadTools(fx.routes);
  const wrote = await tools.agentAbility('clipboard_write', { text: 'hello world' });
  assert.equal(wrote.ok, true);
  assert.equal(wrote.source, 'clipboard-api');
  const read = await tools.agentAbility('clipboard_read', {});
  assert.equal(read.ok, true);
  assert.equal(read.text, 'hello world');
});

test('middle_click fires auxclick with button 1', () => {
  const fx = buildFormFixture();
  const tools = loadTools(fx.routes);
  const res = tools.agentAbility('middle_click', { text: 'secondary' });
  assert.equal(res.ok, true);
  assert.equal(res.type, 'middle_click');
  assert.ok(fx.buttons[1]._events.some((e) => e.type === 'auxclick' && e.button === 1));
});

test('triple_click fires three click sequences plus dblclicks', () => {
  const fx = buildFormFixture();
  const tools = loadTools(fx.routes);
  const res = tools.agentAbility('triple_click', { text: 'secondary' });
  assert.equal(res.ok, true);
  const clicks = fx.buttons[1]._events.filter((e) => e.type === 'click').length;
  assert.equal(clicks, 3);
  assert.equal(fx.buttons[1]._events.filter((e) => e.type === 'dblclick').length, 2);
});

test('mouse_button presses and releases a button', () => {
  const fx = buildFormFixture();
  const tools = loadTools(fx.routes);
  const down = tools.agentAbility('mouse_button', { ref: 'el6', button: 'left', state: 'down' });
  assert.equal(down.ok, true);
  assert.ok(fx.buttons[1]._events.some((e) => e.type === 'mousedown'));
  const up = tools.agentAbility('mouse_button', { ref: 'el6', button: 'right', state: 'up' });
  assert.equal(up.ok, true);
  assert.ok(fx.buttons[1]._events.some((e) => e.type === 'mouseup' && e.button === 2));
  const bad = tools.agentAbility('mouse_button', { ref: 'el6', state: 'sideways' });
  assert.equal(bad.ok, false);
});

test('hold_key holds keydown for the duration then releases', async () => {
  const fx = buildFormFixture();
  const tools = loadTools(fx.routes);
  const res = await tools.agentAbility('hold_key', { ref: 'f1', key: 'Shift', seconds: 0.01 });
  assert.equal(res.ok, true);
  assert.ok(fx.email._events.some((e) => e.type === 'keydown' && e.key === 'Shift'));
  assert.ok(fx.email._events.some((e) => e.type === 'keyup' && e.key === 'Shift'));
  assert.ok(res.elapsedMs >= 5);
});

test('edit_page replaces text on the live page', () => {
  const h1 = mkEl('h1', { text: 'Old Title' });
  const tools = loadTools({ 'a,button,input,select,textarea,summary,[contenteditable],h1,h2,h3,h4,h5,h6,p,li,label,span,div,code,blockquote,td,th': [h1] });
  const res = tools.agentAbility('edit_page', { text: 'old title', value: 'New Title' });
  assert.equal(res.ok, true);
  assert.equal(res.tag, 'h1');
  assert.equal(res.before, 'Old Title');
  assert.equal(res.after, 'New Title');
  assert.equal(h1.textContent, 'New Title');
});

test('edit_page writes through to input values', () => {
  const fx = buildFormFixture();
  const tools = loadTools(fx.routes);
  const res = tools.agentAbility('edit_page', { ref: 'f1', value: 'edited@example.com' });
  assert.equal(res.ok, true);
  assert.equal(fx.email.value, 'edited@example.com');
});

test('run_js executes code in the page and returns the serialized value', () => {
  const fx = buildFormFixture();
  const tools = loadTools(fx.routes);
  const res = tools.agentAbility('run_js', { code: 'return { a: 1, b: [1,2] }' });
  assert.equal(res.ok, true);
  assert.equal(res.type, 'object');
  assert.equal(res.result, '{"a":1,"b":[1,2]}');
  const scalar = tools.agentAbility('run_js', { code: 'return 40 + 2' });
  assert.equal(scalar.result, '42');
  const noop = tools.agentAbility('run_js', { code: '' });
  assert.equal(noop.ok, false);
});

/* --------------------------- background registry -------------------------- */

function mockCtx(domImpl) {
  return {
    tabId: 1,
    config: { vision: { provider: 'mock' } },
    session: { id: 's1' },
    isMock: () => true,
    dom: async (ability, args) => (domImpl[ability] ? domImpl[ability](args) : { ok: false, error: 'no impl: ' + ability }),
    capture: async () => null,
  };
}

test('registry exposes 73 abilities across 4 categories', () => {
  const list = abilities.listAbilities();
  assert.equal(list.length, 73);
  const cats = new Set(list.map((a) => a.category));
  assert.deepEqual([...cats].sort(), ['agent', 'meta', 'read', 'write']);
  assert.ok(list.every((a) => a.id && a.name && a.description && Array.isArray(a.args)));
});

test('fill_form auto-generates values and fills the form', async () => {
  const form = {
    index: 0,
    action: '/submit',
    fields: [
      { ref: 'f1', name: 'email', type: 'email', sensitive: false, value: '' },
      { ref: 'f2', name: 'first', type: 'text', sensitive: false, value: '' },
      { ref: 'f3', name: 'password', type: 'password', sensitive: true, value: '[REDACTED]' },
    ],
  };
  const ctx = mockCtx({
    forms: () => ({ ok: true, forms: [form] }),
    fill_form: (args) => ({ ok: true, applied: args.data.f1 ? [{ ref: 'f1', key: 'f1', value: 'test@example.com' }] : [], unmatched: [], filledCount: Object.keys(args.data).length }),
  });
  const res = await abilities.runAbility('fill_form', ctx, {});
  assert.equal(res.ok, true);
  assert.equal(res.generated, true);
  assert.equal(res.form.fieldCount, 3);
});

test('fill_form uses provided data instead of generating', async () => {
  const form = { index: 0, fields: [{ ref: 'f1', name: 'email', type: 'email', sensitive: false, value: '' }] };
  let seen = null;
  const ctx = mockCtx({
    forms: () => ({ ok: true, forms: [form] }),
    fill_form: (args) => {
      seen = args.data;
      return { ok: true, applied: [], unmatched: [], filledCount: 0 };
    },
  });
  await abilities.runAbility('fill_form', ctx, { data: { email: 'me@here.dev' } });
  assert.equal(seen.email, 'me@here.dev');
});

test('page_summarize returns a mock summary offline', async () => {
  const ctx = mockCtx({ text: () => ({ ok: true, text: 'First sentence. Second sentence. Third one.' }) });
  const res = await abilities.runAbility('page_summarize', ctx, {});
  assert.equal(res.ok, true);
  assert.equal(res.provider, 'mock');
  assert.match(res.summary, /First sentence/);
});

test('task_plan produces steps for a goal', async () => {
  const ctx = mockCtx({
    digest: () => ({ ok: true, elements: [{ ref: 'el1', tag: 'button', text: 'Submit' }], forms: [{ fields: [] }] }),
  });
  const res = await abilities.runAbility('task_plan', ctx, { task: 'fill the form and click submit' });
  assert.equal(res.ok, true);
  assert.ok(res.stepCount >= 2);
  assert.ok(res.plan[0].startsWith('1.'));
});

test('form_fill_audit flags sensitive and unlabeled fields', async () => {
  const ctx = mockCtx({
    forms: () => ({
      ok: true,
      forms: [
        {
          index: 0,
          fields: [
            { type: 'password', sensitive: true },
            { type: 'text', name: '', id: '', label: '', placeholder: '' },
          ],
        },
      ],
    }),
  });
  const res = await abilities.runAbility('form_fill_audit', ctx, {});
  assert.equal(res.ok, true);
  assert.ok(res.issues.some((i) => i.severity === 'high' && /sensitive/.test(i.title)));
  assert.ok(res.issues.some((i) => i.severity === 'medium' && /unlabeled/.test(i.title)));
});

test('chat returns a helpful mock reply about the page', async () => {
  const ctx = mockCtx({});
  const res = await abilities.runAbility('chat', ctx, { message: 'summarize this page' });
  assert.equal(res.ok, true);
  assert.ok(typeof res.reply === 'string' && res.reply.length > 0);
  assert.ok(res.reply.includes('page') || res.reply.includes('Page'));
});

test('runAbility rejects unknown abilities with the available list', async () => {
  const ctx = mockCtx({});
  const res = await abilities.runAbility('nope', ctx, {});
  assert.equal(res.ok, false);
  assert.match(res.error, /unknown ability/);
  assert.equal(res.available.length, 73);
});

test('chat history is stored and capped', async () => {
  abilities.resetChat('s1');
  const ctx = mockCtx({});
  for (let i = 0; i < 5; i++) {
    await abilities.runAbility('chat', ctx, { message: 'hi ' + i });
  }
  const h = abilities.getChat('s1');
  assert.ok(h.length >= 5);
  assert.equal(h[0].role, 'user');
  assert.equal(h[h.length - 1].role, 'assistant');
  assert.equal(h[h.length - 1].content.length > 0, true);
});

/* ---------------------- new SOTA abilities (background) ------------------- */

function bgCtx(over) {
  const memoryMap = {};
  return {
    tabId: 1,
    config: { vision: { provider: 'mock' } },
    session: { id: 's1' },
    isMock: () => true,
    dom: async (ability, args) => ({ ok: true }),
    capture: async () => null,
    tabs: null,
    windows: null,
    queryEvents: async () => [],
    queryInsights: async () => [],
    taskStatus: () => null,
    reportProgress: async () => {},
    isCancelled: () => false,
    memory: {
      get: async (key) => memoryMap[key] || null,
      list: async () => Object.entries(memoryMap).map(([key, v]) => ({ key, ...v })),
      set: async (key, value, kind) => {
        memoryMap[key] = { value, kind: kind || 'note', updatedAt: Date.now() };
      },
      remove: async (key) => {
        delete memoryMap[key];
      },
    },
    notify: async () => true,
    download: async (d) => 42,
    schedule: async (s) => ({ id: 'sched1', runsAt: Date.now() + s.delaySec * 1000 }),
    cropImage: async () => ({ dataUrl: 'data:image/jpeg;base64,AAAA', width: 10, height: 10, region: { x: 0, y: 0, w: 10, h: 10 } }),
    ...over,
  };
}

test('session_log aggregates tracked events and agent insights', async () => {
  const ctx = bgCtx({
    queryEvents: async () => [{ ts: 1, type: 'click', url: 'https://a.com/x' }],
    queryInsights: async () => [{ ts: 2, type: 'error', title: 'boom' }],
  });
  const res = await abilities.runAbility('session_log', ctx, {});
  assert.equal(res.ok, true);
  assert.equal(res.eventCount, 1);
  assert.equal(res.insightCount, 1);
  assert.equal(res.events[0].type, 'click');
  assert.equal(res.insights[0].title, 'boom');
});

test('wait_seconds pauses for a tiny fraction offline', async () => {
  const res = await abilities.runAbility('wait_seconds', bgCtx(), { seconds: 0.01 });
  assert.equal(res.ok, true);
  assert.ok(res.waitedSec >= 0.01);
});

test('wait_for_element polls until the element appears', async () => {
  let calls = 0;
  const ctx = bgCtx({
    dom: async (ability) => {
      if (ability === 'find_element') {
        calls++;
        return calls >= 3 ? { ok: true, count: 1, matches: [{ ref: 'el1' }] } : { ok: false, count: 0, matches: [] };
      }
      return { ok: true };
    },
  });
  const res = await abilities.runAbility('wait_for_element', ctx, { text: 'spinner', timeoutSec: 2 });
  assert.equal(res.ok, true);
  assert.equal(res.count, 1);
  assert.ok(calls >= 3);
});

test('tab abilities list, open, switch and close tabs', async () => {
  const tabs = [];
  const ctx = bgCtx({
    tabs: {
      query: async () => tabs,
      create: async ({ url, active }) => {
        const t = { id: 100 + tabs.length, url, active: !!active, pinned: false, windowId: 1, title: 'Tab ' + (tabs.length + 1) };
        tabs.push(t);
        return t;
      },
      update: async (id, patch) => Object.assign(tabs.find((t) => t.id === id), patch),
      get: async (id) => tabs.find((t) => t.id === id),
      remove: async (id) => {
        const i = tabs.findIndex((t) => t.id === id);
        if (i >= 0) tabs.splice(i, 1);
      },
    },
  });
  const opened = await abilities.runAbility('tab_open', ctx, { url: 'https://example.com' });
  assert.equal(opened.ok, true);
  assert.equal(opened.tabId, 100);
  const list = await abilities.runAbility('tabs_list', ctx, {});
  assert.equal(list.ok, true);
  assert.equal(list.count, 1);
  assert.equal(list.tabs[0].url, 'https://example.com');
  const switched = await abilities.runAbility('tab_switch', ctx, { index: 0 });
  assert.equal(switched.ok, true);
  assert.equal(switched.tabId, 100);
  const closed = await abilities.runAbility('tab_close', ctx, { index: 0 });
  assert.equal(closed.ok, true);
  assert.equal(tabs.length, 0);
});

test('viewport_set resizes the focused window', async () => {
  let updated = null;
  const ctx = bgCtx({
    windows: {
      getLastFocused: async () => ({ id: 7 }),
      update: async (id, opts) => {
        updated = { id, ...opts };
        return { id, ...opts };
      },
    },
  });
  const res = await abilities.runAbility('viewport_set', ctx, { width: 1280, height: 900 });
  assert.equal(res.ok, true);
  assert.equal(res.width, 1280);
  assert.equal(updated.width, 1280);
});

test('ui_validate runs steps and stops on the first failure (failFast)', async () => {
  const calls = [];
  const ctx = bgCtx({
    dom: async (ability, args) => {
      calls.push([ability, args]);
      if (ability === 'click') return { ok: true };
      if (ability === 'type') return { ok: false, error: 'no field' };
      if (ability === 'element_state') return { ok: true };
      return { ok: true };
    },
  });
  const res = await abilities.runAbility('ui_validate', ctx, {
    steps: [
      { action: 'click', ref: 'el1' },
      { action: 'type', ref: 'f1', value: 'x' },
      { action: 'check', text: 'y' },
    ],
  });
  assert.equal(res.ok, false);
  assert.equal(res.passed, 1);
  assert.equal(res.failed, 1);
  assert.equal(res.steps.length, 2);
  assert.equal(res.steps[1].ok, false);
});

test('ui_validate reports success when every step passes', async () => {
  const ctx = bgCtx({ dom: async () => ({ ok: true }) });
  const res = await abilities.runAbility('ui_validate', ctx, {
    steps: [
      { action: 'click', ref: 'el1' },
      { action: 'type', ref: 'f1', value: 'x' },
      { action: 'check', ref: 'f1' },
      { action: 'wait', ms: 0 },
    ],
  });
  assert.equal(res.ok, true);
  assert.equal(res.passed, 4);
  assert.equal(res.failed, 0);
});

test('deep_research produces a cited report offline (synthetic sources)', async () => {
  const res = await abilities.runAbility('deep_research', bgCtx(), { topic: 'visual ai agents', depth: 2 });
  assert.equal(res.ok, true);
  assert.equal(res.provider, 'mock');
  assert.equal(res.live, false);
  assert.ok(res.report && res.report.length > 20);
  assert.ok(Array.isArray(res.sources) && res.sources.length > 0);
  assert.ok(res.sources.every((s) => s.synthetic));
  assert.ok(res.citations >= 1);
});

test('visual_check degrades gracefully when no image decoder exists', async () => {
  const ctx = bgCtx({ capture: async () => 'data:image/png;base64,AAAA' });
  const first = await abilities.runAbility('visual_check', ctx, {});
  assert.equal(first.ok, true);
  assert.equal(first.available, false);
});

test('task_status and task_cancel operate on the background task store', async () => {
  const task = { id: 't1', status: 'running', ability: 'deep_research', progress: { stage: 'searching', pct: 40 } };
  const ctx = bgCtx({ taskStatus: (id) => (id === 't1' ? task : null) });
  const st = await abilities.runAbility('task_status', ctx, { taskId: 't1' });
  assert.equal(st.ok, true);
  assert.equal(st.status, 'running');
  assert.equal(st.stage, 'searching');
  const cancelled = await abilities.runAbility('task_cancel', ctx, { taskId: 't1' });
  assert.equal(cancelled.ok, true);
  assert.equal(task.cancelled, true);
  const missing = await abilities.runAbility('task_status', ctx, { taskId: 'nope' });
  assert.equal(missing.ok, false);
});

test('web_search returns synthetic results offline', async () => {
  const ctx = bgCtx();
  const res = await abilities.runAbility('web_search', ctx, { query: 'claude desktop' });
  assert.equal(res.ok, true);
  assert.equal(res.live, false);
  assert.ok(res.count >= 1);
  assert.ok(Array.isArray(res.results) && res.results.length === res.count);
  assert.ok(res.results.every((r) => r.title && r.url && typeof r.snippet === 'string'));
  assert.ok(res.results.every((r) => r.synthetic === true));
  const bad = await abilities.runAbility('web_search', ctx, { query: '   ' });
  assert.equal(bad.ok, false);
});

test('web_fetch returns offline placeholder when provider is mock', async () => {
  const ctx = bgCtx();
  const res = await abilities.runAbility('web_fetch', ctx, { url: 'https://example.com/doc' });
  assert.equal(res.ok, true);
  assert.equal(res.mock, true);
  assert.match(res.text, /\[offline\]/);
  assert.equal(res.url, 'https://example.com/doc');
  const bad = await abilities.runAbility('web_fetch', ctx, { url: 'not a url' });
  assert.equal(bad.ok, false);
});

test('memory_remember / memory_recall / memory_list / memory_forget round-trip', async () => {
  const ctx = bgCtx();
  const rem = await abilities.runAbility('memory_remember', ctx, { key: 'user-pref', value: 'dark mode', kind: 'preference' });
  assert.equal(rem.ok, true);
  assert.equal(rem.key, 'user-pref');
  const recall = await abilities.runAbility('memory_recall', ctx, { query: 'dark' });
  assert.equal(recall.ok, true);
  assert.equal(recall.count, 1);
  assert.equal(recall.entries[0].value, 'dark mode');
  const list = await abilities.runAbility('memory_list', ctx, {});
  assert.equal(list.ok, true);
  assert.equal(list.count, 1);
  const forget = await abilities.runAbility('memory_forget', ctx, { key: 'user-pref' });
  assert.equal(forget.ok, true);
  const empty = await abilities.runAbility('memory_list', ctx, {});
  assert.equal(empty.count, 0);
  const noKey = await abilities.runAbility('memory_remember', ctx, { key: ' ', value: 'x' });
  assert.equal(noKey.ok, false);
});

test('current_time returns an ISO timestamp', async () => {
  const res = await abilities.runAbility('current_time', bgCtx(), {});
  assert.equal(res.ok, true);
  assert.match(res.iso, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(res.unix > 0);
});

test('schedule_task schedules a valid ability and rejects unknown ones', async () => {
  const ctx = bgCtx();
  const res = await abilities.runAbility('schedule_task', ctx, { ability: 'current_time', inSeconds: 10, note: 'ping' });
  assert.equal(res.ok, true);
  assert.equal(res.scheduledAbility, 'current_time');
  assert.equal(res.taskId, 'sched1');
  assert.ok(res.runsAt > Date.now());
  const bad = await abilities.runAbility('schedule_task', ctx, { ability: 'nope', inSeconds: 10 });
  assert.equal(bad.ok, false);
});

test('notify surfaces a desktop notification via ctx.notify', async () => {
  const ok = await abilities.runAbility('notify', bgCtx(), { message: 'hello' });
  assert.equal(ok.ok, true);
  const fail = await abilities.runAbility('notify', bgCtx({ notify: async () => false }), { message: 'nope' });
  assert.equal(fail.ok, false);
  assert.equal(fail.error, 'chrome.notifications failed');
});

test('download saves a URL via the downloads manager', async () => {
  const ok = await abilities.runAbility('download', bgCtx(), { url: 'https://example.com/file.pdf', filename: 'x.pdf' });
  assert.equal(ok.ok, true);
  assert.equal(ok.downloadId, 42);
  const bad = await abilities.runAbility('download', bgCtx(), { url: 'javascript:alert(1)' });
  assert.equal(bad.ok, false);
});

test('screen_region crops the screenshot at full resolution', async () => {
  const ctx = bgCtx({ capture: async () => 'data:image/png;base64,AA' });
  const res = await abilities.runAbility('screen_region', ctx, { x: 0, y: 0, w: 10, h: 10 });
  assert.equal(res.ok, true);
  assert.equal(res.region.w, 10);
  assert.equal(res.width, 10);
  const missing = await abilities.runAbility('screen_region', ctx, { x: 0, y: 0, w: 0, h: 10 });
  assert.equal(missing.ok, false);
});
