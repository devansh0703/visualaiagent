import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJSON, dataUrlParts, analyze } from '../../background/vision.js';
import { baseOf } from '../../background/db.js';
import { isSensitiveUrl } from '../../background/capture.js';
import { visionProviders, defaultModels } from '../../shared/config.js';

test('extractJSON parses fenced JSON', () => {
  const out = extractJSON('```json\n{"a":1}\n```');
  assert.deepEqual(out, { a: 1 });
});

test('extractJSON parses bare JSON', () => {
  assert.deepEqual(extractJSON('{"b":2}'), { b: 2 });
});

test('extractJSON falls back to first object in noisy text', () => {
  const out = extractJSON('Here you go: {"c":3} trailing text');
  assert.deepEqual(out, { c: 3 });
});

test('extractJSON returns null for garbage', () => {
  assert.equal(extractJSON('no json here'), null);
  assert.equal(extractJSON(''), null);
});

test('dataUrlParts splits mime and base64', () => {
  const { mime, b64 } = dataUrlParts('data:image/jpeg;base64,QUJD');
  assert.equal(mime, 'image/jpeg');
  assert.equal(b64, 'QUJD');
});

test('mock provider returns a parseable structured result', async () => {
  const result = await analyze({
    config: { vision: { provider: 'mock', enabled: true } },
    context: { url: 'https://x.com', title: 'Test', dataUrl: 'data:image/jpeg;base64,AAAA', recentEvents: [{ type: 'click', summary: 'hit button' }] },
  });
  assert.equal(result.provider, 'mock');
  assert.equal(result.model, 'mock-vision');
  assert.ok(result.summary);
  assert.ok(typeof result.raw.screen?.type === 'string');
  assert.ok('frustration' in result.raw.signals);
  assert.ok('promptInjection' in result.raw);
});

test('baseOf derives screenshot endpoint base', () => {
  assert.equal(baseOf('https://h/api/events'), 'https://h/api');
  assert.equal(baseOf('https://h/api/events/'), 'https://h/api');
  assert.equal(baseOf('https://h/'), 'https://h');
  assert.equal(baseOf(''), '');
});

test('groq is a registered vision provider with a default model', () => {
  const providers = visionProviders();
  const groq = providers.find((p) => p.id === 'groq');
  assert.ok(groq, 'groq provider should be registered');
  assert.equal(groq.needsKey, true);
  assert.ok(defaultModels().groq, 'groq should have a default model');
});

test('every provider in visionProviders() has a default model', () => {
  const models = defaultModels();
  for (const p of visionProviders()) {
    assert.ok(models[p.id], `missing default model for ${p.id}`);
  }
});

test('isSensitiveUrl matches exact hosts and subdomains', () => {
  const domains = ['bank.example.com', 'mail.com'];
  assert.equal(isSensitiveUrl('https://bank.example.com/dashboard', domains), true);
  assert.equal(isSensitiveUrl('https://secure.mail.com/inbox', domains), true);
  assert.equal(isSensitiveUrl('https://example.com/', domains), false);
  assert.equal(isSensitiveUrl('https://notbank.example.com.evil.net/', domains), false);
  assert.equal(isSensitiveUrl('https://safe.com/', []), false);
  assert.equal(isSensitiveUrl('not-a-url', domains), false);
});
