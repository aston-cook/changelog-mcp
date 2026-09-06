import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleLogChange } from '../src/tools/logChange.js';
import { reset, snapshot } from '../src/telemetry.js';
import type { PostHogClient } from '../src/posthog.js';

type Stub = Pick<PostHogClient, 'createAnnotation' | 'listAnnotations'>;

const client = () =>
  ({
    createAnnotation: vi.fn().mockResolvedValue({ id: 42 }),
    listAnnotations: vi.fn().mockResolvedValue([]),
  }) as unknown as Stub & {
    createAnnotation: ReturnType<typeof vi.fn>;
    listAnnotations: ReturnType<typeof vi.fn>;
  };

beforeEach(() => reset());

describe('log_change', () => {
  it('writes one annotation with the encoded record and returns the id', async () => {
    const c = client();
    const out = await handleLogChange(c, {
      summary: 'Cut Pro to $19',
      category: 'pricing',
      surface: '/pricing',
    });

    expect(c.createAnnotation).toHaveBeenCalledOnce();
    const body = c.createAnnotation.mock.calls[0][0];
    expect(body.content).toContain('[chg:1] Cut Pro to $19');
    expect(body.content).toContain('"category":"pricing"');
    expect(body.scope).toBe('project');
    expect(out).toContain('42');
  });

  it('defaults date to now in ISO-8601 with a Z offset', async () => {
    const c = client();
    await handleLogChange(c, { summary: 'some copy', category: 'copy', surface: '/x' });
    expect(c.createAnnotation.mock.calls[0][0].date_marker).toMatch(
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/,
    );
  });

  it('uses a supplied date for a change that shipped earlier', async () => {
    const c = client();
    await handleLogChange(c, {
      summary: 'shipped last week',
      category: 'copy',
      surface: '/x',
      date: '2026-09-01T00:00:00Z',
    });
    expect(c.createAnnotation.mock.calls[0][0].date_marker).toBe('2026-09-01T00:00:00.000Z');
  });

  it('never echoes the api key', async () => {
    const c = client();
    const out = await handleLogChange(c, { summary: 'some copy', category: 'copy', surface: '/x' });
    expect(out).not.toMatch(/phx_/);
  });

  it('nudges toward metric_hint when it was omitted', async () => {
    const c = client();
    const out = await handleLogChange(c, { summary: 'some copy', category: 'copy', surface: '/x' });
    expect(out).toMatch(/No metric_hint/);
  });

  it('stays quiet about metric_hint when it was supplied', async () => {
    const c = client();
    const out = await handleLogChange(c, {
      summary: 'some copy',
      category: 'copy',
      surface: '/x',
      metric_hint: 'signup_started',
    });
    expect(out).not.toMatch(/No metric_hint/);
  });

  it('refuses a near-duplicate logged within the hour rather than double-logging', async () => {
    const c = client();
    const now = new Date().toISOString();
    c.listAnnotations.mockResolvedValue([
      {
        id: 9,
        content: '[chg:1] Cut Pro to $19\n{"v":1,"category":"pricing","surface":"/pricing"}',
        date_marker: now,
        scope: 'project',
        created_at: now,
      },
    ]);

    const out = await handleLogChange(c, {
      summary: 'Cut Pro to $19',
      category: 'pricing',
      surface: '/pricing',
    });
    expect(c.createAnnotation).not.toHaveBeenCalled();
    expect(out).toMatch(/already logged/i);
  });

  it('does log the same summary again when it is outside the dedupe window', async () => {
    const c = client();
    c.listAnnotations.mockResolvedValue([
      {
        id: 9,
        content: '[chg:1] Cut Pro to $19\n{"v":1,"category":"pricing","surface":"/pricing"}',
        date_marker: '2026-01-01T00:00:00Z',
        scope: 'project',
        created_at: '2026-01-01T00:00:00Z',
      },
    ]);
    await handleLogChange(c, {
      summary: 'Cut Pro to $19',
      category: 'pricing',
      surface: '/pricing',
    });
    expect(c.createAnnotation).toHaveBeenCalledOnce();
  });

  it('is not confused by unrelated annotations in the project', async () => {
    const c = client();
    c.listAnnotations.mockResolvedValue([
      { id: 1, content: 'deployed v1.2.3', date_marker: null, scope: 'project', created_at: new Date().toISOString() },
      { id: 2, content: '[chg:1] broken\n{not json', date_marker: null, scope: 'project', created_at: new Date().toISOString() },
    ]);
    await handleLogChange(c, { summary: 'Cut Pro to $19', category: 'pricing', surface: '/pricing' });
    expect(c.createAnnotation).toHaveBeenCalledOnce();
  });

  it('counts the category for opt-in telemetry, without recording the content', async () => {
    const c = client();
    await handleLogChange(c, { summary: 'Cut Pro to $19', category: 'pricing', surface: '/pricing' });
    expect(snapshot().categories).toEqual({ pricing: 1 });
    expect(JSON.stringify(snapshot())).not.toContain('Cut Pro');
  });
});
