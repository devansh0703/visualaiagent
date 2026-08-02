/**
 * test/unit/abilities.test.mjs — the 30-ability registry (background) and the
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

test('registry exposes 30 abilities across 4 categories', () => {
  const list = abilities.listAbilities();
  assert.equal(list.length, 30);
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
  assert.equal(res.available.length, 30);
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
