/**
 * options.js — full settings editor. Loads the live config, edits it in place,
 * and saves back to the service worker which persists + broadcasts it.
 */
import { send, el, toast, fmtDateTime, fmtNum } from '../ui.js';
import { MSG, MODES } from '../../shared/protocol.js';
import { visionProviders, defaultModels } from '../../shared/config.js';

let config = {};

const $ = (id) => document.getElementById(id);

function setByPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function getByPath(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function fillForm() {
  document.querySelectorAll('[data-cfg]').forEach((field) => {
    const path = field.dataset.cfg;
    const val = getByPath(config, path);
    if (field.dataset.list) {
      field.value = Array.isArray(val) ? val.join('\n') : '';
      return;
    }
    if (field.type === 'checkbox') field.checked = !!val;
    else if (field.type === 'number') field.value = val ?? '';
    else field.value = val ?? '';
  });
  $('statusLine').textContent = `Monitoring ${config.enabled ? 'enabled' : 'disabled'} · session mode ${config.enabled ? 'monitor' : 'paused'} · device ${config.identity?.device || '—'}`;
}

function collectForm() {
  const patch = {};
  document.querySelectorAll('[data-cfg]').forEach((field) => {
    const path = field.dataset.cfg;
    let val;
    if (field.dataset.list) {
      val = field.value.split('\n').map((s) => s.trim()).filter(Boolean);
    } else if (field.type === 'checkbox') val = field.checked;
    else if (field.type === 'number') {
      val = field.value === '' ? null : Number(field.value);
      if (val !== null && Number.isNaN(val)) val = null;
    } else val = field.value;
    setByPath(patch, path, val);
  });
  // strip nulls (blank optional numbers) so defaults re-apply
  return JSON.parse(JSON.stringify(patch, (k, v) => (v === null ? undefined : v)));
}

async function load() {
  const res = await send({ type: MSG.GET_CONFIG });
  config = res.config || {};
  fillForm();
}

async function save() {
  const patch = collectForm();
  const res = await send({ type: MSG.SAVE_CONFIG, config: patch });
  if (res.ok) {
    config = res.config;
    fillForm();
    toast('Settings saved');
  } else {
    toast('Save failed: ' + (res.error || ''));
  }
}

async function testConn() {
  $('btnTest').disabled = true;
  const patch = collectForm();
  toast('Testing connection…');
  const res = await send({
    type: MSG.TEST_CONNECTION,
    endpoint: patch.db?.endpoint,
    apiKey: patch.db?.apiKey,
  });
  $('btnTest').disabled = false;
  toast(res.ok ? `Connection OK (HTTP ${res.status})` : 'Connection failed: ' + (res.error || res.body || ''));
}

function setupProviderSelect() {
  const select = $('providerSelect');
  const model = $('modelInput');
  select.addEventListener('change', () => {
    if (!model.value || model.dataset.auto === '1') {
      model.value = defaultModels()[select.value] || '';
      model.dataset.auto = '1';
    }
  });
  if (model.value) model.dataset.auto = '0';
  else model.dataset.auto = '1';
}

function wire() {
  $('btnSave').addEventListener('click', save);
  $('btnTest').addEventListener('click', testConn);
  $('btnExport').addEventListener('click', async () => {
    const res = await send({ type: MSG.EXPORT });
    toast(res.ok ? `Exporting ${fmtNum(res.counts.events)} events…` : 'Export failed');
  });
  $('btnClear').addEventListener('click', async () => {
    if (!confirm('Delete ALL locally stored telemetry, screenshots, insights and sessions?')) return;
    const res = await send({ type: MSG.CLEAR_DATA });
    toast(res.ok ? 'Local data cleared' : 'Clear failed');
  });
  $('btnReset').addEventListener('click', async () => {
    if (!confirm('Reset all settings to defaults?')) return;
    const res = await send({ type: MSG.RESET_CONFIG });
    if (res.ok) {
      config = res.config;
      fillForm();
      toast('Reset to defaults');
    }
  });
  document.querySelectorAll('.tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      const panel = document.getElementById('panel-' + btn.dataset.tab);
      if (panel) panel.classList.add('active');
    });
  });
}

wire();
setupProviderSelect();
load();
