/**
 * shared/categories.js — coarse site categorization used for a per-session
 * "focus score" and the daily digest. Pure functions, unit-testable, no deps.
 */

const HOST_RULES = [
  { host: 'work', score: 1, hosts: ['github.com', 'gitlab.com', 'bitbucket.org', 'stackoverflow.com', 'stackexchange.com', 'developer.mozilla.org', 'mdn.', 'w3schools.com', 'leetcode.com', 'hackerrank.com', 'codecademy.com', 'coursera.org', 'udemy.com', 'khanacademy.org', 'docs.google.com', 'notion.so', 'linear.app', 'figma.com', 'slack.com', 'atlassian.net', 'jira.com', 'vercel.com', 'netlify.com', 'aws.amazon.com', 'console.cloud.google.com', 'linkedin.com', 'medium.com', 'dev.to', 'huggingface.co', 'arxiv.org', 'typescriptlang.org', 'react.dev', 'vuejs.org', 'nodejs.org', 'python.org', 'npmjs.com', 'eslint.org'] },
  { host: 'distraction', score: 0, hosts: ['youtube.com', 'netflix.com', 'hulu.com', 'disneyplus.com', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'reddit.com', 'tiktok.com', 'twitch.tv', 'discord.com', '9gag.com', 'pinterest.com', 'imgur.com', 'buzzfeed.com', 'spotify.com', 'soundcloud.com', 'roblox.com'] },
  { host: 'neutral', score: 0.5, hosts: ['google.com', 'bing.com', 'duckduckgo.com', 'search.brave.com', 'yahoo.com', 'gmail.com', 'outlook.com', 'mail.google.com', 'amazon.com', 'walmart.com', 'ebay.com', 'etsy.com', 'nytimes.com', 'cnn.com', 'bbc.com', 'theguardian.com', 'wikipedia.org', 'weather.com'] },
];

/** Classify a hostname; falls through work → distraction → neutral → default. */
export function categoryOf(rawUrl) {
  let host = '';
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    host = String(rawUrl || '').toLowerCase();
  }
  if (host.startsWith('www.')) host = host.slice(4);
  for (const rule of HOST_RULES) {
    if (rule.hosts.some((h) => host === h || (h.endsWith('.') && host.startsWith(h)) || host.endsWith('.' + h))) {
      return { host, score: rule.score, label: rule.host };
    }
  }
  return { host, score: 0.5, label: 'unknown' };
}

/** Approximate per-session focus from its page history (0..1). */
export function focusScoreOf(pages) {
  const list = (pages || []).filter((p) => p && p.url);
  if (!list.length) return null;
  const buckets = { work: 0, neutral: 0, distraction: 0, unknown: 0 };
  let sum = 0;
  for (const p of list) {
    const cat = categoryOf(p.url);
    sum += cat.score;
    buckets[cat.label] = (buckets[cat.label] || 0) + 1;
  }
  return {
    score: Math.round((sum / list.length) * 100) / 100,
    buckets,
    pages: list.length,
  };
}

/** Group page URLs by host with counts + category, for digests. */
export function topSites(pages, n = 10) {
  const counts = new Map();
  for (const p of pages || []) {
    const cat = categoryOf(p.url);
    const key = cat.host || p.url;
    const cur = counts.get(key) || { host: cat.host, n: 0, category: cat.label, url: p.url };
    cur.n++;
    counts.set(key, cur);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n).slice(0, n);
}
