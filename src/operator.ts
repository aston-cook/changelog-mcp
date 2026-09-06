import type { Config } from './config.js';

/** Escape a value for interpolation into a HogQL single-quoted string literal. */
export function sqlString(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * A HogQL subquery yielding every person_id that has ever emitted an operator signal.
 *
 * PERSON-LEVEL BY DESIGN (spec F2). trial_created, trial_converted, payment_failed,
 * subscription_renewed and store_purchase_completed are sent from posthog-node with no user
 * agent, and PostHog classifies no-user-agent traffic as $virt_is_bot = true. Filtering
 * events on bot properties would return zero trials and zero revenue events forever. We
 * exclude the *person*, then apply that exclusion to all of their events including the
 * server-side ones that carry no host and no user agent of their own.
 *
 * $host is the signal that actually works (spec F4). In the reference project it isolated
 * 47 store checkouts with zero purchases from 9 people, while PostHog's own bot detection
 * flagged none of them — they are real headed browsers on localhost and preview hosts.
 */
export function buildOperatorPersonFilter(cfg: Config): string {
  const hostClauses = cfg.operatorHostPatterns
    .map((p) => `properties.$host LIKE ${sqlString(p)}`)
    .join('\n             OR ');

  const clauses = hostClauses ? `${hostClauses}\n             OR ` : '';

  return `
        SELECT DISTINCT person_id
        FROM events
        WHERE timestamp >= now() - INTERVAL 365 DAY
          AND (
             ${clauses}properties.$operator = true
             OR person.properties.is_operator = true
          )`.trim();
}

export interface OperatorImpact {
  people: number;
  events: number;
}

export function buildOperatorImpactQuery(cfg: Config, fromDate: string, toDate: string): string {
  return `
SELECT
    uniq(person_id) AS people,
    count()         AS events
FROM events
WHERE timestamp >= toDateTime(${sqlString(fromDate + ' 00:00:00')})
  AND timestamp <  toDateTime(${sqlString(toDate + ' 00:00:00')})
  AND person_id IN (${buildOperatorPersonFilter(cfg)})`.trim();
}

export async function operatorImpact(
  client: { query(q: string): Promise<{ results: unknown[][] }> },
  cfg: Config,
  fromDate: string,
  toDate: string,
): Promise<OperatorImpact> {
  const r = await client.query(buildOperatorImpactQuery(cfg, fromDate, toDate));
  const row = r.results[0] ?? [0, 0];
  return { people: Number(row[0] ?? 0), events: Number(row[1] ?? 0) };
}
