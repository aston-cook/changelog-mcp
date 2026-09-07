import { type Config, redact } from './config.js';

export interface Annotation {
  id: number;
  content: string | null;
  date_marker: string | null;
  scope: string;
  created_at: string;
}

export interface QueryResult {
  columns: string[];
  results: unknown[][];
}

export class PostHogClient {
  constructor(
    private cfg: Config,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${this.cfg.host}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not reach PostHog at ${this.cfg.host}. Check POSTHOG_HOST (use https://eu.posthog.com ` +
          `if your project is on EU cloud). ${redact(msg, this.cfg.apiKey)}`,
      );
    }

    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      const body = redact(raw, this.cfg.apiKey).slice(0, 600);
      throw new Error(hintForStatus(res.status, path, body));
    }
    return (await res.json()) as T;
  }

  createAnnotation(input: {
    content: string;
    date_marker: string;
    scope?: string;
  }): Promise<{ id: number }> {
    return this.request<{ id: number }>(`/api/projects/${this.cfg.projectId}/annotations/`, {
      method: 'POST',
      body: JSON.stringify({ scope: 'project', ...input }),
    });
  }

  async listAnnotations(opts: {
    limit?: number;
    offset?: number;
    search?: string;
  }): Promise<Annotation[]> {
    const qs = new URLSearchParams();
    if (opts.limit != null) qs.set('limit', String(opts.limit));
    if (opts.offset != null) qs.set('offset', String(opts.offset));
    if (opts.search) qs.set('search', opts.search);
    const r = await this.request<{ results: Annotation[] }>(
      `/api/projects/${this.cfg.projectId}/annotations/?${qs.toString()}`,
    );
    return r.results ?? [];
  }

  async query(hogql: string): Promise<QueryResult> {
    const r = await this.request<QueryResult>(`/api/projects/${this.cfg.projectId}/query/`, {
      method: 'POST',
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query: hogql } }),
    });
    return { columns: r.columns ?? [], results: r.results ?? [] };
  }
}

function hintForStatus(status: number, path: string, body: string): string {
  if (status === 401) {
    return `PostHog rejected the API key (401). Check POSTHOG_PERSONAL_API_KEY. ${body}`;
  }
  if (status === 403) {
    return (
      `PostHog returned 403 for ${path}. The key is valid but is missing a scope — ` +
      `log_change needs annotation:read and annotation:write, check_changes also needs query:read. ` +
      `Edit the key's scopes at https://us.posthog.com/settings/user-api-keys. ${body}`
    );
  }
  if (status === 404) {
    return (
      `PostHog returned 404 for ${path}. Check POSTHOG_PROJECT_ID matches the number in your ` +
      `project URL (https://us.posthog.com/project/<THIS_NUMBER>). ${body}`
    );
  }
  if (status === 429) {
    return (
      `PostHog rate limit hit (429). CRUD is 480/minute and 4800/hour, the query endpoint ` +
      `2400/hour, shared across your whole organization rather than per key. Wait and retry. ${body}`
    );
  }
  return `PostHog request to ${path} failed with ${status}. ${body}`;
}
