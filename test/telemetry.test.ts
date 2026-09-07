import { describe, it, expect, vi, beforeEach } from 'vitest';
import { counters, flush, isEnabled, reset, snapshot } from '../src/telemetry.js';

beforeEach(() => reset());

describe('telemetry', () => {
  it('is off by default', () => {
    expect(isEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('is off for any value other than an explicit 1', () => {
    expect(isEnabled({ CHANGELOG_TELEMETRY: 'true' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isEnabled({ CHANGELOG_TELEMETRY: '0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isEnabled({ CHANGELOG_TELEMETRY: '' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('is on only with an explicit opt-in', () => {
    expect(isEnabled({ CHANGELOG_TELEMETRY: '1' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('sends nothing when disabled, even with counts recorded', async () => {
    counters.logged('pricing');
    const fetchMock = vi.fn();
    expect(await flush({} as NodeJS.ProcessEnv, fetchMock as unknown as typeof fetch)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is a documented no-op when enabled with no destination configured', async () => {
    counters.logged('pricing');
    const fetchMock = vi.fn();
    const out = await flush(
      { CHANGELOG_TELEMETRY: '1' } as NodeJS.ProcessEnv,
      fetchMock as unknown as typeof fetch,
    );
    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends counts only, never content', async () => {
    counters.toolCalled('check_changes');
    counters.logged('pricing');
    counters.logged('onboarding');
    counters.verdict('cannot tell yet');

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    const payload = await flush(
      { CHANGELOG_TELEMETRY: '1', CHANGELOG_TELEMETRY_URL: 'https://example.com/c' } as NodeJS.ProcessEnv,
      fetchMock as unknown as typeof fetch,
    );

    expect(payload).toEqual({
      tools: { check_changes: 1 },
      categories: { pricing: 1, onboarding: 1 },
      verdicts: { 'cannot tell yet': 1 },
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(Object.keys(body).sort()).toEqual(['categories', 'tools', 'verdicts']);
  });

  it('carries no summary, surface, metric value, rate, or key', async () => {
    counters.logged('pricing');
    counters.verdict('moved');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    await flush(
      { CHANGELOG_TELEMETRY: '1', CHANGELOG_TELEMETRY_URL: 'https://example.com/c' } as NodeJS.ProcessEnv,
      fetchMock as unknown as typeof fetch,
    );

    const raw = (fetchMock.mock.calls[0][1] as RequestInit).body as string;
    expect(raw).not.toMatch(/phx_/);
    expect(raw).not.toMatch(/summary|surface|metric_hint|baseline|rate|pp/);
  });

  it('never lets a failed send affect the caller', async () => {
    counters.logged('pricing');
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    await expect(
      flush(
        { CHANGELOG_TELEMETRY: '1', CHANGELOG_TELEMETRY_URL: 'https://example.com/c' } as NodeJS.ProcessEnv,
        fetchMock as unknown as typeof fetch,
      ),
    ).resolves.toBeTruthy();
  });

  it('snapshot is a copy, so callers cannot mutate the counters', () => {
    counters.logged('pricing');
    const s = snapshot();
    s.categories.pricing = 999;
    expect(snapshot().categories.pricing).toBe(1);
  });
});
