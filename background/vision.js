/**
 * vision.js — vision-language analysis of captured screenshots across multiple
 * providers: NVIDIA NIM, OpenAI, Anthropic, Google Gemini, OpenRouter, Ollama
 * and a local mock (no key / offline). Every provider is asked to return the same JSON
 * schema, which we parse defensively.
 *
 * Model strategy: `vision.autoModel` (default on) auto-discovers the SMALLEST
 * vision-capable model the provider offers (cheapest / fastest) and uses it.
 * If a call fails with a non-rate-limit error, `vision.modelFallbacks` walks a
 * per-provider fallback chain before giving up.
 */
import { defaultModels } from '../shared/config.js';
import { now } from '../shared/utils.js';

/** Per-provider fallback chains, cheapest/smallest first. */
const FALLBACK_MODELS = {
  nvidia: ['meta/llama-3.2-11b-vision-instruct', 'meta/llama-3.2-90b-vision-instruct'],
  openai: ['gpt-4o-mini', 'gpt-4o'],
  anthropic: ['claude-sonnet-4-5'],
  gemini: ['gemini-2.5-flash'],
  groq: ['qwen/qwen3.6-27b'],
  openrouter: ['openai/gpt-4o-mini', 'openai/gpt-4o'],
  ollama: ['llama3.2-vision'],
  mock: ['mock-vision'],
};

/** Providers whose /models endpoint we can query to auto-pick the smallest model. */
const DISCOVERABLE = new Set(['openai', 'groq', 'openrouter']);
const modelCache = new Map(); // key -> { ts, list }

