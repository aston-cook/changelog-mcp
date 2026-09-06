import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleCheckChanges } from '../src/tools/checkChanges.js';
import { encodeChange, type Category } from '../src/annotation.js';
import { reset, snapshot } from '../src/telemetry.js';
import type { Config } from '../src/config.js';
import type { Annotation } from '../src/posthog.js';

const cfg: Config = {
  apiKey: 'phx_TOPSECRET',
  projectId: '1',
  host: 'https://us.posthog.com',
  operatorHostPatterns: ['localhost%', '%.vercel.app'],
};

const NOW = new Date('2026-09-06T00:00:00Z');
const DAY = 86_400_000;

function ann(
  id: number,
  date: string,
  summary: string,
  category: Category,
  metricHint?: string,
): Annotation {
  return {
    id,
    content: encodeChange({ summary, category, surface: '/x', metricHint, date }),
    date_marker: date,
    scope: 'project',
    created_at: date,
  };
}

interface StubOpts {
  annotations: Annotation[];
  volumes: Record<string, [number, number]>;
  /** rate(dayIndex, isPost) -> [numerator, denominator] */
  series?: (dayIso: string, isPost: boolean) => [number, number];
  changeDate?: string;
  impact?: [number, number];
}

function makeClient(o: StubOpts) {
  const seriesFn =
    o.series ?? ((_d: string, isPost: boolean) => [isPost ? 6 : 5, 100] as [number, number]);
  const cut = o.changeDate ?? '2026-06-01';

  const query = vi.fn(async (sql: string) => {
    if (sql.includes('uniq(person_id) AS people')) {
      return { results: [o.impact ?? [9, 312]] };
    }
    if (sql.includes('uniqIf(person_id, timestamp <')) {
      return { results: Object.entries(o.volumes).map(([e, [pre, post]]) => [e, pre, post]) };
    }
    const bounds = [...sql.matchAll(/toDateTime\('(\d{4}-\d{2}-\d{2}) 00:00:00'\)/g)].map(
      (m) => m[1]!,
    );
    const from = Date.parse(bounds[0]! + 'T00:00:00Z');
    const to = Date.parse(bounds[1]! + 'T00:00:00Z');
    const rows: unknown[][] = [];
    for (let t = from; t < to; t += DAY) {
      const iso = new Date(t).toISOString().slice(0, 10);
      const [n, d] = seriesFn(iso, iso >= cut);
      rows.push([iso, n, d]);
    }
    return { results: rows };
  });

  return { listAnnotations: vi.fn().mockResolvedValue(o.annotations), query };
}

const FULL_VOLUMES = {
  $pageview: [11635, 646] as [number, number],
  signup_started: [612, 340] as [number, number],
  signup_completed: [610, 330] as [number, number],
  trial_created: [68, 40] as [number, number],
};

beforeEach(() => reset());

