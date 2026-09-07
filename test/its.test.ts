import { describe, it, expect } from 'vitest';
import { fitIts, SingularMatrixError } from '../src/stats/its.js';
import { invert, SingularMatrixError as MatErr } from '../src/stats/matrix.js';
import type { DayPoint } from '../src/series.js';

/** Deterministic synthetic series: base rate + linear trend + weekend dip + a step. */
function synth(
  days: number,
  base: number,
  trendPerDay: number,
  step: number,
  stepAt: number,
  n = 400,
): DayPoint[] {
  const pts: DayPoint[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.UTC(2026, 0, 1 + i));
    const dow = d.getUTCDay();
    const weekend = dow === 0 || dow === 6 ? -0.01 : 0;
    const rate = base + trendPerDay * i + weekend + (i >= stepAt ? step : 0);
    pts.push({
      day: d.toISOString().slice(0, 10),
      numerator: Math.round(rate * n),
      denominator: n,
    });
  }
  return pts;
}

const dayAt = (pts: DayPoint[], i: number) => pts[i]!.day;

describe('interrupted time series', () => {
  it('recovers a known +3pp step', () => {
    const pts = synth(120, 0.05, 0, 0.03, 90);
    const r = fitIts(pts, dayAt(pts, 90));
    expect(r.step).toBeCloseTo(0.03, 2);
    expect(r.ciLow).toBeGreaterThan(0);
  });

  it('recovers a known -2pp step', () => {
    const pts = synth(120, 0.08, 0, -0.02, 90);
    const r = fitIts(pts, dayAt(pts, 90));
    expect(r.step).toBeCloseTo(-0.02, 2);
    expect(r.ciHigh).toBeLessThan(0);
  });

  it('does not credit a pre-existing upward trend to the change', () => {
    const pts = synth(120, 0.05, 0.0004, 0, 90);
    const r = fitIts(pts, dayAt(pts, 90));
    expect(Math.abs(r.step)).toBeLessThan(0.01);
    expect(r.ciLow).toBeLessThan(0);
    expect(r.ciHigh).toBeGreaterThan(0);
  });

  it('is the whole point: naive before/after WOULD credit that trend to the change', () => {
    const pts = synth(120, 0.05, 0.0004, 0, 90);
    const mean = (xs: DayPoint[]) =>
      xs.reduce((s, p) => s + p.numerator / p.denominator, 0) / xs.length;
    const naive = mean(pts.slice(90)) - mean(pts.slice(0, 90));
    expect(naive).toBeGreaterThan(0.015); // naive sees a phantom +1.5pp or more
    expect(Math.abs(fitIts(pts, dayAt(pts, 90)).step)).toBeLessThan(0.01);
  });

  it('recovers the trend separately from the step', () => {
    const r = fitIts(synth(120, 0.05, 0.0004, 0.02, 90), dayAt(synth(120, 0.05, 0.0004, 0.02, 90), 90));
    expect(r.trendPerDay).toBeCloseTo(0.0004, 3);
    expect(r.step).toBeCloseTo(0.02, 2);
  });

  it('does not credit weekly seasonality to the change', () => {
    const pts = synth(120, 0.05, 0, 0, 90);
    expect(Math.abs(fitIts(pts, dayAt(pts, 90)).step)).toBeLessThan(0.005);
  });

  it('returns a CI containing zero for a flat series', () => {
    const pts = synth(120, 0.05, 0, 0, 90);
    const r = fitIts(pts, dayAt(pts, 90));
    expect(r.ciLow).toBeLessThan(0);
    expect(r.ciHigh).toBeGreaterThan(0);
  });

  it('gives a wider interval when daily volume is small', () => {
    const big = fitIts(synth(120, 0.05, 0, 0.03, 90, 4000), dayAt(synth(120, 0.05, 0, 0.03, 90, 4000), 90));
    const small = fitIts(synth(120, 0.05, 0, 0.03, 90, 40), dayAt(synth(120, 0.05, 0, 0.03, 90, 40), 90));
    expect(small.se).toBeGreaterThan(big.se);
  });

  it('ignores days with no traffic rather than treating them as a zero rate', () => {
    const pts = synth(120, 0.05, 0, 0.03, 90);
    pts[10] = { day: pts[10]!.day, numerator: 0, denominator: 0 };
    expect(fitIts(pts, dayAt(pts, 90)).df).toBe(120 - 1 - 9);
  });

  it('refuses rather than returning NaN when the window is too short to identify the model', () => {
    expect(() => fitIts(synth(6, 0.05, 0, 0.03, 3), '2026-01-04')).toThrow(SingularMatrixError);
  });

  it('never claims more precision than the raw counts support', () => {
    // This series is fit perfectly, driving residual variance to zero. Without the binomial
    // floor the interval would collapse to a point and any step would look certain.
    const pts = synth(120, 0.05, 0, 0, 90);
    const r = fitIts(pts, dayAt(pts, 90));
    expect(r.se).toBeGreaterThan(0);
    expect(r.ciHigh - r.ciLow).toBeGreaterThan(0.001);
  });

  it('floors the interval at the binomial standard error of the two periods', () => {
    const pts = synth(120, 0.05, 0, 0, 90, 400);
    const nPre = 90 * 400;
    const nPost = 30 * 400;
    const p = pts.reduce((s, x) => s + x.numerator, 0) / (120 * 400);
    const floor = Math.sqrt(p * (1 - p) * (1 / nPre + 1 / nPost));
    expect(fitIts(pts, dayAt(pts, 90)).se).toBeCloseTo(floor, 5);
  });
});

describe('matrix inversion', () => {
  it('inverts a small symmetric matrix', () => {
    const inv = invert([
      [4, 1],
      [1, 3],
    ]);
    expect(inv[0]![0]).toBeCloseTo(3 / 11, 9);
    expect(inv[1]![1]).toBeCloseTo(4 / 11, 9);
  });

  it('round-trips to the identity', () => {
    const A = [
      [2, 1, 0],
      [1, 3, 1],
      [0, 1, 4],
    ];
    const inv = invert(A);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const v = A[i]!.reduce((s, x, k) => s + x * inv[k]![j]!, 0);
        expect(v).toBeCloseTo(i === j ? 1 : 0, 9);
      }
    }
  });

  it('throws on a singular matrix instead of producing NaN', () => {
    expect(() =>
      invert([
        [1, 2],
        [2, 4],
      ]),
    ).toThrow(MatErr);
  });
});
