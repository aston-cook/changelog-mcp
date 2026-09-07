import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';
import type { PostHogClient } from '../posthog.js';
import {
  CATEGORIES,
  decodeChange,
  isMalformed,
  type Category,
  type ChangeRecord,
  type MalformedRecord,
} from '../annotation.js';
import {
  LADDERS,
  applyHint,
  eventsForLadder,
  mixedSource,
  resolveMetric,
  type Metric,
} from '../metrics.js';
import { findOverlaps } from '../overlap.js';
import {
  boundariesFor,
  fetchSeries,
  fetchVolumes,
  splitAt,
  totals,
  type QueryRunner,
} from '../series.js';
import { operatorImpact, type OperatorImpact } from '../operator.js';
import { fitIts, SingularMatrixError, type ItsResult } from '../stats/its.js';
import { relative } from '../stats/mde.js';
import { decide, MIN_POST_DAYS, MIN_PRE_POST_RATIO, type Decision } from '../verdict.js';
import { counters, flush } from '../telemetry.js';

const DAY_MS = 86_400_000;

/**
 * A year of baseline. This must comfortably exceed MAX_POST_DAYS * MIN_PRE_POST_RATIO,
 * or the ratio guard rail would refuse every change older than a few weeks — the tool would
 * be most useless exactly when it had the most data.
 */
const PRE_LOOKBACK_DAYS = 365;
const MAX_POST_DAYS = 90;
const MAX_CHANGES = 25;
const DEFAULT_SINCE_DAYS = 180;

export const checkChangesShape = {
  since: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe(`Only grade changes logged on or after this instant. Defaults to ${DEFAULT_SINCE_DAYS} days ago.`),
  category: z
    .enum(CATEGORIES)
    .optional()
    .describe('Only grade changes in this category.'),
};

export interface CheckChangesArgs {
  since?: string;
  category?: Category;
}

const dayString = (d: Date): string => d.toISOString().slice(0, 10);
const addDays = (iso: string, n: number): Date => new Date(Date.parse(iso) + n * DAY_MS);
const daysBetween = (a: string | Date, b: string | Date): number =>
  Math.round(
    ((typeof b === 'string' ? Date.parse(b) : b.getTime()) -
      (typeof a === 'string' ? Date.parse(a) : a.getTime())) /
      DAY_MS,
  );

interface Graded {
  change: ChangeRecord;
  metric: Metric | null;
  skippedCloser: { metric: Metric; reason: string }[];
  decision: Decision | null;
  preRate: number;
  postRate: number;
  nPre: number;
  nPost: number;
  preDays: number;
  postDays: number;
  its: ItsResult | null;
  truncatedBy: number | null;
  trimmedForRatio: boolean;
  boundedEvents: string[];
  mixed: { from: string; to: string } | null;
  unresolvable: string | null;
}

