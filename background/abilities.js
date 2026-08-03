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
import { planResearch, webSearch, synthesizeReport } from './research.js';
import { imageSignature, pixelDiff } from './pixels.js';
import { connectMcp, listTools, callTool } from './mcp.js';

export { DEFAULT_MAX_STEPS };

/* ----------------------------- chat history ------------------------------ */

const chatHistory = new Map(); // sessionId -> [{role, content}]

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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
  id: 'element_state',
  name: 'Element state',
  category: 'read',
  description: 'Live state of an element: visibility, disabled/checked flags, current value, text and rect.',
  args: [
    { name: 'ref', type: 'string', required: false, desc: 'elN or fN ref' },
    { name: 'text', type: 'string', required: false, desc: 'or match by label text' },
  ],
  run: (ctx, a) => ctx.dom('element_state', { ref: a.ref, text: a.text }),
});

def({
  id: 'page_readable',
  name: 'Extract article',
  category: 'read',
  description: 'Readability extraction of the main article content (title, paragraphs, word count).',
  run: (ctx) => ctx.dom('readable'),
});

def({
  id: 'clipboard_read',
  name: 'Read clipboard',
  category: 'read',
  description: 'Read the text currently on the clipboard.',
  run: (ctx) => ctx.dom('clipboard_read'),
});

def({
  id: 'session_log',
  name: 'Session log',
  category: 'read',
  description: 'What happened: recent tracked events and agent insights for this session.',
  args: [{ name: 'limit', type: 'number', required: false, desc: 'max events to return (default 30)' }],
  run: async (ctx, a) => {
    const limit = Math.min(100, Number(a.limit) || 30);
    let events = [];
    let insights = [];
    if (ctx.queryEvents) {
      try {
        events = (await ctx.queryEvents({ limit: Math.min(limit, 50) })) || [];
      } catch {}
    }
    if (ctx.queryInsights) {
      try {
        insights = (await ctx.queryInsights({ limit: 10 })) || [];
      } catch {}
    }
    const rows = events.map((e) => ({ ts: e.ts, type: e.type, url: String(e.url || '').slice(0, 140) })).slice(0, limit);
    const notes = insights.map((i) => ({ ts: i.ts, type: i.type, title: String(i.title || '').slice(0, 140) }));
    return {
      ok: true,
      summary: `${rows.length} event(s), ${notes.length} agent insight(s) in the current session`,
      eventCount: rows.length,
      insightCount: notes.length,
      events: rows,
      insights: notes,
    };
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
    const fieldCount = form.fieldCount != null ? form.fieldCount : (form.fields ? form.fields.length : 0);
    return {
      ok: true,
      form: { index: form.index, action: form.action, method: form.method, fieldCount },
      generated,
      filled: res.applied || [],
      unmatched: res.unmatched || [],
      filledCount: res.filledCount || (res.applied ? res.applied.length : 0) || 0,
    };
  },
});

/* ---- precise input actions (virtual mouse / keyboard, like CUA) --------- */

def({
  id: 'hover_element',
  name: 'Hover element',
  category: 'write',
  description: 'Move the virtual pointer over an element (fires pointer/mouse hover events).',
  args: [
    { name: 'ref', type: 'string', required: false, desc: 'elN or fN ref' },
    { name: 'text', type: 'string', required: false, desc: 'or match by label text' },
  ],
  run: (ctx, a) => ctx.dom('hover', { ref: a.ref, text: a.text }),
});

def({
  id: 'double_click',
  name: 'Double-click element',
  category: 'write',
  description: 'Double-click an element (fires click, click, dblclick).',
  args: [
    { name: 'ref', type: 'string', required: false, desc: 'elN or fN ref' },
    { name: 'text', type: 'string', required: false, desc: 'or match by label text' },
  ],
  run: (ctx, a) => ctx.dom('double_click', { ref: a.ref, text: a.text }),
});

def({
  id: 'right_click',
  name: 'Right-click element',
  category: 'write',
  description: 'Right-click an element (fires contextmenu).',
  args: [
    { name: 'ref', type: 'string', required: false, desc: 'elN or fN ref' },
    { name: 'text', type: 'string', required: false, desc: 'or match by label text' },
  ],
  run: (ctx, a) => ctx.dom('right_click', { ref: a.ref, text: a.text }),
});

