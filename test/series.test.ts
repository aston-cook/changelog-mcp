import { describe, it, expect, vi } from 'vitest';
import {
  buildSeriesQuery,
  buildVolumesQuery,
  fetchSeries,
  fetchVolumes,
  splitAt,
  totals,
  toHogDateTime,
} from '../src/series.js';
import type { Config } from '../src/config.js';

const cfg: Config = {
  apiKey: 'phx_x',
  projectId: '1',
  host: 'h',
  operatorHostPatterns: ['localhost%'],
};
const metric = { name: 'm', numerator: 'signup_completed', denominator: 'signup_started' };

describe('series query', () => {
  const sql = buildSeriesQuery(cfg, metric, '2026-06-01', '2026-09-06');

  it('counts people, not events, so one person cannot inflate a rate', () => {
    expect(sql).toMatch(/uniqIf\(person_id/);
    expect(sql).not.toMatch(/countIf\(event\s*=\s*'signup_completed'\)/);
  });

  it('excludes operator persons from BOTH numerator and denominator', () => {
    expect(sql).toContain('person_id NOT IN');
    expect(sql.match(/person_id NOT IN/g)).toHaveLength(1);
  });

  it('bounds the scan on timestamp in the WHERE clause', () => {
    expect(sql).toMatch(/WHERE[\s\S]*timestamp >= toDateTime/);
  });

  it('never touches bot properties', () => {
    expect(sql).not.toContain('$virt_is_bot');
    expect(sql).not.toContain('$virt_traffic_type');
  });

  it('filters to just the two events it needs', () => {
    expect(sql).toContain("event IN ('signup_completed', 'signup_started')");
  });
});

describe('volumes query', () => {
  const sql = buildVolumesQuery(
    cfg,
    ['$pageview', 'signup_started'],
    '2026-09-01T00:00:00.000Z',
    '2026-06-01',
    '2026-09-06',
  );

  it('splits pre and post at the change instant', () => {
    expect(sql).toContain("uniqIf(person_id, timestamp <  toDateTime('2026-09-01 00:00:00'))");
    expect(sql).toContain("uniqIf(person_id, timestamp >= toDateTime('2026-09-01 00:00:00'))");
  });

  it('applies the same operator exclusion as the series query', () => {
    expect(sql).toContain('person_id NOT IN');
  });
});

describe('toHogDateTime', () => {
  it('converts an ISO instant to the form toDateTime accepts', () => {
    expect(toHogDateTime('2026-09-01T00:00:00.000Z')).toBe('2026-09-01 00:00:00');
  });
});

describe('fetchSeries', () => {
  it('maps rows to day points and normalises the day to a date', async () => {
    const query = vi.fn().mockResolvedValue({
      results: [
        ['2026-09-01T00:00:00', 12, 100],
        ['2026-09-02', 15, 110],
      ],
    });
    const out = await fetchSeries({ query }, cfg, metric, '2026-06-01', '2026-09-06');
    expect(out).toEqual([
      { day: '2026-09-01', numerator: 12, denominator: 100 },
      { day: '2026-09-02', numerator: 15, denominator: 110 },
    ]);
  });
});

describe('fetchVolumes', () => {
  it('keys volumes by event name', async () => {
    const query = vi.fn().mockResolvedValue({
      results: [
        ['$pageview', 11635, 646],
        ['signup_started', 612, 34],
      ],
    });
    const out = await fetchVolumes(
      { query },
      cfg,
      ['$pageview', 'signup_started'],
      '2026-09-01T00:00:00Z',
      '2026-06-01',
      '2026-09-06',
    );
    expect(out).toEqual({
      $pageview: { pre: 11635, post: 646 },
      signup_started: { pre: 612, post: 34 },
    });
  });
});

describe('splitAt and totals', () => {
  const points = [
    { day: '2026-08-30', numerator: 1, denominator: 10 },
    { day: '2026-08-31', numerator: 2, denominator: 20 },
    { day: '2026-09-01', numerator: 3, denominator: 30 },
    { day: '2026-09-02', numerator: 4, denominator: 40 },
  ];

  it('puts the intervention day itself in the post period', () => {
    const { pre, post } = splitAt(points, '2026-09-01T00:00:00Z');
    expect(pre.map((p) => p.day)).toEqual(['2026-08-30', '2026-08-31']);
    expect(post.map((p) => p.day)).toEqual(['2026-09-01', '2026-09-02']);
  });

  it('sums both legs', () => {
    expect(totals(points)).toEqual({ numerator: 10, denominator: 100 });
  });
});