export async function handleCheckChanges(
  client: Pick<PostHogClient, 'listAnnotations'> & QueryRunner,
  cfg: Config,
  args: CheckChangesArgs,
  now: Date = new Date(),
): Promise<string> {
  const sinceMs = args.since
    ? Date.parse(args.since)
    : now.getTime() - DEFAULT_SINCE_DAYS * DAY_MS;

  // ---- read the log -------------------------------------------------------------------
  const annotations = await fetchAllAnnotations(client);
  const malformed: MalformedRecord[] = [];
  let changes: ChangeRecord[] = [];

  for (const a of annotations) {
    const d = decodeChange(a);
    if (d === null) continue;
    if (isMalformed(d)) {
      malformed.push(d);
      continue;
    }
    if (Date.parse(d.date) < sinceMs) continue;
    if (args.category && d.category !== args.category) continue;
    changes.push(d);
  }

  changes.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const truncatedCount = Math.max(0, changes.length - MAX_CHANGES);
  changes = changes.slice(-MAX_CHANGES); // keep the most recent, still in ascending order

  if (changes.length === 0) {
    return renderEmpty(malformed, args);
  }

  // ---- pass 1: resolve each change to its closest usable metric ------------------------
  const resolved = new Map<number, Metric | null>();
  const skippedByChange = new Map<number, { metric: Metric; reason: string }[]>();
  const volumesByChange = new Map<number, Awaited<ReturnType<typeof fetchVolumes>>>();

  for (const c of changes) {
    const ladder = applyHint(LADDERS[c.category], c.metricHint);
    const preStart = dayString(addDays(c.date, -PRE_LOOKBACK_DAYS));
    const windowEnd = dayString(addDays(dayString(now), 1));

    const volumes = await fetchVolumes(
      client,
      cfg,
      eventsForLadder(ladder),
      c.date,
      preStart,
      windowEnd,
    );
    volumesByChange.set(c.annotationId!, volumes);
    const r = resolveMetric(ladder, volumes);
    resolved.set(c.annotationId!, r.chosen);
    skippedByChange.set(c.annotationId!, r.skipped);
  }

  // ---- overlap: same metric, too close together to separate ---------------------------
  const metricNames = new Map<number, string>();
  for (const [id, m] of resolved) if (m) metricNames.set(id, m.name);
  const overlaps = findOverlaps(
    changes.map((c) => ({ annotationId: c.annotationId!, date: c.date })),
    metricNames,
    MIN_POST_DAYS,
  );

  // ---- pass 2: grade -------------------------------------------------------------------
  const graded: Graded[] = [];

  for (const c of changes) {
    const id = c.annotationId!;
    const metric = resolved.get(id) ?? null;
    const skipped = skippedByChange.get(id) ?? [];

    if (!metric) {
      graded.push(blank(c, skipped, 'no metric on this category\'s ladder has usable volume on both sides of the change'));
      continue;
    }

    // A later change on the same metric truncates this one's post period.
    const laterSameMetric = changes.find(
      (o) =>
        o.annotationId !== id &&
        Date.parse(o.date) > Date.parse(c.date) &&
        metricNames.get(o.annotationId!) === metric.name,
    );
    const naturalEnd = Math.min(now.getTime(), Date.parse(c.date) + MAX_POST_DAYS * DAY_MS);
    const postEndMs = laterSameMetric
      ? Math.min(naturalEnd, Date.parse(laterSameMetric.date))
      : naturalEnd;

    const preStart = dayString(addDays(c.date, -PRE_LOOKBACK_DAYS));
    const postEndDay = dayString(new Date(postEndMs + DAY_MS));

    const fullSeries = await fetchSeries(client, cfg, metric, preStart, postEndDay);
    const split = splitAt(fullSeries, c.date);
    const pre = split.pre;

    // Keep the post window inside what the baseline can support. With a year of history the
    // 90-day cap binds and nothing is lost; on a young project this cap binds instead, so the
    // 3:1 rule is satisfied by trimming rather than by refusing outright.
    const preWithTraffic = pre.filter((p) => p.denominator > 0).length;
    const allowedPostDays = Math.min(
      MAX_POST_DAYS,
      Math.floor(preWithTraffic / MIN_PRE_POST_RATIO),
    );
    const post = split.post.slice(0, Math.max(allowedPostDays, 0));
    const trimmedForRatio = split.post.length > post.length;
    const series = [...pre, ...post];

    const preTotals = totals(pre);
    const postTotals = totals(post);

    const preDays = preWithTraffic;
    const postDays = post.filter((p) => p.denominator > 0).length;
    const preRate = preTotals.denominator ? preTotals.numerator / preTotals.denominator : 0;
    const postRate = postTotals.denominator ? postTotals.numerator / postTotals.denominator : 0;
    const nPre = preTotals.denominator;
    const nPost = postTotals.denominator;
    const pPooled =
      nPre + nPost > 0 ? (preTotals.numerator + postTotals.numerator) / (nPre + nPost) : 0;

    let its: ItsResult | null = null;
    try {
      its = fitIts(series, c.date);
    } catch (err) {
      if (!(err instanceof SingularMatrixError)) throw err;
    }

    const decision = decide({
      preDays,
      postDays,
      nPre,
      nPost,
      pPooled,
      observedEffect: postRate - preRate,
      its,
      overlappingWith: overlaps.get(id) ?? [],
      denomPerDay: preDays > 0 ? nPre / preDays : 0,
    });

    counters.verdict(decision.verdict);

    graded.push({
      change: c,
      metric,
      skippedCloser: skipped,
      decision,
      preRate,
      postRate,
      nPre,
      nPost,
      preDays,
      postDays,
      its,
      truncatedBy: laterSameMetric ? laterSameMetric.annotationId! : null,
      trimmedForRatio,
      boundedEvents: boundariesFor(metric, cfg.eventValidFrom),
      mixed: mixedSource(metric, volumesByChange.get(id) ?? {}),
      unresolvable: null,
    });
  }

  // ---- operator exclusion transparency -------------------------------------------------
  const earliest = changes[0]!;
  const impact = await operatorImpact(
    client,
    cfg,
    dayString(addDays(earliest.date, -PRE_LOOKBACK_DAYS)),
    dayString(addDays(dayString(now), 1)),
  );

  return render(graded, impact, malformed, truncatedCount, cfg);
}

