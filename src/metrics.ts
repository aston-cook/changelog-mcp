import type { Category } from './annotation.js';

export interface Metric {
  name: string;
  numerator: string;
  denominator: string;
}

/**
 * Ordered closest-first. The revenue metric is always LAST.
 *
 * Grading a change on the metric nearest to it rather than on revenue is worth roughly 6x in
 * resolution on the reference project (spec F7): +-15.5pp on signup -> trial versus +-2.53pp
 * on visitors -> signup_started over the same five-day window. Reaching straight for trials
 * throws away most of the signal.
 */
export const LADDERS: Record<Category, Metric[]> = {
  onboarding: [
    { name: 'signup completion', numerator: 'signup_completed', denominator: 'signup_started' },
    { name: 'visitor to signup', numerator: 'signup_started', denominator: '$pageview' },
    { name: 'signup to trial', numerator: 'trial_created', denominator: 'signup_completed' },
  ],
  pricing: [
    { name: 'paywall to checkout', numerator: 'checkout_started', denominator: 'paywall_viewed' },
    { name: 'checkout to trial', numerator: 'trial_created', denominator: 'checkout_started' },
    { name: 'signup to trial', numerator: 'trial_created', denominator: 'signup_completed' },
  ],
  packaging: [
    {
      name: 'checkout to purchase',
      numerator: 'store_purchase_completed',
      denominator: 'store_checkout_started',
    },
    { name: 'cart to checkout', numerator: 'store_checkout_started', denominator: 'store_add_to_cart' },
    { name: 'paywall to checkout', numerator: 'checkout_started', denominator: 'paywall_viewed' },
  ],
  copy: [
    { name: 'visitor to signup', numerator: 'signup_started', denominator: '$pageview' },
    { name: 'signup completion', numerator: 'signup_completed', denominator: 'signup_started' },
    { name: 'signup to trial', numerator: 'trial_created', denominator: 'signup_completed' },
  ],
  email: [
    { name: 'visitor to signup', numerator: 'signup_started', denominator: '$pageview' },
    { name: 'signup to trial', numerator: 'trial_created', denominator: 'signup_completed' },
  ],
  channel: [
    { name: 'visitor to signup', numerator: 'signup_started', denominator: '$pageview' },
    { name: 'signup completion', numerator: 'signup_completed', denominator: 'signup_started' },
  ],
  other: [
    { name: 'visitor to signup', numerator: 'signup_started', denominator: '$pageview' },
    { name: 'signup to trial', numerator: 'trial_created', denominator: 'signup_completed' },
  ],
};

export type Volumes = Record<string, { pre: number; post: number }>;

export interface SkippedMetric {
  metric: Metric;
  reason: string;
}

export interface Resolution {
  chosen: Metric | null;
  skipped: SkippedMetric[];
}

/**
 * Promote any ladder entry that touches the hinted event to the front, preserving relative
 * order. metric_hint names a single funnel step, so it selects among the ladder rather than
 * defining a metric of its own.
 */
export function applyHint(ladder: Metric[], hint?: string): Metric[] {
  if (!hint) return ladder;
  const touches = (m: Metric) => m.numerator === hint || m.denominator === hint;
  return [...ladder.filter(touches), ...ladder.filter((m) => !touches(m))];
}

/**
 * Walk the ladder closest-first and take the first metric with real volume on both legs in
 * both periods. A metric whose events did not exist before the change is unusable: the change
 * created them, so there is nothing to compare against (spec F5, the Sept 1 onboarding case).
 */
export function resolveMetric(candidates: Metric[], volumes: Volumes): Resolution {
  const skipped: SkippedMetric[] = [];

  for (const m of candidates) {
    const n = volumes[m.numerator];
    const d = volumes[m.denominator];

    if (!n || !d) {
      const missing = !n ? m.numerator : m.denominator;
      skipped.push({ metric: m, reason: `${missing} is not present in this project` });
      continue;
    }
    if (d.pre === 0 || n.pre === 0) {
      skipped.push({
        metric: m,
        reason:
          'no pre-period volume — the change appears to have created these events, ' +
          'so there is nothing to compare against',
      });
      continue;
    }
    if (d.post === 0) {
      skipped.push({ metric: m, reason: `${m.denominator} has no post-period volume` });
      continue;
    }
    return { chosen: m, skipped };
  }

  return { chosen: null, skipped };
}

/** Every event named anywhere on a ladder, for a single volumes lookup. */
export function eventsForLadder(ladder: Metric[]): string[] {
  return [...new Set(ladder.flatMap((m) => [m.numerator, m.denominator]))];
}
