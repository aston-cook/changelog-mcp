import { describe, it, expect } from 'vitest';
import { mde, mdeFloor, nPostNeeded, daysNeeded, relative } from '../src/stats/mde.js';
import { tQuantile975, Z_SUM } from '../src/stats/normal.js';

describe('MDE — values verified against the reference project in Phase 0', () => {
  it('signup->trial over 5 post-days is +-15.5pp', () => {
    expect(mde(68 / 610, 610, 34)).toBeCloseTo(0.1554, 3);
  });

  it('visitors->signup_started over 5 post-days is +-2.53pp', () => {
    expect(mde(612 / 11635, 11635, 646)).toBeCloseTo(0.0253, 3);
  });

  it('visitors->signup_started over 30 post-days is +-1.16pp', () => {
    expect(mde(612 / 11635, 11635, 3870)).toBeCloseTo(0.0116, 3);
  });

  it('visitors->signup_started over 60 post-days is +-0.92pp', () => {
    expect(mde(612 / 11635, 11635, 7740)).toBeCloseTo(0.0092, 3);
  });

  it('shows the metric choice is worth about 6x in resolution', () => {
    const revenue = mde(68 / 610, 610, 34);
    const closest = mde(612 / 11635, 11635, 646);
    expect(revenue / closest).toBeGreaterThan(5.5);
  });

  it('reports a floor that an infinite post-period cannot beat', () => {
    expect(mdeFloor(68 / 610, 610)).toBeCloseTo(0.0356, 3);
    expect(mde(68 / 610, 610, 1e12)).toBeCloseTo(mdeFloor(68 / 610, 610), 4);
  });

  it('returns infinity rather than NaN for an empty period', () => {
    expect(mde(0.1, 0, 100)).toBe(Number.POSITIVE_INFINITY);
    expect(mde(0.1, 100, 0)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('what it would take', () => {
  it('returns null when the target MDE is unreachable with the given pre-period', () => {
    expect(nPostNeeded(68 / 610, 610, 0.03)).toBeNull();
  });

  it('needs about 93 days of post-period to resolve a 5pp move on signup->trial', () => {
    expect(daysNeeded(68 / 610, 610, 0.05, 610 / 90)).toBeCloseTo(93, -1);
  });

  it('needs about 30 days to reach 1.16pp on visitors->signup_started', () => {
    expect(daysNeeded(612 / 11635, 11635, 0.0116, 11635 / 90)).toBeCloseTo(30, -1);
  });

  it('returns null rather than dividing by zero when nothing arrives per day', () => {
    expect(daysNeeded(0.1, 100, 0.05, 0)).toBeNull();
  });
});

describe('relative', () => {
  it('expresses an absolute move as a percentage of the baseline', () => {
    expect(relative(0.0253, 0.0526)).toBeCloseTo(48.1, 1);
  });

  it('does not divide by a zero baseline', () => {
    expect(relative(0.01, 0)).toBe(0);
  });
});

describe('quantiles', () => {
  it('uses 2.801585 as the MDE multiplier', () => {
    expect(Z_SUM).toBeCloseTo(2.801585, 6);
  });

  it('matches the t table at df=33', () => {
    expect(tQuantile975(33)).toBeCloseTo(2.0345, 3);
  });

  it('matches the t table at df=10', () => {
    expect(tQuantile975(10)).toBeCloseTo(2.2281, 2);
  });

  it('converges to z for large df', () => {
    expect(tQuantile975(100000)).toBeCloseTo(1.95996, 4);
  });
});