function blank(
  change: ChangeRecord,
  skipped: { metric: Metric; reason: string }[],
  reason: string,
): Graded {
  return {
    change,
    metric: null,
    skippedCloser: skipped,
    decision: null,
    preRate: 0,
    postRate: 0,
    nPre: 0,
    nPost: 0,
    preDays: 0,
    postDays: 0,
    its: null,
    truncatedBy: null,
    trimmedForRatio: false,
    boundedEvents: [],
    mixed: null,
    unresolvable: reason,
  };
}

// ---- rendering -------------------------------------------------------------------------

const ANNOTATION_PAGE = 100;
const ANNOTATION_MAX = 1000;

/** The log outgrows one page quickly; an unpaginated read silently drops the oldest changes. */
async function fetchAllAnnotations(
  client: Pick<PostHogClient, 'listAnnotations'>,
): Promise<Awaited<ReturnType<PostHogClient['listAnnotations']>>> {
  const out: Awaited<ReturnType<PostHogClient['listAnnotations']>> = [];
  for (let offset = 0; offset < ANNOTATION_MAX; offset += ANNOTATION_PAGE) {
    const page = await client.listAnnotations({ limit: ANNOTATION_PAGE, offset });
    out.push(...page);
    if (page.length < ANNOTATION_PAGE) break;
  }
  return out;
}

