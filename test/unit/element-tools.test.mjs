import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { mkEl, makeDocument, sandboxWith } from '../support/dom-shim.mjs';

const code = readFileSync(fileURLToPath(new URL('../../content/element-tools.js', import.meta.url)), 'utf8');

function loadTools(doc) {
  const sandbox = sandboxWith({ document: doc });
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'element-tools.js' });
  return sandbox.VAIA.tools;
}

test('describeElement produces a full descriptor for a link', () => {
  const html = mkEl('html');
  const link = mkEl('a', { attrs: { href: '/about', id: 'nav-about', 'aria-label': 'About us' }, text: 'About', parent: html });
  const tools = loadTools(makeDocument(html));
  const d = tools.describeElement(link, { targetIsInteractive: true });
  assert.equal(d.tag, 'a');
  assert.equal(d.role, 'link');
  assert.equal(d.href, '/about');
  assert.equal(d.id, 'nav-about');
  assert.equal(d.ariaLabel, 'About us');
  assert.ok(d.fingerprint.includes('nav-about'));
  assert.ok(d.xpath.includes('nav-about'));
  assert.ok(d.cssSelector.includes('#nav-about'));
  assert.equal(d.sensitive, false);
  assert.equal(d.interactive, true);
});

test('closestInteractive climbs to a button for a nested span', () => {
  const html = mkEl('html');
  const btn = mkEl('button', { parent: html });
  const span = mkEl('span', { text: 'label', parent: btn });
  const tools = loadTools(makeDocument(html));
  const got = tools.closestInteractive(span);
  assert.equal(got.tagName, 'BUTTON');
});

test('isSensitiveElement detects password and card fields', () => {
  const html = mkEl('html');
  const pwd = mkEl('input', { attrs: { type: 'password', name: 'current-password' }, parent: html });
  const card = mkEl('input', { attrs: { name: 'card_number' }, parent: html });
  const search = mkEl('input', { attrs: { type: 'search', name: 'q' }, parent: html });
  const tools = loadTools(makeDocument(html));
  assert.equal(tools.isSensitiveElement(pwd), true);
  assert.equal(tools.isSensitiveElement(card), true);
  assert.equal(tools.isSensitiveElement(search), false);
});

test('describeElement redacts value for sensitive inputs', () => {
  const html = mkEl('html');
  const pwd = mkEl('input', { attrs: { type: 'password' }, value: 'supersecret', parent: html });
  const tools = loadTools(makeDocument(html));
  const d = tools.describeElement(pwd, { includeValue: true });
  assert.equal(d.text, '[REDACTED]');
  assert.equal(d.sensitive, true);
  assert.ok(!JSON.stringify(d).includes('supersecret'));
});

test('sanitizeText masks card and SSN patterns', () => {
  const tools = loadTools(makeDocument(mkEl('html')));
  assert.equal(tools.sanitizeText('card 4111111111111111 ok'), 'card [CARD] ok');
  assert.equal(tools.sanitizeText('123-45-6789'), '[SSN]');
});

test('getXPath uses id when present', () => {
  const html = mkEl('html');
  const div = mkEl('div', { attrs: { id: 'app' }, parent: html });
  const tools = loadTools(makeDocument(html));
  const xp = tools.getXPath(div);
  assert.ok(xp.includes('@id="app"'));
});

test('pageSummary tolerates missing DOM features', () => {
  const tools = loadTools(makeDocument(mkEl('html')));
  const sum = tools.pageSummary(5);
  assert.ok(typeof sum.title === 'string');
  assert.ok(Array.isArray(sum.elements));
});

test('getRole maps tags and roles', () => {
  const tools = loadTools(makeDocument(mkEl('html')));
  assert.equal(tools.getRole(mkEl('a', { attrs: { href: '#' } })), 'link');
  assert.equal(tools.getRole(mkEl('button')), 'button');
  assert.equal(tools.getRole(mkEl('input', { attrs: { type: 'checkbox' } })), 'checkbox');
  assert.equal(tools.getRole(mkEl('nav')), 'navigation');
  assert.equal(tools.getRole(mkEl('div', { attrs: { role: 'dialog' } })), 'dialog');
});
