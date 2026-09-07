import { describe, it, expect, vi } from 'vitest';
import { PostHogClient } from '../src/posthog.js';
import type { Config } from '../src/config.js';

const cfg: Config = {
  apiKey: 'phx_TOPSECRET',
  projectId: '1',
  host: 'https://us.posthog.com',
  operatorHostPatterns: [],
  eventValidFrom: {},
};

const okResponse = (json: unknown) =>
  ({ ok: true, status: 200, json: async () => json }) as unknown as Response;

const errResponse = (status: number, text: string) =>
  ({ ok: false, status, text: async () => text }) as unknown as Response;

describe('PostHogClient', () => {
  it('never includes the api key in a thrown error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errResponse(401, 'Invalid token phx_TOPSECRET'));
    const client = new PostHogClient(cfg, fetchMock as unknown as typeof fetch);

    const err = await client.listAnnotations({}).catch((e: unknown) => e);
    expect(String(err)).toContain('REDACTED');
    expect(String(err)).not.toContain('TOPSECRET');
  });

  it('sends the bearer header and the project-scoped path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ results: [] }));
    const client = new PostHogClient(cfg, fetchMock as unknown as typeof fetch);
    await client.listAnnotations({ limit: 10 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/projects/1/annotations/');
    expect(url).toContain('limit=10');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer phx_TOPSECRET');
  });

  it('posts annotations with project scope by default', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ id: 42 }));
    const client = new PostHogClient(cfg, fetchMock as unknown as typeof fetch);
    const out = await client.createAnnotation({ content: 'x', date_marker: '2026-09-01T00:00:00Z' });

    expect(out.id).toBe(42);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.scope).toBe('project');
    expect(body.date_marker).toBe('2026-09-01T00:00:00Z');
  });

  it('sends HogQL to the query endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ columns: ['a'], results: [[1]] }));
    const client = new PostHogClient(cfg, fetchMock as unknown as typeof fetch);
    const r = await client.query('SELECT 1');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/projects/1/query/');
    expect(JSON.parse(init.body as string)).toEqual({
      query: { kind: 'HogQLQuery', query: 'SELECT 1' },
    });
    expect(r.results).toEqual([[1]]);
  });

  it('explains a 403 as a missing scope, not a bad key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errResponse(403, 'forbidden'));
    const client = new PostHogClient(cfg, fetchMock as unknown as typeof fetch);
    await expect(client.query('SELECT 1')).rejects.toThrow(/missing a scope/);
  });

  it('explains a 429 with the actual PostHog rate limits', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errResponse(429, 'slow down'));
    const client = new PostHogClient(cfg, fetchMock as unknown as typeof fetch);
    await expect(client.query('SELECT 1')).rejects.toThrow(/480\/minute/);
  });

  it('turns a network failure into an actionable host hint', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const client = new PostHogClient(cfg, fetchMock as unknown as typeof fetch);
    await expect(client.query('SELECT 1')).rejects.toThrow(/eu\.posthog\.com/);
  });
});
