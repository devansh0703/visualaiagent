/**
 * test/integration/vision-groq.mjs — live test of the Groq vision provider.
 *
 * Skips (passes) when GROQ_API_KEY is not available, so it is safe to run in CI.
 * Generate a key at https://console.groq.com and set it as an environment
 * variable or in a local .env file (gitignored).
 *
 * Run: GROQ_API_KEY=gsk_… npm run test:integration
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { analyze } from '../../background/vision.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Load .env (simple KEY=VALUE lines) if present — never commit .env.
function loadEnv() {
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !m[2].startsWith('#')) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();

const API_KEY = process.env.GROQ_API_KEY || '';

/** Build a small valid PNG (solid color) as a data URL — enough for vision. */
function tinyPngDataUrl(width = 32, height = 32, [r, g, b] = [0, 120, 215]) {
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const typeBuf = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
    return Buffer.concat([len, typeBuf, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

test('groq provider analyzes a screenshot with a real API key', { skip: !API_KEY ? 'GROQ_API_KEY not set — skipping live provider test' : false }, async () => {
  // Groq's free on_demand tier is token-rate-limited and vision requests are
  // token-heavy, so use a small output budget and retry on 429.
  const run = () =>
    analyze({
      config: { vision: { provider: 'groq', apiKey: API_KEY, enabled: true, maxTokens: 1024 } },
      context: {
        url: 'https://example.com',
        title: 'Integration test',
        dataUrl: tinyPngDataUrl(),
        recentEvents: [{ type: 'click', summary: 'clicked login' }],
      },
    });
  let result;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      result = await run();
      break;
    } catch (e) {
      if (!/429/.test(e.message) || attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 25000));
    }
  }
  assert.equal(result.provider, 'groq');
  assert.ok(result.summary, 'should have a summary');
  assert.ok(typeof result.raw?.screen?.summary === 'string');
  assert.ok(result.model, 'should report the model used');
  console.log(`[groq] model=${result.model} summary=${JSON.stringify(result.summary).slice(0, 120)}`);
});