def({
  id: 'key_press',
  name: 'Press keyboard key',
  category: 'write',
  description: 'Send a keyboard key / shortcut to the focused element or page (Enter, Escape, Tab, ctrl+s, …).',
  args: [
    { name: 'key', type: 'string', required: true, desc: 'e.g. Enter, Escape, Tab, "a"' },
    { name: 'ref', type: 'string', required: false, desc: 'fN ref to focus first (optional)' },
    { name: 'ctrl', type: 'boolean', required: false, desc: 'hold Ctrl' },
    { name: 'shift', type: 'boolean', required: false, desc: 'hold Shift' },
    { name: 'alt', type: 'boolean', required: false, desc: 'hold Alt' },
  ],
  run: (ctx, a) => ctx.dom('key_press', { key: a.key, ref: a.ref, ctrl: a.ctrl, shift: a.shift, alt: a.alt }),
});

def({
  id: 'drag_element',
  name: 'Drag element',
  category: 'write',
  description: 'Drag an element to a target ref, coordinates, or by dx/dy offset (fires drag gesture).',
  args: [
    { name: 'ref', type: 'string', required: true, desc: 'source elN/fN ref' },
    { name: 'toRef', type: 'string', required: false, desc: 'target element ref' },
    { name: 'dx', type: 'number', required: false, desc: 'horizontal offset' },
    { name: 'dy', type: 'number', required: false, desc: 'vertical offset' },
  ],
  run: (ctx, a) => ctx.dom('drag', { ref: a.ref, toRef: a.toRef, dx: a.dx, dy: a.dy, toX: a.toX, toY: a.toY }),
});

def({
  id: 'focus_element',
  name: 'Focus element',
  category: 'write',
  description: 'Focus an element (like Tab navigation) without clicking.',
  args: [
    { name: 'ref', type: 'string', required: false, desc: 'elN or fN ref' },
    { name: 'text', type: 'string', required: false, desc: 'or match by label text' },
  ],
  run: (ctx, a) => ctx.dom('focus', { ref: a.ref, text: a.text }),
});

def({
  id: 'clipboard_write',
  name: 'Write clipboard',
  category: 'write',
  description: 'Copy text to the clipboard.',
  args: [{ name: 'text', type: 'string', required: true, desc: 'text to copy' }],
  run: (ctx, a) => ctx.dom('clipboard_write', { text: a.text }),
});

/* ---- waiting / observation (self-correction loop) ------------------------ */

def({
  id: 'wait_seconds',
  name: 'Wait',
  category: 'write',
  description: 'Pause for N seconds (useful between steps that trigger async work).',
  args: [{ name: 'seconds', type: 'number', required: true, desc: 'seconds to wait (max 120)' }],
  run: async (ctx, a) => {
    const s = Math.min(120, Math.max(0, Number(a.seconds) || 1));
    await sleepMs(s * 1000);
    return { ok: true, summary: `waited ${s} second(s)`, waitedSec: s };
  },
});

def({
  id: 'wait_for_element',
  name: 'Wait for element',
  category: 'write',
  description: 'Poll until an element with the given text/label is visible (or a timeout elapses).',
  args: [
    { name: 'text', type: 'string', required: true, desc: 'text or label to wait for' },
    { name: 'timeoutSec', type: 'number', required: false, desc: 'timeout in seconds (default 10)' },
  ],
  run: async (ctx, a) => {
    const text = String(a.text || '').trim();
    if (!text) return { ok: false, error: 'wait_for_element needs text' };
    const timeoutMs = Math.min(30000, Math.max(1000, Number(a.timeoutSec || 10) * 1000));
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const res = await ctx.dom('find_element', { text });
      if (res && res.ok) {
        return { ok: true, summary: `"${text}" appeared after ${Date.now() - started}ms`, foundAfterMs: Date.now() - started, count: res.count, matches: res.matches };
      }
      await sleepMs(500);
    }
    return { ok: false, error: `"${text}" did not appear within ${Math.round(timeoutMs / 1000)}s` };
  },
});

/* ---- tab / window management --------------------------------------------- */

def({
  id: 'tabs_list',
  name: 'List tabs',
  category: 'write',
  description: 'List every open tab across windows (index, id, url, title, active).',
  run: async (ctx) => {
    if (!ctx.tabs) return { ok: false, error: 'tabs API unavailable' };
    let all = [];
    try {
      all = await ctx.tabs.query({});
    } catch (e) {
      return { ok: false, error: 'tabs.query failed: ' + e.message };
    }
    const tabs = all.map((t, i) => ({ index: i, id: t.id, active: !!t.active, pinned: !!t.pinned, windowId: t.windowId, url: String(t.url || '').slice(0, 200), title: String(t.title || '').slice(0, 120) }));
    return { ok: true, summary: `${tabs.length} tab(s) open`, count: tabs.length, tabs };
  },
});