describe('check_changes', () => {
  it('grades a change with plenty of data', async () => {
    const c = makeClient({
      annotations: [ann(1, '2026-06-01T00:00:00Z', 'Rewrote the hero', 'copy')],
      volumes: FULL_VOLUMES,
      series: (_d, isPost) => [isPost ? 12 : 5, 100],
    });
    const out = await handleCheckChanges(c, cfg, {}, NOW);

    expect(out).toContain('[moved]');
    expect(out).toContain('Rewrote the hero');
    expect(out).toContain('interrupted time series (no control series - forecast only)');
  });

  it('says "did not move" only when powered, and shows the adjusted effect', async () => {
    const c = makeClient({
      annotations: [ann(1, '2026-06-01T00:00:00Z', 'Tweaked a button', 'copy')],
      volumes: FULL_VOLUMES,
      series: () => [50, 1000],
    });
    const out = await handleCheckChanges(c, cfg, {}, NOW);

    expect(out).toContain('[did not move]');
    expect(out).toMatch(/adjusted\s+[+-]0\.00pp/);
  });

  it('returns "cannot tell yet" for a change that is only days old', async () => {
    const c = makeClient({
      annotations: [ann(1, '2026-09-01T00:00:00Z', 'Questions before account', 'onboarding')],
      volumes: FULL_VOLUMES,
      changeDate: '2026-09-01',
      series: (_d, isPost) => [isPost ? 7 : 5, 100],
    });
    const out = await handleCheckChanges(c, cfg, {}, NOW);

    expect(out).toContain('[cannot tell yet]');
    expect(out).toMatch(/at least 14/);
  });

  it('skips a metric the change itself created and says why (F5)', async () => {
    const c = makeClient({
      annotations: [
        ann(1, '2026-06-01T00:00:00Z', 'New onboarding', 'onboarding', 'signup_completed'),
      ],
      volumes: { ...FULL_VOLUMES, signup_completed: [0, 330], signup_started: [612, 340] },
      series: (_d, isPost) => [isPost ? 6 : 5, 100],
    });
    const out = await handleCheckChanges(c, cfg, {}, NOW);

    expect(out).toMatch(/skipped\s+signup_started -> signup_completed: no pre-period volume/);
    expect(out).toContain('$pageview -> signup_started');
  });

  it('refuses BOTH changes when two overlap on the same metric', async () => {
    const c = makeClient({
      annotations: [
        ann(1, '2026-06-01T00:00:00Z', 'First copy change', 'copy'),
        ann(2, '2026-06-08T00:00:00Z', 'Second copy change', 'copy'),
      ],
      volumes: FULL_VOLUMES,
      series: (_d, isPost) => [isPost ? 12 : 5, 100],
    });
    const out = await handleCheckChanges(c, cfg, {}, NOW);

    expect(out.match(/\[cannot tell yet\]/g)).toHaveLength(2);
    expect(out).toMatch(/overlaps with change 2/);
    expect(out).toMatch(/overlaps with change 1/);
    expect(out).not.toContain('[moved]');
  });

  it('grades changes on different metrics independently even when close in time', async () => {
    const c = makeClient({
      annotations: [
        ann(1, '2026-06-01T00:00:00Z', 'Copy change', 'copy'),
        ann(2, '2026-06-03T00:00:00Z', 'Packaging change', 'packaging'),
      ],
      volumes: {
        ...FULL_VOLUMES,
        store_checkout_started: [900, 300],
        store_purchase_completed: [400, 140],
      },
      series: (_d, isPost) => [isPost ? 12 : 5, 100],
    });
    const out = await handleCheckChanges(c, cfg, {}, NOW);
    expect(out).not.toMatch(/overlaps with/);
  });

  it('truncates a post period at the next change on the same metric', async () => {
    const c = makeClient({
      annotations: [
        ann(1, '2026-04-01T00:00:00Z', 'First copy change', 'copy'),
        ann(2, '2026-06-01T00:00:00Z', 'Second copy change', 'copy'),
      ],
      volumes: FULL_VOLUMES,
      series: (_d, isPost) => [isPost ? 12 : 5, 100],
    });
    const out = await handleCheckChanges(c, cfg, {}, NOW);
    expect(out).toMatch(/truncated\s+post period ends at change 2/);
  });

  it('reports malformed records instead of crashing', async () => {
    const c = makeClient({
      annotations: [
        ann(1, '2026-06-01T00:00:00Z', 'Good one', 'copy'),
        { id: 99, content: '[chg:1] broken\n{not json', date_marker: '2026-06-01T00:00:00Z', scope: 'project', created_at: '2026-06-01T00:00:00Z' },
      ],
      volumes: FULL_VOLUMES,
    });
    const out = await handleCheckChanges(c, cfg, {}, NOW);
    expect(out).toMatch(/annotation 99: metadata line is not valid JSON/);
    expect(out).toContain('Good one');
  });

  it('ignores annotations that are not ours', async () => {
    const c = makeClient({
      annotations: [
        { id: 5, content: 'deployed v1.2.3', date_marker: '2026-06-01T00:00:00Z', scope: 'project', created_at: '2026-06-01T00:00:00Z' },
      ],
      volumes: FULL_VOLUMES,
    });
    const out = await handleCheckChanges(c, cfg, {}, NOW);
    expect(out).toMatch(/No logged changes found/);
  });

  it('filters by category when asked', async () => {
    const c = makeClient({
      annotations: [
        ann(1, '2026-06-01T00:00:00Z', 'A copy change', 'copy'),
        ann(2, '2026-06-01T00:00:00Z', 'A pricing change', 'pricing'),
      ],
      volumes: FULL_VOLUMES,
    });
    const out = await handleCheckChanges(c, cfg, { category: 'copy' }, NOW);
    expect(out).toContain('A copy change');
    expect(out).not.toContain('A pricing change');
  });

  it('reports how much operator traffic it removed', async () => {
    const c = makeClient({
      annotations: [ann(1, '2026-06-01T00:00:00Z', 'Copy change', 'copy')],
      volumes: FULL_VOLUMES,
      impact: [9, 312],
    });
    const out = await handleCheckChanges(c, cfg, {}, NOW);
    expect(out).toMatch(/excluded\s+9 operator people \(312 events\) via \$host/);
  });

  it('emits exactly one verdict per change, and only the three allowed strings', async () => {
    const c = makeClient({
      annotations: [
        ann(1, '2026-06-01T00:00:00Z', 'Copy change', 'copy'),
        ann(2, '2026-05-01T00:00:00Z', 'Packaging change', 'packaging'),
      ],
      volumes: {
        ...FULL_VOLUMES,
        store_checkout_started: [900, 300],
        store_purchase_completed: [400, 140],
      },
    });
    const out = await handleCheckChanges(c, cfg, {}, NOW);
    const verdicts = out.match(/\[(moved|did not move|cannot tell yet)\]/g) ?? [];
    expect(verdicts).toHaveLength(2);
  });

  it('never leaks the api key, a dashboard link, or a green arrow', async () => {
    const c = makeClient({
      annotations: [ann(1, '2026-06-01T00:00:00Z', 'Copy change', 'copy')],
      volumes: FULL_VOLUMES,
    });
    const out = await handleCheckChanges(c, cfg, {}, NOW);
    expect(out).not.toMatch(/phx_/);
    expect(out).not.toMatch(/https?:\/\//);
    expect(out).not.toMatch(/[▲▼↑↓🟢🔴]/u);
  });

  it('never filters on bot properties in any query it sends', async () => {
    const c = makeClient({
      annotations: [ann(1, '2026-06-01T00:00:00Z', 'Copy change', 'copy')],
      volumes: FULL_VOLUMES,
    });
    await handleCheckChanges(c, cfg, {}, NOW);
    for (const call of c.query.mock.calls) {
      expect(call[0]).not.toContain('$virt_is_bot');
      expect(call[0]).not.toContain('$virt_traffic_type');
      expect(call[0]).not.toContain('$browser_type');
    }
  });

  it('excludes operator persons in every data query', async () => {
    const c = makeClient({
      annotations: [ann(1, '2026-06-01T00:00:00Z', 'Copy change', 'copy')],
      volumes: FULL_VOLUMES,
    });
    await handleCheckChanges(c, cfg, {}, NOW);
    const dataQueries = c.query.mock.calls.filter((call) => !String(call[0]).includes('AS people'));
    expect(dataQueries.length).toBeGreaterThan(0);
    for (const call of dataQueries) expect(call[0]).toContain('person_id NOT IN');
  });

  it('counts verdicts for opt-in telemetry without recording the change content', async () => {
    const c = makeClient({
      annotations: [ann(1, '2026-06-01T00:00:00Z', 'Secret summary', 'copy')],
      volumes: FULL_VOLUMES,
      series: () => [50, 1000],
    });
    await handleCheckChanges(c, cfg, {}, NOW);
    expect(snapshot().verdicts).toEqual({ 'did not move': 1 });
    expect(JSON.stringify(snapshot())).not.toContain('Secret summary');
  });
});
