import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJSON, dataUrlParts, analyze, buildModelCandidates } from '../../background/vision.js';
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

test('extractJSON strips think blocks before parsing', () => {
  const out = extractJSON('<think>\nThe image is a solid blue square.\nSo:\n</think>\n{"screen":{"summary":"A solid blue square"}}');
  assert.deepEqual(out, { screen: { summary: 'A solid blue square' } });
});

test('extractJSON strips fenced think-wrapped JSON', () => {
  const out = extractJSON('```json\n<think>x</think>\n{"a":[1,2]}\n```');
  assert.deepEqual(out, { a: [1, 2] });
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

test('nvidia is the default vision provider with a default model', () => {
  const providers = visionProviders();
  const nvidia = providers.find((p) => p.id === 'nvidia');
  assert.ok(nvidia, 'nvidia provider should be registered');
  assert.equal(nvidia.needsKey, true);
  assert.equal(defaultModels().nvidia, 'meta/llama-3.2-11b-vision-instruct');
  assert.equal(providers[0].id, 'nvidia', 'nvidia should be listed first');
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

test('buildModelCandidates honors explicit model with autoModel off', async () => {
  const list = await buildModelCandidates({ model: 'my/custom-model', autoModel: false, modelFallbacks: false }, 'groq');
  assert.deepEqual(list, ['my/custom-model']);
});

test('buildModelCandidates appends groq fallback chain after default', async () => {
  const list = await buildModelCandidates({ autoModel: false }, 'groq');
  assert.deepEqual(list, ['qwen/qwen3.6-27b']);
});

test('buildModelCandidates dedupes when auto-discovered smallest already in fallbacks', async () => {
  const list = await buildModelCandidates({ autoModel: false, modelFallbacks: true }, 'openai');
  assert.deepEqual(list, ['gpt-4o', 'gpt-4o-mini']);
});

test('analyze answers a question via the mock provider', async () => {
  const res = await analyze({
    config: { vision: { provider: 'mock', autoModel: false } },
    context: { url: 'https://x.com', title: 'Page', question: 'What should I do next?' },
  });
  assert.equal(res.provider, 'mock');
  assert.match(res.summary, /offline/);
  assert.match(res.summary, /What should I do next\?/);
});
