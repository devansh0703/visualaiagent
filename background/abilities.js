/**
 * abilities.js — the agent's 30 well-defined skills.
 *
 * Each ability is a named, self-contained capability the user can invoke from
 * the popup chatbot / abilities browser. Abilities are grouped:
 *
 *   read  — page intelligence (text, links, tables, forms, metadata, a11y, …)
 *   write — computer use (click, type, select, scroll, fill_form, …)
 *   agent — composed intelligence (chat, summarize, plan, describe screen, …)
 *   meta  — screenshots, viewport, ability discovery
 *
 * Everything runs offline through the mock provider (no API key needed); with
 * a real vision key the LLM-backed abilities upgrade automatically.
 *
 * `ctx` is provided by the service worker:
 *   { tabId, config, session, isMock(), dom(ability, args), capture() }
 */
import * as vision from './vision.js';
import { isMockVision, chat, runTask, pageReport, DEFAULT_MAX_STEPS } from './agent.js';

export { DEFAULT_MAX_STEPS };

/* ----------------------------- chat history ------------------------------ */

const chatHistory = new Map(); // sessionId -> [{role, content}]

export function getChat(sessionId) {
  return chatHistory.get(sessionId) || [];
}

export function resetChat(sessionId) {
  chatHistory.set(sessionId, []);
}

export function appendChat(sessionId, role, content) {
  const h = chatHistory.get(sessionId) || [];
  h.push({ role, content: String(content || '').slice(0, 4000) });
  if (h.length > 20) h.splice(0, h.length - 20);
  chatHistory.set(sessionId, h);
  return h;
}

/* ------------------------------- mock helpers ----------------------------- */

function mockSummarize(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  const sentences = clean.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  return {
    summary: sentences.slice(0, 3).join(' ') || 'No readable text on this page.',
    wordCount: clean ? clean.split(/\s+/).length : 0,
    leading: sentences.slice(0, 6),
  };
}

function mockPlan(task, digest) {
  const t = String(task || '').toLowerCase();
  const d = digest || {};
  const els = d.elements || [];
  const buttons = els.filter((e) => e.tag === 'button').slice(0, 3);
  const forms = d.forms || [];
  const steps = [];
  if (/fill|form|register|sign\s?up/.test(t) && forms.length) steps.push(`Read the ${forms.length} form(s) on the page (field types, labels, required)`);
  if (/fill|form|register|sign\s?up/.test(t)) steps.push('Fill each field with sensible test data (email/name/etc.), then submit the form');
  if (/click|press|tap|open/.test(t)) steps.push(buttons.length ? `Click the most relevant button (${buttons.map((b) => b.ref + ' "' + b.text + '"').join(', ')})` : 'Find and click the target button by its label');
  if (/scroll|down|read|browse/.test(t)) steps.push('Scroll through the page to reveal the target content');
  if (/search|find|look/.test(t)) steps.push('Search the page text and links for the target');
  if (/type|enter|input/.test(t)) steps.push('Type the value into the target field');
  steps.push('Verify the outcome on the updated page and report the result');
  return { plan: steps.map((s, i) => `${i + 1}. ${s}`), stepCount: steps.length };
}

function valueForField(f) {
  const t = String(f.type || '').toLowerCase();
  const hay = `${f.name} ${f.id} ${f.placeholder} ${f.label || ''}`.toLowerCase();
  if (f.sensitive || /passw/.test(hay)) return ''; // never auto-fill secrets
  if (t === 'email' || /e-?mail/.test(hay)) return 'test@example.com';
  if (t === 'tel' || /phone|mobile/.test(hay)) return '555-0100';
  if (t === 'url' || /website|site/.test(hay)) return 'https://example.com';
  if (t === 'number') return '42';
  if (t === 'date') return '2026-01-01';
  if (t === 'time') return '09:00';
  if (t === 'checkbox' || t === 'radio') return true;
  if (t === 'select' || f.tag === 'select') return (f.options && f.options[0]) || '1';
  if (/first/.test(hay)) return 'Ada';
  if (/last/.test(hay)) return 'Lovelace';
  if (/name/.test(hay)) return 'Ada Lovelace';
  if (/company|organization/.test(hay)) return 'Test Org';
  if (/address/.test(hay)) return '123 Main St';
  if (/city/.test(hay)) return 'Springfield';
  if (/zip|postal/.test(hay)) return '12345';
  if (/search|query|keyword/.test(hay)) return 'visual ai agent';
  if (/comment|message|feedback|notes/.test(hay)) return 'Filled by the Visual AI Agent test harness.';
  return 'test-value';
}

