/**
 * vision.js — vision-language analysis of captured screenshots across multiple
 * providers: OpenAI, Anthropic, Google Gemini, OpenRouter, Ollama and a local
 * mock (no key / offline). Every provider is asked to return the same JSON
 * schema, which we parse defensively.
 */
import { defaultModels } from '../shared/config.js';

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
}`;

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
  const cleaned = String(text).trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(cleaned);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {}
  }
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

async function openaiCompatible({ model, baseUrl, apiKey, messages, temperature, maxTokens, timeoutMs }) {
  const url = (baseUrl || 'https://api.openai.com/v1') + '/chat/completions';
  const body = {
    model,
    messages,
    temperature: temperature ?? 0.2,
    max_tokens: maxTokens || 1024,
    response_format: { type: 'json_object' },
  };
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
  return JSON.stringify({
    screen: {
      type: context.url ? 'browser' : 'other',
      summary: `[mock] Analyzed a screenshot on ${context.title || 'this page'} (offline analysis).`,
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

export async function analyze({ config, context }) {
  const vision = config.vision || {};
  const provider = vision.provider || 'mock';
  const model = vision.model || defaultModels()[provider] || defaultModels().mock;
  const promptText = buildPrompt(context);

  const userContent = [{ type: 'text', text: `${SYSTEM_PROMPT}\n\n${promptText}` }];
  if (context.dataUrl) {
    userContent.push({ type: 'image', image_url: { url: context.dataUrl } });
  }

  let text = '';
  try {
    switch (provider) {
      case 'anthropic':
        text = await anthropic({
          model,
          baseUrl: vision.baseUrl,
          apiKey: vision.apiKey,
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userContent }],
          temperature: vision.temperature,
          maxTokens: vision.maxTokens,
          timeoutMs: vision.timeoutMs,
        });
        break;
      case 'gemini':
        text = await gemini({
          model,
          baseUrl: vision.baseUrl,
          apiKey: vision.apiKey,
          userContent,
          temperature: vision.temperature,
          maxTokens: vision.maxTokens,
          timeoutMs: vision.timeoutMs,
        });
        break;
      case 'ollama':
        text = await ollama({
          model,
          baseUrl: vision.baseUrl,
          apiKey: vision.apiKey,
          userContent,
          temperature: vision.temperature,
          maxTokens: vision.maxTokens,
          timeoutMs: vision.timeoutMs,
        });
        break;
      case 'openrouter':
        text = await openaiCompatible({
          model,
          baseUrl: vision.baseUrl || 'https://openrouter.ai/api/v1',
          apiKey: vision.apiKey,
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userContent }],
          temperature: vision.temperature,
          maxTokens: vision.maxTokens,
          timeoutMs: vision.timeoutMs,
        });
        break;
      case 'mock':
        text = mockVision(context, promptText);
        break;
      case 'openai':
      default:
        text = await openaiCompatible({
          model,
          baseUrl: vision.baseUrl,
          apiKey: vision.apiKey,
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userContent }],
          temperature: vision.temperature,
          maxTokens: vision.maxTokens,
          timeoutMs: vision.timeoutMs,
        });
    }
  } catch (e) {
    throw new Error(`${provider}: ${e.message}`);
  }

  const json = extractJSON(text);
  if (!json) {
    throw new Error(`${provider}: unparseable model output`);
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
