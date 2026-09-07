import type { Config } from './config.js';
import type { Metric, Volumes } from './metrics.js';
import { buildOperatorPersonFilter, sqlString } from './operator.js';

export interface DayPoint {
  day: string;
  numerator: number;
  denominator: number;
}

export interface QueryRunner {
  query(hogql: string): Promise<{ results: unknown[][] }>;
}

/** '2026-09-01T00:00:00.000Z' -> '2026-09-01 00:00:00', which is what toDateTime() wants. */
export function toHogDateTime(iso: string): string {
  return iso.slice(0, 19).replace('T', ' ');
}

/**
 * Daily numerator and denominator for one metric, with operator persons removed from BOTH
 * legs. Counts distinct persons rather than events: one operator refreshing a checkout page
 * forty times must not move a rate.
 */
export function buildSeriesQuery(cfg: Config, m: Metric, fromDate: string, toDate: string): string {
  const events = [...new Set([m.numerator, m.denominator])].map(sqlString).join(', ');
  return `
SELECT
    toDate(timestamp)                                      AS day,
    uniqIf(person_id, event = ${sqlString(m.numerator)})   AS numerator,
    uniqIf(person_id, event = ${sqlString(m.denominator)}) AS denominator
FROM events
WHERE timestamp >= toDateTime(${sqlString(fromDate + ' 00:00:00')})
  AND timestamp <  toDateTime(${sqlString(toDate + ' 00:00:00')})
  AND event IN (${events})
  AND person_id NOT IN (${buildOperatorPersonFilter(cfg)})
GROUP BY day
ORDER BY day
LIMIT 500`.trim();
}

export async function fetchSeries(
  client: QueryRunner,
  cfg: Config,
  m: Metric,
  fromDate: string,
  toDate: string,
): Promise<DayPoint[]> {
  const r = await client.query(buildSeriesQuery(cfg, m, fromDate, toDate));
  return r.results.map((row) => ({
    day: String(row[0]).slice(0, 10),
    numerator: Number(row[1] ?? 0),
    denominator: Number(row[2] ?? 0),
  }));
}

/**
 * Distinct persons per event, split pre/post at the change instant, operator-excluded.
 * One query answers "does this metric have volume on both sides of the change" for the whole
 * ladder at once.
 */
export function buildVolumesQuery(
  cfg: Config,
  events: string[],
  changeIso: string,
  fromDate: string,
  toDate: string,
): string {
  const cut = sqlString(toHogDateTime(changeIso));
  return `
SELECT
    event,
    uniqIf(person_id, timestamp <  toDateTime(${cut})) AS pre,
    uniqIf(person_id, timestamp >= toDateTime(${cut})) AS post
FROM events
WHERE timestamp >= toDateTime(${sqlString(fromDate + ' 00:00:00')})
  AND timestamp <  toDateTime(${sqlString(toDate + ' 00:00:00')})
  AND event IN (${events.map(sqlString).join(', ')})
  AND person_id NOT IN (${buildOperatorPersonFilter(cfg)})
GROUP BY event
LIMIT 500`.trim();
}

export async function fetchVolumes(
  client: QueryRunner,
  cfg: Config,
  events: string[],
  changeIso: string,
  fromDate: string,
  toDate: string,
): Promise<Volumes> {
  const r = await client.query(buildVolumesQuery(cfg, events, changeIso, fromDate, toDate));
  const out: Volumes = {};
  for (const row of r.results) {
    out[String(row[0])] = { pre: Number(row[1] ?? 0), post: Number(row[2] ?? 0) };
  }
  return out;
}

export interface SplitSeries {
  pre: DayPoint[];
  post: DayPoint[];
}

export function splitAt(points: DayPoint[], changeIso: string): SplitSeries {
  const cut = changeIso.slice(0, 10);
  return {
    pre: points.filter((p) => p.day < cut),
    post: points.filter((p) => p.day >= cut),
  };
}

export function totals(points: DayPoint[]): { numerator: number; denominator: number } {
  return points.reduce(
    (acc, p) => ({
      numerator: acc.numerator + p.numerator,
      denominator: acc.denominator + p.denominator,
    }),
    { numerator: 0, denominator: 0 },
  );
}
