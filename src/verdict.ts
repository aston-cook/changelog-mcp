import type { ItsResult } from './stats/its.js';
import { mde, mdeFloor, daysNeeded, relative } from './stats/mde.js';

export type Verdict = 'moved' | 'did not move' | 'cannot tell yet';

/**
 * Guard rails on the ITS fit. These are engineering judgment, NOT CausalImpact doctrine —
 * the widely quoted "3:1 ratio, 30-50 pre-period observations" figures do not appear in
 * Google's CausalImpact documentation or in tfcausalimpact; they trace to third-party
 * marketing content (spec F6). They are kept because they are sensible for this model:
 * day-of-week seasonality costs six parameters and cannot be identified from less than four
 * full weeks.
 */
export const MIN_PRE_DAYS = 28;
export const MIN_POST_DAYS = 14;
export const MIN_PRE_POST_RATIO = 3;

/**
 * "Did not move" is only honest when the study could have seen a change worth acting on.
 * A relative move of this size against the baseline is the bar.
 */
export const MEANINGFUL_FRACTION = 0.25;

export interface VerdictInput {
  preDays: number;
  postDays: number;
  nPre: number;
  nPost: number;
  pPooled: number;
  /** Naive post-rate minus pre-rate, kept for reporting alongside the adjusted estimate. */
  observedEffect: number;
  /** null when the model could not be fit at all. */
  its: ItsResult | null;
  overlappingWith: number[];
  denomPerDay: number;
}

export interface Decision {
  verdict: Verdict;
  reason: string;
  detail: {
    mde: number;
    mdeFloor: number;
    adjustedEffect: number | null;
    observedEffect: number;
    daysToMeaningful: number | null;
  };
}

export function decide(input: VerdictInput): Decision {
  const {
    preDays,
    postDays,
    nPre,
    nPost,
    pPooled,
    observedEffect,
    its,
    overlappingWith,
    denomPerDay,
  } = input;

  const m = mde(pPooled, nPre, nPost);
  const floor = mdeFloor(pPooled, nPre);
  const meaningful = MEANINGFUL_FRACTION * pPooled;
  const daysToMeaningful = daysNeeded(pPooled, nPre, meaningful, denomPerDay);

  const detail = {
    mde: m,
    mdeFloor: floor,
    adjustedEffect: its ? its.step : null,
    observedEffect,
    daysToMeaningful,
  };

  const cannot = (reason: string): Decision => ({ verdict: 'cannot tell yet', reason, detail });

  if (overlappingWith.length > 0) {
    const list = overlappingWith.map((id) => `change ${id}`).join(' and ');
    return cannot(
      `overlaps with ${list} on the same metric — whatever the metric did, there is no way to ` +
        `attribute it to one change rather than the other. Neither can be graded.`,
    );
  }

  if (postDays < MIN_POST_DAYS) {
    return cannot(
      `only ${postDays} days since the change; the model needs at least ${MIN_POST_DAYS} ` +
        `post-period days before a verdict means anything.`,
    );
  }

  if (preDays < MIN_PRE_DAYS) {
    return cannot(
      `only ${preDays} days of history before the change; at least ${MIN_PRE_DAYS} are needed ` +
        `to separate weekly seasonality from the change itself.`,
    );
  }

  if (preDays / postDays < MIN_PRE_POST_RATIO) {
    return cannot(
      `the pre-period (${preDays}d) is less than ${MIN_PRE_POST_RATIO}:1 against the post-period ` +
        `(${postDays}d), so the baseline is not established well enough to forecast against.`,
    );
  }

  if (!its) {
    return cannot(
      `the series does not identify the model — too many days without traffic to separate ` +
        `trend and weekly seasonality from the change.`,
    );
  }

  const effect = its.step;
  const ciExcludesZero = its.ciLow > 0 || its.ciHigh < 0;

  if (Math.abs(effect) >= m && ciExcludesZero) {
    const dir = effect > 0 ? 'up' : 'down';
    return {
      verdict: 'moved',
      reason:
        `${fmtPp(Math.abs(effect))} ${dir} (${fmtPct(relative(effect, pPooled))} relative) after ` +
        `removing trend and day-of-week, which clears the ${fmtPp(m)} this volume can resolve.`,
      detail,
    };
  }

  if (m <= meaningful && !ciExcludesZero) {
    return {
      verdict: 'did not move',
      reason:
        `this window could have detected a ${fmtPp(meaningful)} change ` +
        `(${MEANINGFUL_FRACTION * 100}% of the ${fmtPct(pPooled * 100)} baseline) and did not. ` +
        `Adjusted effect ${fmtPp(effect)}, interval ${fmtPp(its.ciLow)} to ${fmtPp(its.ciHigh)}.`,
      detail,
    };
  }

  const need =
    daysToMeaningful === null
      ? `No amount of waiting fixes this: even an unlimited post-period bottoms out at ` +
        `${fmtPp(floor)} with only ${nPre} pre-period observations. Grade this on a metric ` +
        `closer to the change, or extend the pre-period.`
      : `You would need about ${daysToMeaningful} days of post-period data to resolve a ` +
        `${fmtPp(meaningful)} change.`;

  return cannot(
    `this volume can only resolve a ${fmtPp(m)} change against a ` +
      `${fmtPct(pPooled * 100)} baseline, and the observed move is ${fmtPp(effect)}. ${need}`,
  );
}

function fmtPp(x: number): string {
  return `${(x * 100).toFixed(2)}pp`;
}

function fmtPct(x: number): string {
  return `${x.toFixed(1)}%`;
}