const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;
const pp = (x: number): string => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}pp`;
const ppRange = (x: number): string => `+/-${(Math.abs(x) * 100).toFixed(2)}pp`;

function renderEmpty(malformed: MalformedRecord[], args: CheckChangesArgs): string {
  const filter = args.category ? ` in category "${args.category}"` : '';
  let out = `No logged changes found${filter}. Use log_change to record a user-visible change first.`;
  if (malformed.length) out += `\n\n${renderMalformed(malformed)}`;
  return out;
}

function renderMalformed(malformed: MalformedRecord[]): string {
  const lines = malformed.map((m) => `  annotation ${m.annotationId}: ${m.reason}`);
  return `Skipped ${malformed.length} unreadable change record(s):\n${lines.join('\n')}`;
}

function render(
  graded: Graded[],
  impact: OperatorImpact,
  malformed: MalformedRecord[],
  truncatedCount: number,
  cfg: Config,
): string {
  const blocks = graded.map((g) => renderOne(g, impact, cfg));

  const tally = graded.reduce<Record<string, number>>((acc, g) => {
    const v = g.decision?.verdict ?? 'cannot tell yet';
    acc[v] = (acc[v] ?? 0) + 1;
    return acc;
  }, {});

  const summary = ['moved', 'did not move', 'cannot tell yet']
    .filter((v) => tally[v])
    .map((v) => `${tally[v]} ${v}`)
    .join(', ');

  let out = `${graded.length} logged change(s): ${summary}\n\n${blocks.join('\n\n')}`;
  if (truncatedCount > 0) {
    out += `\n\n${truncatedCount} older change(s) not graded in this run. Narrow with "since" or "category".`;
  }
  if (malformed.length) out += `\n\n${renderMalformed(malformed)}`;
  return out;
}

function renderOne(g: Graded, impact: OperatorImpact, cfg: Config): string {
  const c = g.change;
  const head = `[${g.decision?.verdict ?? 'cannot tell yet'}] ${c.summary}`;
  const meta = `${c.category} | ${c.surface} | ${c.date.slice(0, 10)} | annotation ${c.annotationId}`;
  const lines = [head, `  ${meta}`];

  if (g.unresolvable) {
    lines.push(`  no metric   ${g.unresolvable}`);
    for (const s of g.skippedCloser) {
      lines.push(`  skipped     ${s.metric.denominator} -> ${s.metric.numerator}: ${s.reason}`);
    }
    return lines.join('\n');
  }

  const m = g.metric!;
  const d = g.decision!;
  const hinted =
    c.metricHint && (m.numerator === c.metricHint || m.denominator === c.metricHint);
  const closer = hinted
    ? ` (from your metric_hint "${c.metricHint}")`
    : g.skippedCloser.length
      ? ' (closest available)'
      : ' (closest to the change)';

  lines.push(`  metric      ${m.denominator} -> ${m.numerator}${closer}`);

  for (const s of g.skippedCloser) {
    lines.push(`  skipped     ${s.metric.denominator} -> ${s.metric.numerator}: ${s.reason}`);
  }

  lines.push(
    `  baseline    ${pct(g.preRate)} over ${g.preDays}d  ->  post ${pct(g.postRate)} over ${g.postDays}d` +
      `  (${pp(g.postRate - g.preRate)}, ${relative(g.postRate - g.preRate, g.preRate).toFixed(0)}% relative)`,
  );
  lines.push(
    `  resolution  can resolve ${ppRange(d.detail.mde)} at n=${g.nPre} pre / ${g.nPost} post`,
  );

  if (g.its) {
    lines.push(
      `  adjusted    ${pp(g.its.step)} after removing trend and day-of-week` +
        `  (95% CI ${pp(g.its.ciLow)} to ${pp(g.its.ciHigh)})`,
    );
    lines.push(`  method      interrupted time series (no control series - forecast only)`);
  } else {
    lines.push(`  method      not fitted - the series does not identify the model`);
  }

  if (g.truncatedBy !== null) {
    lines.push(`  truncated   post period ends at change ${g.truncatedBy} on the same metric`);
  }

  if (g.boundedEvents.length) {
    const parts = g.boundedEvents.map((e) => `${e} from ${cfg.eventValidFrom[e]}`).join(', ');
    lines.push(`  bounded     history clipped to declared data boundaries: ${parts}`);
  }

  if (g.mixed) {
    lines.push(
      `  mixed       legs captured by different SDKs (${g.mixed.from} -> ${g.mixed.to}); ` +
        `the ratio is comparable over time but the absolute rate is not a true rate`,
    );
  }

  if (g.trimmedForRatio) {
    lines.push(
      `  trimmed     post period held to ${g.postDays}d to keep a ${MIN_PRE_POST_RATIO}:1 baseline ratio`,
    );
  }

  lines.push(
    `  excluded    ${impact.people} operator people (${impact.events} events) via $host ` +
      `[${cfg.operatorHostPatterns.join(', ')}] and the explicit flag`,
  );
  lines.push(`  why         ${d.reason}`);

  return lines.join('\n');
}

export function registerCheckChanges(
  server: McpServer,
  client: PostHogClient,
  cfg: Config,
): void {
  server.registerTool(
    'check_changes',
    {
      title: 'Grade logged changes',
      description:
        'Return a verdict for each logged change: moved, did not move, or cannot tell yet. ' +
        "Computes the minimum detectable effect from the project's real baseline before reporting " +
        'anything, excludes operator traffic at the person level, prefers the metric closest to the ' +
        'change over the revenue metric, and refuses to grade changes that overlap in time on the ' +
        'same metric. Returns "cannot tell yet" rather than "did not move" whenever the data could ' +
        'not have detected a meaningful change.',
      inputSchema: checkChangesShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      counters.toolCalled('check_changes');
      const text = await handleCheckChanges(client, cfg, args);
      await flush();
      return { content: [{ type: 'text' as const, text }] };
    },
  );
}
