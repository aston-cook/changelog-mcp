import type { Annotation } from './posthog.js';

export const CATEGORIES = [
  'pricing',
  'copy',
  'onboarding',
  'packaging',
  'email',
  'channel',
  'other',
] as const;

export type Category = (typeof CATEGORIES)[number];

export const CHANGE_PREFIX = '[chg:1] ';

/** Verified against the PostHog annotation schema: content is capped at 8192 characters. */
const MAX_CONTENT = 8192;

export interface ChangeRecord {
  summary: string;
  category: Category;
  surface: string;
  metricHint?: string;
  date: string;
  annotationId?: number;
}

export interface MalformedRecord {
  malformed: true;
  annotationId: number;
  reason: string;
}

/**
 * Two lines. Line 1 is human-readable and is what PostHog surfaces on a chart. Line 2 is a
 * machine record. JSON on line 2 rather than a delimiter format so that a surface or summary
 * containing pipes, equals signs or quotes cannot corrupt the record.
 */
export function encodeChange(r: Omit<ChangeRecord, 'annotationId'>): string {
  const meta = {
    v: 1,
    category: r.category,
    surface: r.surface,
    ...(r.metricHint ? { metric_hint: r.metricHint } : {}),
  };
  const summary = r.summary.replace(/\s*\n\s*/g, ' ').trim();
  const content = `${CHANGE_PREFIX}${summary}\n${JSON.stringify(meta)}`;
  if (content.length > MAX_CONTENT) {
    throw new Error(
      `Encoded change is ${content.length} characters; PostHog annotation content is capped at ` +
        `${MAX_CONTENT}. Shorten the summary to one line.`,
    );
  }
  return content;
}

/**
 * Returns null for annotations that are not ours (deployment markers, hand-written notes),
 * a MalformedRecord for ours that we cannot parse, and a ChangeRecord otherwise. A malformed
 * record is surfaced to the user rather than thrown on or silently dropped.
 */
export function decodeChange(a: Annotation): ChangeRecord | MalformedRecord | null {
  const content = a.content ?? '';
  if (!content.startsWith(CHANGE_PREFIX)) return null;

  const nl = content.indexOf('\n');
  if (nl === -1) {
    return { malformed: true, annotationId: a.id, reason: 'missing metadata line' };
  }

  const summary = content.slice(CHANGE_PREFIX.length, nl);
  let meta: unknown;
  try {
    meta = JSON.parse(content.slice(nl + 1));
  } catch {
    return { malformed: true, annotationId: a.id, reason: 'metadata line is not valid JSON' };
  }

  if (typeof meta !== 'object' || meta === null) {
    return { malformed: true, annotationId: a.id, reason: 'metadata line is not an object' };
  }
  const m = meta as Record<string, unknown>;
  if (!CATEGORIES.includes(m.category as Category)) {
    return { malformed: true, annotationId: a.id, reason: `unknown category ${String(m.category)}` };
  }

  return {
    summary,
    category: m.category as Category,
    surface: String(m.surface ?? ''),
    metricHint: typeof m.metric_hint === 'string' ? m.metric_hint : undefined,
    date: a.date_marker ?? a.created_at,
    annotationId: a.id,
  };
}

export function isMalformed(
  r: ChangeRecord | MalformedRecord | null,
): r is MalformedRecord {
  return r !== null && 'malformed' in r;
}
