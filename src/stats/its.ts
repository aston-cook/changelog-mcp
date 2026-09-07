import type { DayPoint } from '../series.js';
import { invert, matVec, SingularMatrixError } from './matrix.js';
import { tQuantile975 } from './normal.js';

export interface ItsResult {
  /** Step change in the rate attributed to the intervention, in proportion units. */
  step: number;
  se: number;
  ciLow: number;
  ciHigh: number;
  df: number;
  /** Fitted daily trend, in proportion units per day, held apart from the step. */
  trendPerDay: number;
}

/** intercept, trend, six day-of-week dummies, step. Sunday is the reference level. */
const P = 9;
const TREND_IX = 1;
const STEP_IX = 8;

export { SingularMatrixError };

/**
 * Interrupted time series, fit by weighted least squares.
 *
 *   rate_t = b0 + b1*t + sum(b_dow * D_t) + b_step * 1[t >= intervention]
 *
 * Weights are each day's denominator, because a binomial rate's variance is inversely
 * proportional to n: a day with four signups should not pull as hard as a day with four
 * hundred.
 *
 * NOT CausalImpact, and deliberately not called that. CausalImpact assumes control series
 * that were themselves unaffected by the intervention; a solo operator changing their only
 * funnel has none, so the method would degenerate to a forecast from the series' own history
 * anyway (spec F6). This model does that explicitly, with assumptions a reader can check:
 * it removes a linear trend and weekly seasonality before attributing anything to the change.
 */
export function fitIts(points: DayPoint[], interventionIso: string): ItsResult {
  const usable = points.filter((p) => p.denominator > 0);
  if (usable.length <= P) {
    throw new SingularMatrixError(
      `need more than ${P} days with traffic to fit the model, got ${usable.length}`,
    );
  }

  const t0 = Date.parse(usable[0]!.day + 'T00:00:00Z');
  const cut = Date.parse(interventionIso.slice(0, 10) + 'T00:00:00Z');

  const rawT = usable.map((p) => (Date.parse(p.day + 'T00:00:00Z') - t0) / 86_400_000);
  const meanT = rawT.reduce((a, b) => a + b, 0) / rawT.length;

  const X: number[][] = [];
  const y: number[] = [];
  const w: number[] = [];

  usable.forEach((p, i) => {
    const ms = Date.parse(p.day + 'T00:00:00Z');
    const dow = new Date(ms).getUTCDay();
    const row = new Array<number>(P).fill(0);
    row[0] = 1;
    row[TREND_IX] = rawT[i]! - meanT;
    if (dow >= 1 && dow <= 6) row[1 + dow] = 1;
    row[STEP_IX] = ms >= cut ? 1 : 0;
    X.push(row);
    y.push(p.numerator / p.denominator);
    w.push(p.denominator);
  });

  const XtWX: number[][] = Array.from({ length: P }, () => new Array<number>(P).fill(0));
  const XtWy = new Array<number>(P).fill(0);

  for (let i = 0; i < X.length; i++) {
    const xi = X[i]!;
    const wi = w[i]!;
    const yi = y[i]!;
    for (let a = 0; a < P; a++) {
      const xa = xi[a]!;
      if (xa === 0) continue;
      XtWy[a]! += wi * xa * yi;
      for (let b = 0; b < P; b++) XtWX[a]![b]! += wi * xa * xi[b]!;
    }
  }

  const inv = invert(XtWX);
  const beta = matVec(inv, XtWy);

  let rss = 0;
  for (let i = 0; i < X.length; i++) {
    const fit = X[i]!.reduce((s, v, k) => s + v * beta[k]!, 0);
    rss += w[i]! * (y[i]! - fit) ** 2;
  }

  const df = X.length - P;
  const s2 = rss / df;
  const varStep = s2 * inv[STEP_IX]![STEP_IX]!;
  const seFit = Math.sqrt(Math.max(varStep, 0));

  // The model must never claim more precision than the raw counts support. A series the
  // model happens to fit perfectly drives the residual variance to zero, which would make
  // any step look infinitely significant. Floor the standard error at the binomial sampling
  // error of a difference in proportions over the same two periods.
  const se = Math.max(seFit, binomialSeFloor(X, y, w));

  const crit = tQuantile975(df);
  const step = beta[STEP_IX]!;

  return {
    step,
    se,
    ciLow: step - crit * se,
    ciHigh: step + crit * se,
    df,
    trendPerDay: beta[TREND_IX]!,
  };
}

/**
 * Standard error of a difference in two proportions, pooled, using the pre and post
 * denominators the design matrix already encodes. This is the tightest interval the raw
 * counts can justify regardless of how well the model happens to fit.
 */
function binomialSeFloor(X: number[][], y: number[], w: number[]): number {
  let nPre = 0;
  let nPost = 0;
  let events = 0;
  let total = 0;

  for (let i = 0; i < X.length; i++) {
    const n = w[i]!;
    if (X[i]![STEP_IX] === 1) nPost += n;
    else nPre += n;
    events += y[i]! * n;
    total += n;
  }

  if (nPre <= 0 || nPost <= 0 || total <= 0) return 0;
  const p = events / total;
  return Math.sqrt(p * (1 - p) * (1 / nPre + 1 / nPost));
}