function generateFormData(form) {
  const data = {};
  for (const f of form.fields || []) {
    if (f.sensitive) continue;
    if (f.value && f.value !== '[REDACTED]') continue; // keep existing values
    data[f.ref] = valueForField(f);
  }
  return data;
}

/* --------------------------- ability registry ----------------------------- */

const ABILITIES = [];
const BY_ID = new Map();

function def({ id, name, category, description, args = [], run }) {
  const a = { id, name, category, description, args };
  ABILITIES.push(a);
  BY_ID.set(id, { ...a, run });
}

function domAction(ability, args) {
  return (ctx, a) => ctx.dom(ability, a);
}

/* ------------------------------- read ------------------------------------ */

def({
  id: 'page_digest',
  name: 'DOM snapshot',
  category: 'read',
  description: 'Full snapshot of the visible page: interactive elements (with refs), text, links and forms.',
  args: [{ name: 'max', type: 'number', required: false, desc: 'max interactive elements (default 40)' }],
  run: (ctx, a) => ctx.dom('digest', { max: a.max || 40 }),
});

def({
  id: 'page_text',
  name: 'Read page text',
  category: 'read',
  description: 'Return the readable text content of the current page.',
  args: [{ name: 'max', type: 'number', required: false, desc: 'max characters (default 6000)' }],
  run: (ctx, a) => ctx.dom('text', { max: a.max || 6000 }),
});

def({
  id: 'page_links',
  name: 'List links',
  category: 'read',
  description: 'All links on the page (label, URL, ref when visible).',
  run: (ctx) => ctx.dom('links'),
});

def({
  id: 'page_tables',
  name: 'Extract tables',
  category: 'read',
  description: 'Every HTML table on the page as structured rows.',
  run: (ctx) => ctx.dom('tables'),
});

def({
  id: 'page_forms',
  name: 'Inspect forms',
  category: 'read',
  description: 'Form structure: fields, types, labels, required flags, current values.',
  run: (ctx) => ctx.dom('forms'),
});

def({
  id: 'page_headings',
  name: 'Page outline',
  category: 'read',
  description: 'The h1–h6 heading outline of the page.',
  run: (ctx) => ctx.dom('headings'),
});

def({
  id: 'page_entities',
  name: 'Find contacts & data',
  category: 'read',
  description: 'Extract emails, phone numbers, prices, dates and URLs from the page text.',
  run: (ctx) => ctx.dom('entities'),
});

def({
  id: 'page_metadata',
  name: 'Page metadata',
  category: 'read',
  description: 'Title, meta description, Open Graph tags, canonical URL, language.',
  run: (ctx) => ctx.dom('metadata'),
});

def({
  id: 'page_accessibility',
  name: 'Accessibility audit',
  category: 'read',
  description: 'Scan for common a11y issues: missing alt text, unnamed buttons, unlabeled inputs, heading skips.',
  run: (ctx) => ctx.dom('accessibility'),
});

def({
  id: 'page_health',
  name: 'Page health check',
  category: 'read',
  description: 'Latest console/JS errors and resource failures observed on the page.',
  run: (ctx) => ctx.dom('errors'),
});

def({
  id: 'find_element',
  name: 'Find element',
  category: 'read',
  description: 'Locate a visible element by its text / label and return its ref.',
  args: [{ name: 'text', type: 'string', required: true, desc: 'text or label to search for' }],
  run: (ctx, a) => ctx.dom('find_element', { text: a.text || a.query }),
});

def({
  id: 'page_summarize',
  name: 'Summarize page',
  category: 'read',
  description: 'A concise summary of the page text (LLM when a vision key is set, offline heuristic otherwise).',
  args: [{ name: 'max', type: 'number', required: false, desc: 'max characters of source text' }],
  run: async (ctx, a) => {
    const res = await ctx.dom('text', { max: a.max || 8000 });
    if (!res.ok) return res;
    if (ctx.isMock()) {
      const s = mockSummarize(res.text);
      return { ok: true, provider: 'mock', model: 'mock-summarize', ...s };
    }
    try {
      const out = await vision.chat({
        config: ctx.config,
        system: 'You summarize web pages. Be concise and factual. Return a short plain-text summary, 3-6 sentences.',
        prompt: 'Summarize this page text:\n\n' + String(res.text || '').slice(0, 8000),
        maxTokens: 500,
      });
      return { ok: true, provider: out.provider, model: out.model, summary: out.text };
    } catch (e) {
      const s = mockSummarize(res.text);
      return { ok: true, provider: 'fallback', model: 'mock-summarize', ...s, warn: e.message };
    }
  },
});

