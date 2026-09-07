import { Z_SUM } from './normal.js';

/**
 * Absolute minimum detectable effect in proportion units. Two-proportion z-test,
 * alpha = 0.05 two-sided, power = 0.80.
 *
 * This is computed and reported BEFORE any verdict. At the reference project's volume it is
 * the difference between an honest answer and a confident wrong one: +-15.5pp on
 * signup -> trial over a five-day window means nothing short of a 140% relative lift is
 * visible at all.
 */
export function mde(pPooled: number, nPre: number, nPost: number): number {
  if (nPre <= 0 || nPost <= 0) return Number.POSITIVE_INFINITY;
  const v = pPooled * (1 - pPooled);
  return Z_SUM * Math.sqrt(v * (1 / nPre + 1 / nPost));
}

/**
 * The best MDE reachable with this pre-period no matter how long the post-period runs.
 * Worth reporting when a target is unreachable: the fix is more pre-period, not more waiting.
 */
export function mdeFloor(pPooled: number, nPre: number): number {
  if (nPre <= 0) return Number.POSITIVE_INFINITY;
  return Z_SUM * Math.sqrt((pPooled * (1 - pPooled)) / nPre);
}

/**
 * Post-period sample size needed to reach targetMde. Returns null when the pre-period alone
 * already puts the target out of reach, in which case no amount of waiting helps.
 */
export function nPostNeeded(pPooled: number, nPre: number, targetMde: number): number | null {
  const v = pPooled * (1 - pPooled);
  if (v <= 0 || nPre <= 0 || targetMde <= 0) return null;
  const total = (targetMde / Z_SUM) ** 2 / v;
  const remaining = total - 1 / nPre;
  if (remaining <= 0) return null;
  return Math.ceil(1 / remaining);
}

export function daysNeeded(
  pPooled: number,
  nPre: number,
  targetMde: number,
  denomPerDay: number,
): number | null {
  if (denomPerDay <= 0) return null;
  const n = nPostNeeded(pPooled, nPre, targetMde);
  return n === null ? null : Math.ceil(n / denomPerDay);
}

/** Relative effect as a percentage of the baseline, for reporting alongside the absolute pp. */
export function relative(effect: number, baseline: number): number {
  return baseline === 0 ? 0 : (effect / baseline) * 100;
}
