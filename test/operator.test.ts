import { describe, it, expect, vi } from 'vitest';
import {
  buildOperatorPersonFilter,
  buildOperatorImpactQuery,
  operatorImpact,
  sqlString,
} from '../src/operator.js';
import type { Config } from '../src/config.js';

const cfg: Config = {
  apiKey: 'phx_x',
  projectId: '1',
  host: 'h',
  operatorHostPatterns: ['localhost%', '%.vercel.app'],
};

describe('operator exclusion', () => {
  it('NEVER filters on PostHog bot properties (F2: they would delete every server-side event)', () => {
    const sql = buildOperatorPersonFilter(cfg);
    expect(sql).not.toContain('$virt_is_bot');
    expect(sql).not.toContain('$virt_traffic_type');
    expect(sql).not.toContain('$virt_traffic_category');
    expect(sql).not.toContain('$browser_type');
  });

  it('excludes by person, not by event, so server-side events from an operator are caught too', () => {
    expect(buildOperatorPersonFilter(cfg)).toMatch(/SELECT\s+DISTINCT\s+person_id/i);
  });

  it('matches each configured host pattern', () => {
    const sql = buildOperatorPersonFilter(cfg);
    expect(sql).toContain("properties.$host LIKE 'localhost%'");
    expect(sql).toContain("properties.$host LIKE '%.vercel.app'");
  });

  it('honours the explicit opt-in flag on both event and person', () => {
    const sql = buildOperatorPersonFilter(cfg);
    expect(sql).toContain('properties.$operator = true');
    expect(sql).toContain('person.properties.is_operator = true');
  });

  it('still produces valid SQL when no host patterns are configured', () => {
    const sql = buildOperatorPersonFilter({ ...cfg, operatorHostPatterns: [] });
    expect(sql).toContain('properties.$operator = true');
    expect(sql).not.toContain('OR \n');
    expect(sql).not.toMatch(/\(\s*OR/);
  });

  it('escapes single quotes so a host pattern cannot break out of the literal', () => {
    const sql = buildOperatorPersonFilter({ ...cfg, operatorHostPatterns: ["ev'il%"] });
    expect(sql).toContain("'ev\\'il%'");
  });

  it('bounds the person scan on timestamp', () => {
    expect(buildOperatorPersonFilter(cfg)).toMatch(/timestamp >= now\(\) - INTERVAL 365 DAY/);
  });
});

describe('sqlString', () => {
  it('escapes backslashes before quotes', () => {
    expect(sqlString('a\\b')).toBe("'a\\\\b'");
  });
});

describe('operatorImpact', () => {
  it('reports how many people and events were excluded', async () => {
    const query = vi.fn().mockResolvedValue({ results: [[9, 312]] });
    const out = await operatorImpact({ query }, cfg, '2026-06-01', '2026-09-06');
    expect(out).toEqual({ people: 9, events: 312 });
    expect(query.mock.calls[0][0]).toContain('person_id IN (');
  });

  it('reports zero rather than NaN when nothing matched', async () => {
    const query = vi.fn().mockResolvedValue({ results: [] });
    expect(await operatorImpact({ query }, cfg, '2026-06-01', '2026-09-06')).toEqual({
      people: 0,
      events: 0,
    });
  });

  it('bounds the impact query on timestamp in the WHERE clause', () => {
    const sql = buildOperatorImpactQuery(cfg, '2026-06-01', '2026-09-06');
    expect(sql).toMatch(/WHERE[\s\S]*timestamp >= toDateTime/);
  });
});
