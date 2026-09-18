/**
 * test/evals/vision-quality.test.mjs — eval harness for vision-output quality.
 *
 * Two suites:
 *
 * 1. OFFLINE (runs everywhere, CI-safe): the mock provider's structured
 *    output must satisfy the full screen-report schema — the same shape real
 *    providers are prompted for. Guards the parser and every consumer
 *    (dashboard, digests, insights) against schema drift.
 *
 * 2. LIVE grounded eval (skips without NVIDIA_API_KEY): real images with
 *    known ground truth, asserting the model's answer contains the expected
 *    fact. No modelFallbacks — if the configured model can't answer a
 *    first-grade question about a solid-color image, that's an eval FAILURE,
 *    not a fallback opportunity. Retries on 429 only (free-tier rate limits).
 *
 * Run: npm run evals        (offline suite)
 *      npm run evals:live   (adds the live provider evals)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

// .env loading (same pattern as test/integration/vision-groq.test.mjs)
function loadEnv() {
  try {
    for (const line of readFileSync('.env', 'utf8').split('\n')) {
      const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}
loadEnv();

const { analyze, chat } = await import('../../background/vision.js');
const { DEFAULTS } = await import('../../shared/config.js');

/* ------------------------------ offline suite ----------------------------- */

test('EVAL offline: mock screen report satisfies the full schema', async () => {
  const res = await analyze({
    config: { vision: { provider: 'mock', autoModel: false } },
    context: {
      url: 'https://mail.test/inbox',
      title: 'Inbox — 12 unread',
      recentEvents: [{ type: 'click', summary: 'opened message' }],
    },
  });
  assert.equal(res.provider, 'mock');
  const s = res.raw.screen;
  assert.ok(s, 'screen object present');
  assert.ok(typeof s.summary === 'string' && s.summary.length > 10, 'summary is a real sentence');
  assert.ok(Array.isArray(s.keyElements), 'keyElements array present');
  // user/signals live at the top level of the schema (mirrors SYSTEM_PROMPT).
  assert.ok(['browsing', 'reading', 'filling_form', 'searching', 'other'].includes(res.raw.user?.activity || 'other'));
  for (const k of ['frustration', 'confusion', 'engagement']) {
    const v = res.raw.signals?.[k];
    assert.ok(typeof v === 'number' && v >= 0 && v <= 1, `signal ${k} in 0..1 (got ${v})`);
  }
  assert.equal(res.raw.promptInjection?.detected, false);
});

/* --------------------------- grounded image evals -------------------------- */

const NVIDIA_KEY = process.env.NVIDIA_API_KEY || '';

/** Minimal solid-color PNG of width x height (a valid image the model can see). */
function solidPngDataUrl(width = 64, height = 64, [r, g, b] = [255, 0, 0]) {
  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    const crcOf = (buf) => {
      let c = 0xffffffff;
      for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    };
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crcOf(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type truecolor
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 3 + 1);
    raw[rowStart] = 0; // filter none
    for (let x = 0; x < width; x++) {
      raw[rowStart + 1 + x * 3] = r;
      raw[rowStart + 2 + x * 3] = g;
      raw[rowStart + 3 + x * 3] = b;
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

/** Call with retries ONLY on 429 — quality failures must surface, not hide. */
async function chatWith429Retry(fn, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!/429/.test(e.message) || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 25000));
    }
  }
}

const GROUNDED_CASES = [
  { name: 'solid red', rgb: [255, 0, 0], expect: /red/i, question: 'What is the dominant color of this image? Answer in one word.' },
  { name: 'solid green', rgb: [0, 200, 0], expect: /green/i, question: 'What is the dominant color of this image? Answer in one word.' },
];

for (const tc of GROUNDED_CASES) {
  test(`EVAL live: default NIM model names the ${tc.name} image correctly`, { skip: !NVIDIA_KEY ? 'NVIDIA_API_KEY not set — skipping live eval' : false }, async () => {
    const res = await chatWith429Retry(() =>
      chat({
        config: {
          vision: {
            provider: 'nvidia',
            apiKey: NVIDIA_KEY,
            enabled: true,
            // Deliberately no explicit model: evals validate the DEFAULT
            // experience. (90b is selectable but currently hangs on free-tier
            // NIM accounts — measured, not guessed — so it must never be the
            // default, and evals must not silently fall back to it.)
            autoModel: false,
            modelFallbacks: false,
            timeoutMs: 120000,
            maxTokens: 2048,
          },
        },
        prompt: tc.question,
        dataUrl: solidPngDataUrl(64, 64, tc.rgb),
      }),
    );
    assert.equal(res.provider, 'nvidia');
    assert.match(res.text, tc.expect);
  });
}