/* ------------------------------ write ------------------------------------ */

def({
  id: 'click_element',
  name: 'Click element',
  category: 'write',
  description: 'Click an element by ref (el1/f1) or by visible label text.',
  args: [
    { name: 'ref', type: 'string', required: false, desc: 'elN or fN ref' },
    { name: 'text', type: 'string', required: false, desc: 'or match by label text' },
  ],
  run: (ctx, a) => ctx.dom('click', { ref: a.ref, text: a.text }),
});

def({
  id: 'type_text',
  name: 'Type text',
  category: 'write',
  description: 'Type a value into a form field (fires input/change events).',
  args: [
    { name: 'ref', type: 'string', required: true, desc: 'fN field ref' },
    { name: 'value', type: 'string', required: true, desc: 'text to type' },
  ],
  run: (ctx, a) => ctx.dom('type', { ref: a.ref, value: a.value }),
});

def({
  id: 'clear_field',
  name: 'Clear field',
  category: 'write',
  description: 'Empty a form field.',
  args: [{ name: 'ref', type: 'string', required: true, desc: 'fN field ref' }],
  run: (ctx, a) => ctx.dom('clear', { ref: a.ref }),
});

def({
  id: 'select_option',
  name: 'Select dropdown option',
  category: 'write',
  description: 'Pick an option in a <select> by value or label.',
  args: [
    { name: 'ref', type: 'string', required: true, desc: 'fN select ref' },
    { name: 'value', type: 'string', required: true, desc: 'option value or label' },
  ],
  run: (ctx, a) => ctx.dom('select', { ref: a.ref, value: a.value }),
});

def({
  id: 'toggle_checkbox',
  name: 'Check / uncheck checkbox',
  category: 'write',
  description: 'Set a checkbox or radio to checked / unchecked.',
  args: [
    { name: 'ref', type: 'string', required: true, desc: 'fN ref' },
    { name: 'value', type: 'boolean', required: true, desc: 'true = check, false = uncheck' },
  ],
  run: (ctx, a) => ctx.dom('checkbox', { ref: a.ref, value: a.value !== false && a.value !== 'false' }),
});

def({
  id: 'scroll_page',
  name: 'Scroll page',
  category: 'write',
  description: 'Scroll the page (direction + amount) or to a specific element ref.',
  args: [
    { name: 'dir', type: 'string', required: false, desc: 'down | up | to (default down)' },
    { name: 'amount', type: 'number', required: false, desc: 'px (default 400)' },
    { name: 'ref', type: 'string', required: false, desc: 'scroll to element' },
  ],
  run: (ctx, a) => ctx.dom('scroll', { dir: a.dir, amount: a.amount, ref: a.ref }),
});

def({
  id: 'navigate_page',
  name: 'Navigate to URL',
  category: 'write',
  description: 'Navigate the current tab to a URL.',
  args: [{ name: 'url', type: 'string', required: true, desc: 'full URL' }],
  run: (ctx, a) => ctx.dom('navigate', { url: a.url }),
});

def({
  id: 'submit_form',
  name: 'Submit form',
  category: 'write',
  description: 'Submit a form (by index, or the form containing a field ref).',
  args: [{ name: 'formIndex', type: 'number', required: false, desc: 'form index (default 0)' }],
  run: (ctx, a) => ctx.dom('submit_form', { formIndex: a.formIndex }),
});

