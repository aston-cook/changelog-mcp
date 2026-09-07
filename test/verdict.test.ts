import { describe, it, expect } from 'vitest';
import { decide, MEANINGFUL_FRACTION, type VerdictInput } from '../src/verdict.js';
import { findOverlaps } from '../src/overlap.js';

const ok: VerdictInput = {
  preDays: 90,
  postDays: 30,
  nPre: 11635,
  nPost: 3870,
  pPooled: 0.0526,
  observedEffect: 0.02,
  its: { step: 0.02, se: 0.004, ciLow: 0.012, ciHigh: 0.028, df: 111, trendPerDay: 0 },
  overlappingWith: [],
  denomPerDay: 129,
};

describe('verdict gating', () => {
  it('returns "moved" only when the effect clears MDE and the CI excludes zero', () => {
    expect(decide(ok).verdict).toBe('moved');
  });

  it('reports direction and relative size for a move', () => {
    expect(decide(ok).reason).toMatch(/up \(38\.0% relative\)/);
    const down = decide({
      ...ok,
      its: { ...ok.its!, step: -0.02, ciLow: -0.028, ciHigh: -0.012 },
    });
    expect(down.verdict).toBe('moved');
    expect(down.reason).toMatch(/down/);
  });

  it('returns "cannot tell yet" for an underpowered null — NEVER "did not move"', () => {
    const r = decide({
      ...ok,
      postDays: 20,
      nPost: 646,
      observedEffect: 0.001,
      its: { step: 0.001, se: 0.02, ciLow: -0.04, ciHigh: 0.042, df: 86, trendPerDay: 0 },
    });
    expect(r.verdict).toBe('cannot tell yet');
    expect(r.reason).toMatch(/would need about \d+ days/i);
  });

  it('returns "did not move" only when powered enough to have seen a real change', () => {
    const r = decide({
      ...ok,
      observedEffect: 0.0005,
      its: { step: 0.0005, se: 0.003, ciLow: -0.0054, ciHigh: 0.0064, df: 111, trendPerDay: 0 },
    });
    expect(r.verdict).toBe('did not move');
    expect(r.reason).toMatch(/could have detected/);
  });

  it('will not say "moved" on a large estimate whose interval still spans zero', () => {
    const r = decide({
      ...ok,
      its: { step: 0.09, se: 0.06, ciLow: -0.03, ciHigh: 0.21, df: 111, trendPerDay: 0 },
    });
    expect(r.verdict).not.toBe('moved');
  });

  it('will not say "moved" on a tight interval below what the volume can resolve', () => {
    const r = decide({
      ...ok,
      nPost: 200,
      its: { step: 0.004, se: 0.001, ciLow: 0.002, ciHigh: 0.006, df: 111, trendPerDay: 0 },
    });
    expect(r.verdict).toBe('cannot tell yet');
  });

  it('refuses to grade when the post-period is too short for the ITS model', () => {
    const r = decide({ ...ok, postDays: 7, nPost: 903 });
    expect(r.verdict).toBe('cannot tell yet');
    expect(r.reason).toMatch(/at least 14/);
  });

  it('refuses to grade when the pre-period is too short to see weekly seasonality', () => {
    const r = decide({ ...ok, preDays: 20, postDays: 15 });
    expect(r.verdict).toBe('cannot tell yet');
    expect(r.reason).toMatch(/at least 28/);
  });

  it('refuses to grade when the pre:post ratio is below 3:1', () => {
    const r = decide({ ...ok, preDays: 40, postDays: 30 });
    expect(r.verdict).toBe('cannot tell yet');
    expect(r.reason).toMatch(/3:1/);
  });

  it('refuses BOTH changes when two overlap on the same metric', () => {
    const r = decide({ ...ok, overlappingWith: [77] });
    expect(r.verdict).toBe('cannot tell yet');
    expect(r.reason).toMatch(/overlaps with change 77/);
  });

  it('checks overlap before anything else, so an overlapping change is never graded', () => {
    const r = decide({ ...ok, overlappingWith: [77], postDays: 3 });
    expect(r.reason).toMatch(/overlaps/);
  });

  it('refuses when the model could not be fit at all', () => {
    const r = decide({ ...ok, its: null });
    expect(r.verdict).toBe('cannot tell yet');
    expect(r.reason).toMatch(/does not identify the model/);
  });

  it('says extending the post-period will not help when the pre-period caps resolution', () => {
    // signup -> trial: 610 pre observations floors the MDE at ~3.6pp, above the 2.8pp bar.
    const r = decide({
      ...ok,
      pPooled: 68 / 610,
      nPre: 610,
      nPost: 200,
      denomPerDay: 6.8,
      observedEffect: 0.01,
      its: { step: 0.01, se: 0.03, ciLow: -0.05, ciHigh: 0.07, df: 111, trendPerDay: 0 },
    });
    expect(r.verdict).toBe('cannot tell yet');
    expect(r.reason).toMatch(/No amount of waiting fixes this/);
    expect(r.detail.daysToMeaningful).toBeNull();
  });

  it('always returns one of exactly three verdict strings', () => {
    const cases: VerdictInput[] = [
      ok,
      { ...ok, overlappingWith: [1] },
      { ...ok, postDays: 2 },
      { ...ok, its: null },
      { ...ok, its: { step: 0, se: 0.003, ciLow: -0.006, ciHigh: 0.006, df: 111, trendPerDay: 0 } },
    ];
    for (const c of cases) {
      expect(['moved', 'did not move', 'cannot tell yet']).toContain(decide(c).verdict);
    }
  });

  it('exposes the numbers behind the verdict for rendering', () => {
    const d = decide(ok).detail;
    expect(d.mde).toBeGreaterThan(0);
    expect(d.adjustedEffect).toBe(0.02);
    expect(d.observedEffect).toBe(0.02);
  });

  it('uses a 25% relative bar for "meaningful"', () => {
    expect(MEANINGFUL_FRACTION).toBe(0.25);
  });
});

describe('overlap detection', () => {
  const changes = [
    { annotationId: 1, date: '2026-09-01T00:00:00Z' },
    { annotationId: 2, date: '2026-09-10T00:00:00Z' },
  ];

  it('flags two changes on the same metric within the window', () => {
    const metrics = new Map([
      [1, 'visitor to signup'],
      [2, 'visitor to signup'],
    ]);
    const out = findOverlaps(changes, metrics, 30);
    expect(out.get(1)).toContain(2);
    expect(out.get(2)).toContain(1);
  });

  it('does not flag two changes on different metrics', () => {
    const metrics = new Map([
      [1, 'visitor to signup'],
      [2, 'checkout to purchase'],
    ]);
    expect(findOverlaps(changes, metrics, 30).get(1)).toHaveLength(0);
  });

  it('does not flag changes further apart than the window', () => {
    const metrics = new Map([
      [1, 'visitor to signup'],
      [2, 'visitor to signup'],
    ]);
    expect(findOverlaps(changes, metrics, 5).get(1)).toHaveLength(0);
  });

  it('does not flag a change whose metric could not be resolved', () => {
    const metrics = new Map([[1, 'visitor to signup']]);
    expect(findOverlaps(changes, metrics, 30).get(1)).toHaveLength(0);
  });

  it('flags every member of a three-way pileup', () => {
    const three = [...changes, { annotationId: 3, date: '2026-09-05T00:00:00Z' }];
    const metrics = new Map([
      [1, 'm'],
      [2, 'm'],
      [3, 'm'],
    ]);
    const out = findOverlaps(three, metrics, 30);
    expect(out.get(3)).toEqual(expect.arrayContaining([1, 2]));
  });
});