def({
  id: 'tab_open',
  name: 'Open tab',
  category: 'write',
  description: 'Open a new tab with a URL.',
  args: [{ name: 'url', type: 'string', required: true, desc: 'full URL' }],
  run: async (ctx, a) => {
    if (!ctx.tabs) return { ok: false, error: 'tabs API unavailable' };
    const url = String(a.url || '').trim();
    if (!url) return { ok: false, error: 'tab_open needs a url' };
    const tab = await ctx.tabs.create({ url, active: true });
    return { ok: true, summary: `opened ${String(url).slice(0, 60)}`, tabId: tab && tab.id, url };
  },
});

def({
  id: 'tab_switch',
  name: 'Switch tab',
  category: 'write',
  description: 'Activate a tab by its list index (from tabs_list) or id.',
  args: [
    { name: 'index', type: 'number', required: false, desc: 'index from tabs_list' },
    { name: 'id', type: 'number', required: false, desc: 'or numeric tab id' },
  ],
  run: async (ctx, a) => {
    if (!ctx.tabs) return { ok: false, error: 'tabs API unavailable' };
    let tabId = null;
    if (a.id != null) tabId = Number(a.id);
    else if (a.index != null) {
      const all = await ctx.tabs.query({});
      const t = all[Number(a.index)];
      if (!t) return { ok: false, error: 'no tab at index ' + a.index };
      tabId = t.id;
    } else return { ok: false, error: 'tab_switch needs index or id' };
    await ctx.tabs.update(tabId, { active: true });
    const t = await ctx.tabs.get(tabId);
    return { ok: true, summary: `switched to tab ${tabId} — ${String(t.title || t.url || '').slice(0, 60)}`, tabId, title: t.title };
  },
});