def({
  id: 'fill_form',
  name: 'Fill form',
  category: 'write',
  description:
    'Fill a form with data. Pass `data` (map of field name/id/ref → value) or leave empty to auto-generate test values. Skips sensitive fields.',
  args: [
    { name: 'formIndex', type: 'number', required: false, desc: 'form index (default 0)' },
    { name: 'data', type: 'object', required: false, desc: '{ "name or id": "value", ... }' },
  ],
  run: async (ctx, a) => {
    const read = await ctx.dom('forms');
    if (!read.ok || !Array.isArray(read.forms)) return { ok: false, error: read.error || 'cannot read forms' };
    const formIndex = a.formIndex != null ? Number(a.formIndex) : 0;
    const form = read.forms[formIndex];
    if (!form) return { ok: false, error: 'no form at index ' + formIndex, formCount: read.forms.length };
    let data = {};
    let generated = false;
    if (a.data && typeof a.data === 'object' && Object.keys(a.data).length) {
      data = a.data;
    } else {
      data = generateFormData(form);
      generated = true;
    }
    const res = await ctx.dom('fill_form', { formIndex, data });
    if (!res.ok) return res;
    return {
      ok: true,
      form: { index: form.index, action: form.action, method: form.method, fieldCount: form.fieldCount },
      generated,
      filled: res.applied || [],
      unmatched: res.unmatched || [],
      filledCount: res.filledCount || res.applied.length || 0,
    };
  },
});

/* ------------------------------- agent ----------------------------------- */

def({
  id: 'chat',
  name: 'Chat with agent',
  category: 'agent',
  description: 'Conversational chat with the agent. It sees the current page and remembers the conversation.',
  args: [{ name: 'message', type: 'string', required: true, desc: 'your message' }],
  run: async (ctx, a) => {
    const msg = String(a.message || '').trim();
    if (!msg) return { ok: false, error: 'chat needs a message' };
    const sessionId = (ctx.session && ctx.session.id) || 'anon';
    const history = getChat(sessionId);
    const reply = await chat({ messages: [...history, { role: 'user', content: msg }], tabId: ctx.tabId, config: ctx.config, session: ctx.session });
    if (reply.ok) appendChat(sessionId, 'assistant', reply.reply);
    else appendChat(sessionId, 'assistant', 'Sorry, I could not respond: ' + reply.error);
    return reply;
  },
});

def({
  id: 'screen_describe',
  name: 'Describe screen',
  category: 'agent',
  description: 'Vision model describes what is currently on screen (offline heuristic when no key).',
  run: async (ctx) => {
    let digest = null;
    try {
      const res = await ctx.dom('digest', { max: 40 });
      digest = res && res.ok ? res : null;
    } catch {}
    const vcfg = { ...ctx.config.vision };
    if (ctx.isMock()) {
      const d = digest || {};
      return {
        ok: true,
        provider: 'mock',
        model: 'mock-vision',
        description: `Screen shows "${d.title || 'an untitled page'}" at ${d.url || 'unknown URL'} with ${(d.elements || []).length} interactive elements (${(d.elements || []).filter((e) => e.tag === 'button').length} buttons, ${(d.elements || []).filter((e) => ['input', 'textarea', 'select'].includes(e.tag)).length} form fields), ${(d.links && d.links.count) || 0} links and ${(d.forms || []).length} form(s).`,
        elements: (d.elements || []).slice(0, 10),
      };
    }
    const dataUrl = await ctx.capture();
    if (!dataUrl) return { ok: false, error: 'could not capture the tab' };
    try {
      const out = await vision.analyze({ config: { vision: vcfg }, context: { url: digest ? digest.url : '', title: digest ? digest.title : '', dataUrl } });
      return { ok: true, provider: out.provider, model: out.model, description: out.answer || out.summary || '…', raw: out.raw };
    } catch (e) {
      return { ok: false, error: 'describe failed: ' + e.message };
    }
  },
});

def({
  id: 'task_run',
  name: 'Run a task',
  category: 'agent',
  description: 'Computer-use loop: describe a goal in natural language and the agent looks → decides → acts (click/type/scroll/navigate) until done.',
  args: [
    { name: 'task', type: 'string', required: true, desc: 'what should the agent do?' },
    { name: 'maxSteps', type: 'number', required: false, desc: 'step budget (default 8)' },
  ],
  run: (ctx, a) => runTask({
    tabId: ctx.tabId,
    task: a.task,
    config: ctx.config,
    session: ctx.session,
    maxSteps: a.maxSteps || DEFAULT_MAX_STEPS,
    withScreenshots: !ctx.isMock(),
  }),
});

