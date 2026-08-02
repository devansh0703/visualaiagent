/**
 * shared/goals.js — daily productivity goals evaluated against the attention
 * timeline. Pure functions, unit-testable.
 */
import { attentionByHost } from './attention.js';
import { categoryOf } from './categories.js';

/**
 * Check the daily "distraction budget" goal against a slice of events.
 *
 * @param {Array} events recent telemetry events (the goal window)
 * @param {object} config full config (reads config.goals)
 * @param {{nowMs?:number}} opts
 * @returns {{triggered:boolean,limitMs:number,distractionMs:number,overByMs:number,ratio:number,breakdown:Array}|null}
 *   null when the goal is disabled or not exceeded.
 */
export function checkDistractionGoal(events, config = {}, opts = {}) {
  const g = config.goals || {};
  if (!g.enabled) return null;
  const limitMinutes = g.distractionsMinutes || 60;
  const limitMs = limitMinutes * 60 * 1000;

  const { byHost } = attentionByHost(events, { nowMs: opts.nowMs });
  let distractionMs = 0;
  const breakdown = [];
  for (const [host, ms] of Object.entries(byHost)) {
    const cat = categoryOf('https://' + host);
    if (cat.score === 0) {
      distractionMs += ms;
      breakdown.push({ host, ms, label: cat.label });
    }
  }
  if (distractionMs <= limitMs) return null;
  return {
    triggered: true,
    limitMs,
    distractionMs,
    overByMs: distractionMs - limitMs,
    ratio: Math.round((distractionMs / limitMs) * 100) / 100,
    breakdown: breakdown.sort((a, b) => b.ms - a.ms).slice(0, 10),
  };
}

/** Minutes of distraction time from a check result (rounded to 1dp). */
export function distractionMinutes(check) {
  if (!check) return 0;
  return Math.round((check.distractionMs / 60000) * 10) / 10;
}