def({
  id: 'tab_close',
  name: 'Close tab',
  category: 'write',
  description: 'Close a tab by index or id (omit both to close the current tab).',
  args: [
    { name: 'index', type: 'number', required: false, desc: 'index from tabs_list' },
    { name: 'id', type: 'number', required: false, desc: 'or numeric tab id' },
  ],
  run: async (ctx, a) => {
    if (!ctx.tabs) return { ok: false, error: 'tabs API unavailable' };
    let tabId = null;
    if (a.id != null) tabId = Number(a.id);
    else if (a.index != null) {
      const all = await ctx.tabs.query({});
      const t = all[Number(a.index)];
      if (!t) return { ok: false, error: 'no tab at index ' + a.index };
      tabId = t.id;
    } else {
      const active = await ctx.tabs.query({ active: true, lastFocusedWindow: true });
      tabId = active[0] && active[0].id;
    }
    if (tabId == null) return { ok: false, error: 'no tab to close' };
    await ctx.tabs.remove(tabId);
    return { ok: true, summary: `closed tab ${tabId}`, tabId };
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
    appendChat(sessionId, 'user', msg);
    const history = getChat(sessionId);
    const reply = await chat({ messages: history, tabId: ctx.tabId, config: ctx.config, session: ctx.session });
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

/* ---- end-to-end UI validation (build → click through → verify) ---------- */

const UI_VALIDATE_STEP_HINT = [
  { action: 'click', ref: 'el2', text: 'or button label' },
  { action: 'type', ref: 'f1', value: 'hello' },
  { action: 'check', ref: 'el3' },
  { action: 'check', text: 'Success message' },
  { action: 'select', ref: 'f3', value: 'us' },
  { action: 'submit' },
  { action: 'goto', url: 'https://example.com' },
  { action: 'wait', ms: 500 },
];

def({
  id: 'ui_validate',
  name: 'Validate UI flow',
  category: 'agent',
  description:
    'End-to-end UI test: run an ordered list of steps (click / type / check / select / submit / goto / wait / screenshot) and report pass/fail per step. Each step accepts { action, ref, text, value, expect, failFast }.',
  args: [
    { name: 'steps', type: 'json', required: false, desc: 'array of steps — see description' },
    { name: 'failFast', type: 'boolean', required: false, desc: 'stop on first failure (default true)' },
  ],
  run: async (ctx, a) => {
    const steps = Array.isArray(a.steps) && a.steps.length ? a.steps : null;
    if (!steps) {
      return { ok: false, error: 'ui_validate needs a steps array', hint: UI_VALIDATE_STEP_HINT };
    }
    const failFast = a.failFast !== false;
    const results = [];
    let passed = 0;
    let failed = 0;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i] || {};
      const rec = { step: i + 1, action: { type: String(s.action || '?'), ref: s.ref, value: s.value }, args: { ref: s.ref, text: s.text, value: s.value, url: s.url, dir: s.dir, amount: s.amount, formIndex: s.formIndex } };
      try {
        let r = null;
        switch (s.action) {
          case 'wait':
            await sleepMs(Math.max(0, Number(s.ms) || 300));
            r = { ok: true };
            break;
          case 'check':
            if (s.ref) r = await ctx.dom('element_state', { ref: s.ref });
            else r = await ctx.dom('find_element', { text: s.text || '' });
            r = { ok: !!(r && r.ok), error: r && !r.ok ? r.error : null };
            break;
          case 'click':
            r = await ctx.dom('click', { ref: s.ref, text: s.text });
            break;
          case 'type':
            r = await ctx.dom('type', { ref: s.ref, value: s.value });
            break;
          case 'select':
            r = await ctx.dom('select', { ref: s.ref, value: s.value });
            break;
          case 'scroll':
            r = await ctx.dom('scroll', { dir: s.dir, amount: s.amount });
            break;
          case 'goto':
            r = await ctx.dom('navigate', { url: s.url });
            await sleepMs(800);
            break;
          case 'submit':
            r = await ctx.dom('submit_form', { formIndex: s.formIndex });
            break;
          case 'screenshot': {
            const shot = await ctx.capture();
            r = { ok: !!shot, screenshotId: shot ? shot.id : null, error: shot ? null : 'capture failed' };
            break;
          }
          default:
            r = { ok: false, error: 'unsupported ui_validate step: ' + s.action };
        }
        rec.ok = !!(r && r.ok);
        rec.error = (r && r.error) || null;
        rec.screenshotId = (r && r.screenshotId) || null;
      } catch (e) {
        rec.ok = false;
        rec.error = e && e.message ? e.message : String(e);
      }
      if (rec.ok) passed++;
      else failed++;
      results.push(rec);
      if (!rec.ok && failFast) break;
    }
    return {
      ok: failed === 0,
      summary: `${passed} passed, ${failed} failed across ${results.length} step(s)`,
      passed,
      failed,
      total: results.length,
      failFast,
      steps: results,
      body: `${passed} passed, ${failed} failed across ${results.length} step(s) of ${steps.length}`,
    };
  },
});

/* ---- visual before/after check (debug: repro → verify) ------------------ */

const visualBaselines = new Map(); // url -> signature

def({
  id: 'visual_check',
  name: 'Visual check',
  category: 'agent',
  description:
    'Capture the screen and compare it to the stored baseline for this URL. First run stores the baseline; later runs report how much the page changed and where.',
  args: [
    { name: 'url', type: 'string', required: false, desc: 'baseline key (defaults to "current")' },
    { name: 'reset', type: 'boolean', required: false, desc: 'replace the stored baseline' },
  ],
  run: async (ctx, a) => {
    const dataUrl = await ctx.capture();
    if (!dataUrl) return { ok: false, error: 'visual_check needs a screenshot (capture failed)' };
    const key = String(a.url || 'current');
    const sig = await imageSignature(dataUrl);
    if (!sig) return { ok: true, available: false, note: 'image decoding unavailable in this environment', summary: 'visual diff not available here (no image decoder)' };
    const prev = visualBaselines.get(key);
    if (!prev || a.reset) {
      visualBaselines.set(key, sig);
      return { ok: true, baseline: true, stored: true, summary: `baseline stored for "${key}"`, key, cells: sig.cells };
    }
    const diff = pixelDiff(prev, sig);
    const changed = diff.score > 0.05;
    return {
      ok: true,
      baseline: false,
      changed,
      summary: changed ? `page changed: diff ${Math.round(diff.score * 100)}% across ${diff.changedCells} zone(s)` : 'page unchanged (within tolerance)',
      diffScore: diff.score,
      changedCells: diff.changedCells,
      key,
      zones: changed ? null : undefined,
    };
  },
});

/* ---- deep research (plan → search → synthesize, Gemini-style) ----------- */

def({
  id: 'deep_research',
  name: 'Deep research',
  category: 'agent',
  description:
    'Multi-step research report: plan queries, gather sources (live web search when a real provider + research opt-in is set, offline otherwise), and synthesize a cited report.',
  args: [
    { name: 'topic', type: 'string', required: true, desc: 'what to research' },
    { name: 'depth', type: 'number', required: false, desc: 'queries per pass, 2-7 (default 3)' },
    { name: 'async', type: 'boolean', required: false, desc: 'run in the background and poll with task_status' },
  ],
  run: async (ctx, a) => {
    const topic = String(a.topic || '').trim();
    if (!topic) return { ok: false, error: 'deep_research needs a topic' };
    const depth = Math.min(7, Math.max(2, Number(a.depth) || 3));
    if (ctx.reportProgress) ctx.reportProgress({ status: 'running', stage: 'planning', pct: 5 });
    const plan = await planResearch(topic, depth, { isMock: ctx.isMock(), config: ctx.config });
    if (ctx.isCancelled && ctx.isCancelled()) return { ok: false, cancelled: true, error: 'deep_research cancelled during planning' };
    const live = !ctx.isMock() && !!ctx.config && ctx.config.research && ctx.config.research.enabled !== false;
    const sources = [];
    if (ctx.reportProgress) ctx.reportProgress({ status: 'running', stage: 'searching', pct: 15 });
    for (let i = 0; i < plan.queries.length; i++) {
      if (ctx.isCancelled && ctx.isCancelled()) return { ok: false, cancelled: true, error: 'deep_research cancelled during search' };
      const res = await webSearch(plan.queries[i], { maxResults: depth, live });
      sources.push(...res.sources);
      if (ctx.reportProgress) ctx.reportProgress({ status: 'running', stage: 'searching', pct: 15 + Math.round(((i + 1) / plan.queries.length) * 55) });
    }
    if (ctx.reportProgress) ctx.reportProgress({ status: 'running', stage: 'synthesizing', pct: 75 });
    const report = await synthesizeReport(topic, plan, sources, { isMock: ctx.isMock(), config: ctx.config });
    if (ctx.reportProgress) ctx.reportProgress({ status: 'done', stage: 'done', pct: 100 });
    return {
      ok: true,
      topic,
      provider: report.provider,
      model: report.model,
      summary: report.summary,
      report: report.body,
      live,
      sources: sources.slice(0, 40),
      citations: sources.length,
      plan: plan.steps,
    };
  },
});

/* ---- background task status (Gemini-style background execution + polling) */

def({
  id: 'task_status',
  name: 'Task status',
  category: 'agent',
  description: 'Poll the status of a background task (run abilities with async: true).',
  args: [{ name: 'taskId', type: 'string', required: true, desc: 'task id from an async run' }],
  run: async (ctx, a) => {
    const id = String(a.taskId || '').trim();
    if (!id) return { ok: false, error: 'task_status needs a taskId' };
    if (!ctx.taskStatus) return { ok: false, error: 'task store unavailable' };
    const t = ctx.taskStatus(id);
    if (!t) return { ok: false, error: 'no task with id ' + id };
    return {
      ok: true,
      summary: `task ${id.slice(0, 8)} is ${t.status}${(t.progress && t.progress.stage) ? ' (' + t.progress.stage + ')' : ''}`,
      taskId: id,
      ability: t.ability,
      status: t.status,
      stage: (t.progress && t.progress.stage) || '',
      pct: (t.progress && t.progress.pct) || 0,
      error: t.error || '',
    };
  },
});

def({
  id: 'task_cancel',
  name: 'Cancel task',
  category: 'agent',
  description: 'Request cancellation of a running background task (takes effect between deep-research phases).',
  args: [{ name: 'taskId', type: 'string', required: true, desc: 'task id from an async run' }],
  run: async (ctx, a) => {
    const id = String(a.taskId || '').trim();
    if (!id) return { ok: false, error: 'task_cancel needs a taskId' };
    if (!ctx.taskStatus) return { ok: false, error: 'task store unavailable' };
    const t = ctx.taskStatus(id);
    if (!t) return { ok: false, error: 'no task with id ' + id };
    t.cancelled = true;
    t.status = 'cancelling';
    return { ok: true, summary: `cancellation requested for task ${id.slice(0, 8)}`, taskId: id, status: 'cancelling' };
  },
});

/* ---- MCP connectivity (Claude-first: prefer the server's own tools) ----- */

const mcpClients = new Map(); // name -> client

def({
  id: 'mcp_connect',
  name: 'Connect MCP server',
  category: 'agent',
  description: 'Connect to a Model Context Protocol server (Streamable HTTP) and load its tools, like Claude Desktop / Gemini do.',
  args: [
    { name: 'url', type: 'string', required: true, desc: 'http(s) MCP endpoint' },
    { name: 'name', type: 'string', required: false, desc: 'name to remember it by (default: host)' },
  ],
  run: async (ctx, a) => {
    const url = String(a.url || '').trim();
    if (!/^https?:\/\//.test(url)) return { ok: false, error: 'mcp_connect needs an http(s) URL' };
    const client = await connectMcp(url, { name: a.name });
    mcpClients.set(client.name, client);
    let tools = [];
    try {
      tools = await listTools(client);
    } catch (e) {
      tools = [];
    }
    return {
      ok: true,
      summary: `connected to ${client.name} (${tools.length} tool(s) loaded)`,
      name: client.name,
      url,
      server: client.serverInfo,
      protocol: client.protocolVersion,
      tools: tools.map((t) => t.name),
      toolCount: tools.length,
    };
  },
});

def({
  id: 'mcp_tools',
  name: 'MCP server tools',
  category: 'agent',
  description: 'List the tools of a connected MCP server.',
  args: [{ name: 'name', type: 'string', required: false, desc: 'server name (default: first connected)' }],
  run: async (ctx, a) => {
    const name = String(a.name || '').trim();
    const client = name ? mcpClients.get(name) : mcpClients.values().next().value;
    if (!client) return { ok: false, error: 'no MCP server connected — run mcp_connect first', connected: [...mcpClients.keys()] };
    const tools = await listTools(client);
    return {
      ok: true,
      summary: `${tools.length} tool(s) on ${client.name}`,
      name: client.name,
      tools: tools.map((t) => ({ name: t.name, description: String(t.description || '').slice(0, 200) })),
    };
  },
});

def({
  id: 'mcp_call',
  name: 'Call MCP tool',
  category: 'agent',
  description: 'Call a tool on a connected MCP server with JSON arguments.',
  args: [
    { name: 'tool', type: 'string', required: true, desc: 'tool name' },
    { name: 'server', type: 'string', required: false, desc: 'server name (default: first connected)' },
    { name: 'args', type: 'json', required: false, desc: 'JSON arguments object' },
  ],
  run: async (ctx, a) => {
    const name = String(a.server || '').trim();
    const client = name ? mcpClients.get(name) : mcpClients.values().next().value;
    if (!client) return { ok: false, error: 'no MCP server connected — run mcp_connect first', connected: [...mcpClients.keys()] };
    const tool = String(a.tool || '').trim();
    if (!tool) return { ok: false, error: 'mcp_call needs a tool name' };
    let args = {};
    if (a.args != null) {
      if (typeof a.args === 'string') {
        try {
          args = JSON.parse(a.args);
        } catch {
          return { ok: false, error: 'mcp_call args must be a JSON object' };
        }
      } else if (typeof a.args === 'object') args = a.args;
    }
    const out = await callTool(client, tool, args);
    return {
      ok: true,
      summary: `${name}.${tool} returned ${out.isError ? 'an error' : out.content.length + ' content block(s)'}`,
      server: name,
      tool,
      content: out.content,
      isError: out.isError,
    };
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

def({
  id: 'viewport_set',
  name: 'Resize window',
  category: 'meta',
  description: 'Resize the browser window (visual-debug repro: set a target size, capture, compare).',
  args: [
    { name: 'width', type: 'number', required: true, desc: 'outer window width in px' },
    { name: 'height', type: 'number', required: true, desc: 'outer window height in px' },
  ],
  run: async (ctx, a) => {
    const w = Number(a.width);
    const h = Number(a.height);
    if (!(w > 0) || !(h > 0)) return { ok: false, error: 'viewport_set needs positive width and height' };
    if (!ctx.windows) return { ok: false, error: 'windows API unavailable' };
    let win = null;
    try {
      win = ctx.windows.getLastFocused ? await ctx.windows.getLastFocused() : null;
      if (!win && ctx.windows.getCurrent) win = await ctx.windows.getCurrent();
    } catch (e) {
      return { ok: false, error: 'windows.getLastFocused failed: ' + e.message };
    }
    if (!win) return { ok: false, error: 'no focused window' };
    const upd = await ctx.windows.update(win.id, { width: w, height: h });
    return { ok: true, summary: `window resized to ${upd.width}x${upd.height}`, width: upd.width, height: upd.height };
  },
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