def({
  id: 'task_plan',
  name: 'Plan a task',
  category: 'agent',
  description: 'Generate a step-by-step plan to accomplish a goal on this page.',
  args: [{ name: 'task', type: 'string', required: true, desc: 'your goal' }],
  run: async (ctx, a) => {
    let digest = null;
    try {
      const res = await ctx.dom('digest', { max: 40 });
      digest = res && res.ok ? res : {};
    } catch {}
    const plan = mockPlan(String(a.task || ''), digest);
    return { ok: true, provider: 'mock', ...plan, elementCount: (digest && digest.elements && digest.elements.length) || 0, formCount: (digest && digest.forms && digest.forms.length) || 0 };
  },
});

def({
  id: 'analyze_page',
  name: 'Deep page report',
  category: 'agent',
  description: 'Rich structured page report: page type, key points, extractable data, actions, forms, issues, recommendations.',
  run: (ctx, a) => pageReport({ tabId: ctx.tabId, config: ctx.config, session: ctx.session, withVision: !!a.withVision }),
});

def({
  id: 'form_fill_audit',
  name: 'Audit forms',
  category: 'agent',
  description: 'Analyze every form for UX and security issues (sensitive fields, required flags, missing labels).',
  run: async (ctx) => {
    const read = await ctx.dom('forms');
    if (!read.ok || !read.forms) return { ok: false, error: read.error || 'cannot read forms' };
    const issues = [];
    for (const f of read.forms) {
      if (!f.fields.length) issues.push({ severity: 'medium', form: f.index, title: 'Empty form', detail: 'form at index ' + f.index + ' has no fields' });
      const sensitive = f.fields.filter((x) => x.sensitive).length;
      if (sensitive) issues.push({ severity: 'high', form: f.index, title: sensitive + ' sensitive field(s)', detail: 'credit-card / password fields must be masked and never auto-filled' });
      const unlabeled = f.fields.filter((x) => !x.label && !x.placeholder && !x.name && !x.id && x.type !== 'hidden' && x.type !== 'submit' && x.type !== 'button' && x.type !== 'checkbox').length;
      if (unlabeled) issues.push({ severity: 'medium', form: f.index, title: unlabeled + ' unlabeled field(s)', detail: 'fields without label/placeholder/name/id are hard to understand' });
    }
    return { ok: true, formCount: read.forms.length, fieldCount: read.forms.reduce((n, f) => n + f.fields.length, 0), issues };
  },
});

/* ------------------------------- meta ------------------------------------ */

def({
  id: 'screenshot',
  name: 'Take screenshot',
  category: 'meta',
  description: 'Capture the visible tab (stored locally + flushable to your DB).',
  run: async (ctx) => {
    try {
      const { captureNow } = await import('./capture.js');
      const shot = await captureNow({ tabId: ctx.tabId, reason: 'ability_screenshot', session: ctx.session, config: ctx.config, onAnalyze: null });
      if (!shot) return { ok: false, error: 'capture returned nothing' };
      return { ok: true, screenshotId: shot.id, width: shot.width, height: shot.height, reason: shot.reason };
    } catch (e) {
      return { ok: false, error: 'screenshot failed: ' + e.message };
    }
  },
});

def({
  id: 'viewport_info',
  name: 'Viewport info',
  category: 'meta',
  description: 'Viewport size, scroll position and document height.',
  run: (ctx) => ctx.dom('viewport'),
});

def({
  id: 'ability_list',
  name: 'List abilities',
  category: 'meta',
  description: 'List every ability the agent has, with its arguments.',
  run: () => ({ ok: true, count: ABILITIES.length, abilities: listAbilities() }),
});

/* ------------------------------ public API -------------------------------- */

export function listAbilities() {
  return ABILITIES.map(({ id, name, category, description, args }) => ({ id, name, category, description, args }));
}

export async function runAbility(id, ctx, args = {}) {
  const defn = BY_ID.get(id);
  if (!defn) {
    const available = BY_ID.has('ability_list') ? listAbilities().map((a) => a.id) : [];
    return { ok: false, error: 'unknown ability: ' + id, available };
  }
  try {
    const result = await defn.run(ctx, args || {});
    return {
      ...(result && typeof result === 'object' ? result : { ok: !!result, result }),
      ability: id,
      name: defn.name,
      category: defn.category,
    };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e), ability: id, name: defn.name, category: defn.category };
  }
}
