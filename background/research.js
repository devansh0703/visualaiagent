/**
 * research.js — the deep-research engine behind the `deep_research` ability.
 * Implements the Gemini Deep Research Agent workflow at browser level:
 * plan → execute (web searches) → synthesize a cited report.
 *
 * Privacy-first: live web search only runs when a real vision provider is
 * configured AND the user opted in (research.enabled !== false). Otherwise a
 * deterministic offline synthesizer produces the same structure, so the whole
 * flow is unit-testable and works in the E2E run with zero network.
 */
import * as vision from './vision.js';

/* ------------------------------- planning -------------------------------- */

const FACETS = [
  (t) => `what is ${t} and how does it work`,
  (t) => `${t} recent developments and current status`,
  (t) => `${t} practical applications and use cases`,
  (t) => `${t} pros, cons and limitations`,
  (t) => `compare ${t} with alternatives`,
  (t) => `${t} best practices and recommendations`,
  (t) => `the future outlook for ${t}`,
];

export async function planResearch(topic, depth = 3, { isMock = true, config } = {}) {
  const d = Math.min(FACETS.length, Math.max(2, Number(depth) || 3));
  if (!isMock && config) {
    try {
      const res = await vision.chat({
        config,
        system: 'You are a research planner. Given a topic, return a JSON array of research queries to run.',
        prompt: `Topic: ${topic}\nReturn a JSON array of ${d} distinct web-search queries (each a string).`,
        maxTokens: 400,
      });
      const arr = vision.extractJSON(res.text);
      if (Array.isArray(arr) && arr.length >= 2) {
        const queries = arr.slice(0, d).map(String);
        return { topic, queries, steps: queries.map((q, i) => `${i + 1}. ${q}`) };
      }
    } catch {}
  }
  const queries = [];
  for (let i = 0; i < d; i++) queries.push(FACETS[i](topic));
  return { topic, queries, steps: queries.map((q, i) => `${i + 1}. ${q}`) };
}

/* ------------------------------- searching ------------------------------- */

function syntheticSources(query, max) {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2).slice(0, 5).join(' ');
  return Array.from({ length: max }, (_, i) => ({
    title: `${query} — reference ${i + 1}`,
    url: `https://example.com/research/${encodeURIComponent(words.replace(/\s+/g, '-'))}?r=${i + 1}`,
    snippet: `Overview of "${query}" (offline result #${i + 1}): key aspects of ${words}, background, and practical implications.`,
    query,
    synthetic: true,
  }));
}

function parseDdg(html, max, query) {
  const out = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi;
  const snipRe = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gi;
  const titles = [];
  const snippets = [];
  let m;
  while ((m = re.exec(html)) && titles.length < max) titles.push({ href: m[1], text: stripHtml(m[2]) });
  while ((m = snipRe.exec(html)) && snippets.length < max) snippets.push(stripHtml(m[1]));
  for (let i = 0; i < titles.length; i++) {
    const href = decodeDdgUrl(titles[i].href);
    if (!href) continue;
    out.push({ title: titles[i].text, url: href, snippet: snippets[i] || '', query, synthetic: false });
  }
  return out.slice(0, max);
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}

function decodeDdgUrl(href) {
  try {
    if (!href) return null;
    const u = new URL(href, 'https://duckduckgo.com');
    if (u.hostname === 'duckduckgo.com' && u.searchParams.has('uddg')) {
      const real = u.searchParams.get('uddg');
      if (real) return real;
    }
    if (/^https?:\/\//.test(href)) return href;
    return null;
  } catch {
    return null;
  }
}

/**
 * Search the web for a query. `live` is only true when the user is on a real
 * provider and opted in; otherwise we return deterministic synthetic results so
 * nothing is ever sent to a third-party search engine without consent.
 */
export async function webSearch(query, opts = {}) {
  const max = Math.min(8, Number(opts.maxResults) || 3);
  const live = opts.live === true;
  let sources = [];
  if (live) {
    try {
      const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
        headers: { 'User-Agent': 'Mozilla/5.0 (VisualAIAgent; research)' },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) sources = parseDdg(await res.text(), max, query);
    } catch {}
  }
  if (!sources.length) sources = syntheticSources(query, max);
  return { query, count: sources.length, sources, live: sources.some((s) => !s.synthetic) };
}

/* ------------------------------ synthesis -------------------------------- */

const REPORT_SYSTEM = `You are a deep-research analyst. You receive a research topic, the plan of queries used, and a list of sources with citations.
Synthesize a well-structured report. Start with a 2-3 sentence executive summary. Then group findings under clear headings. Cite sources inline as [1], [2], etc.
Be factual, note uncertainty, and avoid invented numbers.`;

export async function synthesizeReport(topic, plan, sources, { isMock = true, config } = {}) {
  const cited = sources.map((s, i) => `${i + 1}. ${s.title} — ${s.url}`).join('\n');
  if (!isMock && config) {
    try {
      const res = await vision.chat({
        config,
        system: REPORT_SYSTEM,
        prompt: `TOPIC: ${topic}\nPLAN:\n${plan.steps.join('\n')}\n\nSOURCES:\n${cited}\n\nWrite the report.`,
        maxTokens: 2200,
      });
      return { provider: res.provider, model: res.model, summary: String(res.text).slice(0, 220), body: res.text };
    } catch {}
  }
  const lines = [`# Deep research: ${topic}`, ''];
  for (const q of plan.queries) {
    const hits = sources.filter((s) => s.query === q);
    lines.push(`## ${q}`);
    if (!hits.length) {
      lines.push('  (no sources gathered for this query)');
      continue;
    }
    for (const s of hits) {
      const idx = sources.indexOf(s) + 1;
      lines.push(`- ${s.title} — ${s.snippet} [${idx}]`);
    }
    lines.push('');
  }
  lines.push(`## Sources (${sources.length})`);
  sources.forEach((s, i) => lines.push(`${i + 1}. ${s.title} — ${s.url}`));
  const body = lines.join('\n');
  const summary = `Researched "${topic}" across ${sources.length} source(s) and ${plan.queries.length} query(ies).`;
  return { provider: 'mock', model: 'mock-research', summary, body };
}