async function discoverModels({ provider, baseUrl, apiKey }) {
  if (!DISCOVERABLE.has(provider)) return [];
  const base = (baseUrl || { openai: 'https://api.openai.com/v1', groq: 'https://api.groq.com/openai/v1', openrouter: 'https://openrouter.ai/api/v1' }[provider]);
  const cacheKey = `${provider}|${base}`;
  const hit = modelCache.get(cacheKey);
  if (hit && now() - hit.ts < 6 * 60 * 60 * 1000) return hit.list;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(`${base}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const json = await res.json();
    const list = (json.data || [])
      .filter((m) => Array.isArray(m.input_modalities) && m.input_modalities.includes('image'))
      .sort((a, b) => (a.context_window || 1e12) - (b.context_window || 1e12))
      .map((m) => ({ id: m.id, contextWindow: m.context_window || 0, maxTokens: m.max_completion_tokens || 0 }));
    if (list.length) modelCache.set(cacheKey, { ts: now(), list });
    return list;
  } catch {
    return [];
  }
}

function dedupeModels(list) {
  const seen = new Set();
  const out = [];
  for (const m of list) {
    if (!m || seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

/** Build the ordered list of model candidates for a provider. */
export async function buildModelCandidates(vision, provider) {
  const configured = (vision && vision.model) || defaultModels()[provider] || defaultModels().mock;
  const list = [configured];
  if (vision && vision.autoModel !== false) {
    const found = await discoverModels({ provider, baseUrl: vision.baseUrl, apiKey: vision.apiKey });
    if (found.length) list.unshift(found[0].id); // smallest first
  }
  if (vision && vision.modelFallbacks !== false) {
    for (const m of FALLBACK_MODELS[provider] || []) list.push(m);
  }
  return dedupeModels(list);
}

function isRateLimit(err) {
  return /429|rate.?limit/i.test((err && err.message) || '');
}

const SYSTEM_PROMPT = `You are the visual perception module of a browser screen-intelligence agent.
You receive a screenshot of a user's browser tab plus a small log of recent activity.
Analyze the screenshot and return STRICT JSON (no markdown) with this exact schema:
{
  "screen": {
    "type": "browser|login|dashboard|form|article|media|ecommerce|error_page|blank|other",
    "summary": "one-sentence description of what is visible",
    "text": "up to 400 chars of visible text on screen",
    "keyElements": [{"element":"button|input|link|menu|banner|card|modal|chart|video|other","label":"short label","approx":true}]
  },
  "user": {
    "activity": "reading|browsing|filling_form|searching|shopping|watching|idle|error_frustrated|other",
    "intent": "short guess at what the user is trying to do"
  },
  "signals": {
    "frustration": 0.0,
    "confusion": 0.0,
    "engagement": 0.0
  },
  "anomalies": ["layout_issue|blank_page|error_dialog|broken_element|other", ...],
  "promptInjection": {"detected": false, "detail": ""},
  "recommendations": ["concrete next actions for the user"],
  "privacy": {"sensitiveVisible": false}
}
Do NOT output a thinking/reasoning block. Output ONLY the JSON object and nothing else.`;

function dataUrlParts(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || '');
  return m ? { mime: m[1], b64: m[2] } : { mime: 'image/jpeg', b64: dataUrl || '' };
}

function buildPrompt(context) {
  const lines = [
    `PAGE: ${context.url || ''}`,
    `TITLE: ${context.title || ''}`,
    `SESSION EVENTS (recent ${(context.recentEvents || []).length}):`,
  ];
  for (const ev of context.recentEvents || []) {
    lines.push(`  - ${ev.tsRel || ''} ${ev.type}: ${ev.summary || ''}`);
  }
  if (context.extra) {
    lines.push(`\nDOM SNAPSHOT:\n${context.extra}`);
  }
  if (context.question) {
    lines.push(`\nUSER QUESTION: ${context.question}\nAnswer this question based on the screenshot and activity above.`);
  }
  return lines.join('\n');
}

async function fetchJson(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 30000);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    return { json, raw: text };
  } finally {
    clearTimeout(timer);
  }
}

function extractJSON(text) {
  if (!text) return null;
  // Thinking/reasoning models (e.g. Qwen on Groq) emit <think>…</think>
  // prose even when the prompt forbids it — strip it before parsing.
  let cleaned = String(text)
    .replace(/```(?:json)?\s*([\s\S]*?)```/g, (m, inner) => inner)
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {}
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    } catch {}
  }
  return null;
}

/* ------------------------------ providers ------------------------------ */

/** OpenAI-compatible APIs expect parts typed 'image_url', not Anthropic's 'image'. */
function normalizeOpenAiContent(content) {
  if (!Array.isArray(content)) return content;
  return content.map((c) => {
    if (c.type === 'image') return { type: 'image_url', image_url: c.image_url };
    if (c.type === 'text') return { type: 'text', text: c.text };
    return c;
  });
}

async function openaiCompatible({ model, baseUrl, apiKey, messages, temperature, maxTokens, timeoutMs, responseFormat = true }) {
  const url = (baseUrl || 'https://api.openai.com/v1') + '/chat/completions';
  const body = {
    model,
    messages: (messages || []).map((m) => ({ ...m, content: normalizeOpenAiContent(m.content) })),
    temperature: temperature ?? 0.2,
    max_tokens: maxTokens || 1024,
  };
  // response_format: json_object is not reliably supported by every
  // OpenAI-compatible endpoint (notably Groq vision models), so it's opt-out.
  if (responseFormat) body.response_format = { type: 'json_object' };
  const { json } = await fetchJson(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    },
    timeoutMs
  );
  return json?.choices?.[0]?.message?.content || '';
}

async function anthropic({ model, baseUrl, apiKey, messages, temperature, maxTokens, timeoutMs }) {
  const url = (baseUrl || 'https://api.anthropic.com') + '/v1/messages';
  const system = messages[0]?.content || SYSTEM_PROMPT;
  const user = messages[1] || messages[0];
  const { json } = await fetchJson(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        system,
        max_tokens: maxTokens || 1024,
        temperature: temperature ?? 0.2,
        messages: [{ role: 'user', content: user.content }],
      }),
    },
    timeoutMs
  );
  return json?.content?.filter((b) => b.type === 'text').map((b) => b.text).join('') || '';
}

async function gemini({ model, baseUrl, apiKey, userContent, temperature, maxTokens, timeoutMs }) {
  const base = baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
  const url = `${base}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const parts = [];
  for (const c of userContent) {
    if (c.type === 'text') parts.push({ text: c.text });
    else if (c.type === 'image') {
      const { mime, b64 } = dataUrlParts(c.image_url?.url || '');
      parts.push({ inline_data: { mime_type: mime, data: b64 } });
    }
  }
  const { json } = await fetchJson(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: temperature ?? 0.2, maxOutputTokens: maxTokens || 1024, responseMimeType: 'application/json' },
      }),
    },
    timeoutMs
  );
  return json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
}

async function ollama({ model, baseUrl, apiKey, userContent, temperature, maxTokens, timeoutMs }) {
  const url = (baseUrl || 'http://localhost:11434') + '/api/chat';
  const text = userContent.find((c) => c.type === 'text')?.text || '';
  const img = userContent.find((c) => c.type === 'image');
  const { mime, b64 } = dataUrlParts(img?.image_url?.url || '');
  void mime;
  const { json } = await fetchJson(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        options: { temperature: temperature ?? 0.2, num_predict: maxTokens || 1024 },
        messages: [{ role: 'user', content: `${text}\n\nAnalyze the attached screenshot.`, images: [b64] }],
      }),
    },
    timeoutMs
  );
  return json?.message?.content || '';
}

function mockVision(context, prompt) {
  const visibleText = prompt;
  const answered = context.question ? `\n${context.question} → (offline) The screenshot shows ${context.title || 'this page'} with no live vision analysis.` : '';
  return JSON.stringify({
    screen: {
      type: context.url ? 'browser' : 'other',
      summary: `[mock] Analyzed a screenshot on ${context.title || 'this page'} (offline analysis).` + answered,
      text: String(visibleText).slice(0, 400),
      keyElements: [],
    },
    user: { activity: 'browsing', intent: 'unknown (offline mock)' },
    signals: { frustration: 0, confusion: 0, engagement: 0.5 },
    anomalies: [],
    promptInjection: { detected: false, detail: '' },
    recommendations: [],
    privacy: { sensitiveVisible: false },
    _mock: true,
  });
}

/* ------------------------------ main entry ------------------------------ */

/**
 * Dispatch a single model call to the right provider. `system` is the system
 * prompt string; `user` is an array of content parts ({type:'text'|'image'}).
 */
async function callProvider({ provider, model, baseUrl, apiKey, system, user, temperature, maxTokens, timeoutMs, responseFormat = true }) {
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  switch (provider) {
    case 'anthropic':
      return anthropic({ model, baseUrl, apiKey, messages, temperature, maxTokens, timeoutMs });
    case 'gemini':
      return gemini({ model, baseUrl, apiKey, userContent: user, temperature, maxTokens, timeoutMs });
    case 'ollama':
      return ollama({ model, baseUrl, apiKey, userContent: user, temperature, maxTokens, timeoutMs });
    case 'openrouter':
      return openaiCompatible({ model, baseUrl: baseUrl || 'https://openrouter.ai/api/v1', apiKey, messages, temperature, maxTokens, timeoutMs });
    case 'groq':
      return openaiCompatible({ model, baseUrl: baseUrl || 'https://api.groq.com/openai/v1', apiKey, messages, temperature, maxTokens, timeoutMs, responseFormat: false });
    case 'nvidia':
      // NVIDIA NIM (integrate.api.nvidia.com) is OpenAI-wire-compatible. The
      // catalog's vision models don't reliably accept response_format, so it's
      // opt-out — output is parsed defensively via extractJSON anyway.
      return openaiCompatible({ model, baseUrl: baseUrl || 'https://integrate.api.nvidia.com/v1', apiKey, messages, temperature, maxTokens, timeoutMs, responseFormat: false });
    case 'openai':
    default:
      return openaiCompatible({ model, baseUrl, apiKey, messages, temperature, maxTokens, timeoutMs, responseFormat });
  }
}

/** Free-form text generation (system + prompt + optional screenshot). Returns {provider, model, ts, text}. */
export async function chat({ config, system = '', prompt = '', dataUrl = '', temperature, maxTokens, timeoutMs }) {
  const vision = config.vision || {};
  const provider = vision.provider || 'mock';
  const candidates = await buildModelCandidates(vision, provider);
  const user = [];
  if (system) user.push({ type: 'text', text: system });
  if (prompt) user.push({ type: 'text', text: prompt });
  if (dataUrl) user.push({ type: 'image', image_url: { url: dataUrl } });
  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i];
    if (provider === 'mock') {
      return { provider, model, ts: Date.now(), text: mockChatText(system, prompt) };
    }
    try {
      const text = await callProvider({
        provider,
        model,
        baseUrl: vision.baseUrl,
        apiKey: vision.apiKey,
        system,
        user,
        temperature: temperature ?? vision.temperature,
        maxTokens: maxTokens ?? vision.maxTokens,
        timeoutMs: timeoutMs ?? vision.timeoutMs,
      });
      return { provider, model, ts: Date.now(), text };
    } catch (e) {
      lastErr = e;
      if (isRateLimit(e) || i === candidates.length - 1) break;
      captureWarn(`${provider}: model ${model} failed (${e.message.slice(0, 120)}) — trying fallback`);
    }
  }
  throw new Error(`${provider}: ${lastErr ? lastErr.message : 'all models failed'}`);
}

function mockChatText(system, prompt) {
  return `[mock] ${String(prompt || '').slice(0, 240)}`;
}

export { extractJSON, dataUrlParts, discoverModels };

export async function analyze({ config, context }) {
  const vision = config.vision || {};
  const provider = vision.provider || 'mock';
  let promptText = buildPrompt(context);
  let systemPrompt = SYSTEM_PROMPT;
  if (vision.language && vision.language.toLowerCase() !== 'en') {
    systemPrompt += `\nRespond in the language: ${vision.language}.`;
  }

  const userContent = [{ type: 'text', text: `${systemPrompt}\n\n${promptText}` }];
  if (context.dataUrl) {
    userContent.push({ type: 'image', image_url: { url: context.dataUrl } });
  }

  const candidates = await buildModelCandidates(vision, provider);
  let lastErr = null;
  let retriedParse = false;
  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i];
    let text = '';
    try {
      if (provider === 'mock') {
        text = mockVision(context, promptText);
      } else {
        text = await callProvider({
          provider,
          model,
          baseUrl: vision.baseUrl,
          apiKey: vision.apiKey,
          system: systemPrompt,
          user: userContent,
          temperature: vision.temperature,
          maxTokens: vision.maxTokens,
          timeoutMs: vision.timeoutMs,
        });
      }
    } catch (e) {
      lastErr = e;
      if (isRateLimit(e) || i === candidates.length - 1) break; // don't burn quota on fallbacks
      captureWarn(`${provider}: model ${model} failed (${e.message.slice(0, 120)}) — trying fallback`);
      continue;
    }

    const json = extractJSON(text);
    if (!json) {
      // Reasoning models (e.g. Groq qwen) occasionally return non-JSON after
      // <think> blocks despite being told not to — retry the final candidate
      // once instead of failing the whole analysis.
      captureWarn(`${provider}: model ${model} returned unparseable output (${text.length} chars)`);
      if (i === candidates.length - 1 && !retriedParse) {
        retriedParse = true;
        i--;
        continue;
      }
      lastErr = new Error(`${provider}: unparseable model output`);
      if (i === candidates.length - 1) break;
      continue;
    }
    return {
      provider,
      model,
      ts: Date.now(),
      raw: json,
      summary: json.screen?.summary || json.user?.intent || 'Screen analyzed',
      confidence: 1 - (json.signals?.confusion || 0),
    };
  }
  const lastMsg = lastErr ? lastErr.message : 'all models failed';
  throw new Error(lastMsg.startsWith(`${provider}:`) ? lastMsg : `${provider}: ${lastMsg}`);
}

function captureWarn(msg) {
  try {
    // eslint-disable-next-line no-console
    console.warn(`[vaia] ${msg}`);
  } catch {}
}
