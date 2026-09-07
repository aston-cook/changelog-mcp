# changelog MCP Server — Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An MCP server that logs user-visible product changes as PostHog annotations, then
later grades each one with an honest verdict that refuses to answer when the data cannot
support an answer.

**Architecture:** Two tools over stdio. `log_change` writes one PostHog annotation with a
parseable `[chg:1]` record. `check_changes` reads those annotations back, resolves each to
the closest measurable metric, excludes operator traffic at the person level, computes the
minimum detectable effect from the project's real baseline, and only then fits an
interrupted time series to separate the change from trend and weekly seasonality. No
database, no hosted service, no runtime LLM call.

**Tech Stack:** TypeScript (ESM, Node ≥20), `@modelcontextprotocol/sdk@1.30.0`, `zod@4`,
`vitest`. No statistical dependency — the ITS model is ~120 lines of weighted least squares.

**Spec:** `docs/spec.md` — read it first. Every design decision below traces to a numbered
finding (F1–F7) in that document.

## Global Constraints

- Node ≥ 20. ESM only (`"type": "module"`). The SDK is ESM with a `./*` exports wildcard, so
  subpath imports must carry the `.js` extension: `@modelcontextprotocol/sdk/server/mcp.js`.
- `@modelcontextprotocol/sdk` pinned to `1.30.0`. Do **not** use `@modelcontextprotocol/server`
  (SDK v2) — it GA'd 2026-07-27 and client support is not yet broad enough for a tool
  strangers will install. Migration is a follow-up, not part of v1.
- `registerTool(name, config, cb)` where `config.inputSchema` is a **raw Zod shape object**
  (`{ summary: z.string() }`), not `z.object({...})`. Verified against the installed
  `mcp.d.ts`. Annotations available: `readOnlyHint`, `destructiveHint`, `idempotentHint`,
  `openWorldHint`.
- The PostHog personal API key is read from env, never logged, never included in tool
  output, and redacted from every error path. This is enforced by a test, not by discipline.
- **`$virt_is_bot`, `$virt_traffic_type`, and `$virt_traffic_category` are never used as
  filters** (F2). A test asserts they appear in no generated query.
- Exactly three verdict strings: `moved`, `did not move`, `cannot tell yet`. No others.
- `did not move` is returned only when the study had power to detect a meaningful change.
  An underpowered null is `cannot tell yet`.
- Every statistical constant appears once, named, in `src/stats/`. No magic numbers inline.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/index.ts` | MCP server construction, tool registration, stdio transport |
| `src/config.ts` | Env parsing, validation, key redaction helper |
| `src/posthog.ts` | REST client: annotations CRUD + HogQL query endpoint |
| `src/annotation.ts` | Encode/decode the `[chg:1]` two-line record |
| `src/operator.ts` | Resolve the excluded operator person set |
| `src/metrics.ts` | Category → metric ladder, resolved against real taxonomy |
| `src/series.ts` | Daily numerator/denominator series, operator-excluded |
| `src/stats/normal.ts` | z and t quantiles (Cornish-Fisher) |
| `src/stats/mde.ts` | Minimum detectable effect, days-needed inversion |
| `src/stats/matrix.ts` | Small dense linear algebra (solve, invert) |
| `src/stats/its.ts` | Weighted-least-squares interrupted time series |
| `src/overlap.ts` | Overlapping-change detection |
| `src/verdict.ts` | Gating logic producing one of three verdicts |
| `src/telemetry.ts` | Opt-in counters, off by default |
| `src/tools/logChange.ts` | `log_change` handler |
| `src/tools/checkChanges.ts` | `check_changes` handler |
| `skills/changelog/SKILL.md` | When the agent should call `log_change` |

---

### Task 1: Scaffold, config, and a PostHog client that cannot leak the key

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`
- Create: `src/config.ts`, `src/posthog.ts`
- Test: `test/config.test.ts`, `test/posthog.test.ts`

**Interfaces:**
- Produces: `loadConfig(): Config` where
  `Config = { apiKey: string; projectId: string; host: string; operatorHostPatterns: string[] }`
- Produces: `redact(s: string, apiKey: string): string`
- Produces: `class PostHogClient` with
  `createAnnotation(input: {content: string; date_marker: string; scope?: string}): Promise<{id: number}>`,
  `listAnnotations(opts: {limit?: number; offset?: number; search?: string}): Promise<Annotation[]>`,
  `query(hogql: string): Promise<{columns: string[]; results: unknown[][]}>`

- [ ] **Step 1: Write the failing test for key redaction**

```ts
// test/config.test.ts
import { describe, it, expect } from 'vitest';
import { redact } from '../src/config.js';

describe('redact', () => {
  it('removes the api key from arbitrary text', () => {
    const key = 'phx_abc123SECRETvalue';
    const msg = `request failed: Authorization: Bearer ${key} (401)`;
    expect(redact(msg, key)).toBe('request failed: Authorization: Bearer phx_***REDACTED*** (401)');
    expect(redact(msg, key)).not.toContain('SECRET');
  });

  it('redacts any phx_ token even when it is not the configured key', () => {
    const out = redact('leaked phx_someOtherKey here', 'phx_configured');
    expect(out).not.toContain('someOtherKey');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — cannot resolve `../src/config.js`.

- [ ] **Step 3: Write `src/config.ts`**

```ts
export interface Config {
  apiKey: string;
  projectId: string;
  host: string;
  operatorHostPatterns: string[];
}

const KEY_PATTERN = /phx_[A-Za-z0-9_-]+/g;

export function redact(text: string, apiKey?: string): string {
  let out = text;
  if (apiKey) out = out.split(apiKey).join('phx_***REDACTED***');
  return out.replace(KEY_PATTERN, 'phx_***REDACTED***');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.POSTHOG_PERSONAL_API_KEY?.trim();
  const projectId = env.POSTHOG_PROJECT_ID?.trim();

  if (!apiKey) {
    throw new Error(
      'POSTHOG_PERSONAL_API_KEY is not set. Create a personal API key at ' +
      'https://us.posthog.com/settings/user-api-keys with the annotation:read, ' +
      'annotation:write and query:read scopes, then set it in your MCP client config.'
    );
  }
  if (!apiKey.startsWith('phx_')) {
    throw new Error(
      'POSTHOG_PERSONAL_API_KEY does not look like a personal API key (expected a phx_ prefix). ' +
      'Project API keys (phc_) and secret keys (phs_) will not work for annotations.'
    );
  }
  if (!projectId) {
    throw new Error(
      'POSTHOG_PROJECT_ID is not set. Without it the PostHog API falls back to "the last ' +
      'project you visited in the UI", which is not deterministic. Find the id in your ' +
      'project URL: https://us.posthog.com/project/<THIS_NUMBER>'
    );
  }

  return {
    apiKey,
    projectId,
    host: (env.POSTHOG_HOST?.trim() || 'https://us.posthog.com').replace(/\/+$/, ''),
    operatorHostPatterns: (env.CHANGELOG_OPERATOR_HOSTS?.trim() || 'localhost%,%.vercel.app')
      .split(',').map(s => s.trim()).filter(Boolean),
  };
}
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `npx vitest run test/config.test.ts` — Expected: PASS.

- [ ] **Step 5: Write the failing test for the client's error redaction**

```ts
// test/posthog.test.ts
import { describe, it, expect, vi } from 'vitest';
import { PostHogClient } from '../src/posthog.js';

const cfg = { apiKey: 'phx_TOPSECRET', projectId: '1', host: 'https://us.posthog.com', operatorHostPatterns: [] };

describe('PostHogClient', () => {
  it('never includes the api key in a thrown error', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false, status: 401,
      text: async () => `Invalid token phx_TOPSECRET`,
    });
    const client = new PostHogClient(cfg, fetchMock as unknown as typeof fetch);
    await expect(client.listAnnotations({})).rejects.toThrow(/REDACTED/);
    await expect(client.listAnnotations({})).rejects.not.toThrow(/TOPSECRET/);
  });

  it('sends the bearer header and the project-scoped path', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ results: [] }) });
    const client = new PostHogClient(cfg, fetchMock as unknown as typeof fetch);
    await client.listAnnotations({ limit: 10 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/projects/1/annotations/');
    expect((init.headers as Record<string,string>).Authorization).toBe('Bearer phx_TOPSECRET');
  });
});
```

- [ ] **Step 6: Run it, confirm it fails, then write `src/posthog.ts`**

```ts
import { Config, redact } from './config.js';

export interface Annotation {
  id: number;
  content: string | null;
  date_marker: string | null;
  scope: string;
  created_at: string;
}

export class PostHogClient {
  constructor(private cfg: Config, private fetchImpl: typeof fetch = fetch) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${this.cfg.host}${path}`;
    const res = await this.fetchImpl(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.cfg.apiKey}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = redact(await res.text().catch(() => ''), this.cfg.apiKey).slice(0, 600);
      throw new Error(hintForStatus(res.status, path, body));
    }
    return res.json() as Promise<T>;
  }

  createAnnotation(input: { content: string; date_marker: string; scope?: string }) {
    return this.request<{ id: number }>(`/api/projects/${this.cfg.projectId}/annotations/`, {
      method: 'POST',
      body: JSON.stringify({ scope: 'project', ...input }),
    });
  }

  async listAnnotations(opts: { limit?: number; offset?: number; search?: string }) {
    const qs = new URLSearchParams();
    if (opts.limit != null) qs.set('limit', String(opts.limit));
    if (opts.offset != null) qs.set('offset', String(opts.offset));
    if (opts.search) qs.set('search', opts.search);
    const r = await this.request<{ results: Annotation[] }>(
      `/api/projects/${this.cfg.projectId}/annotations/?${qs}`
    );
    return r.results;
  }

  query(hogql: string) {
    return this.request<{ columns: string[]; results: unknown[][] }>(
      `/api/projects/${this.cfg.projectId}/query/`,
      { method: 'POST', body: JSON.stringify({ query: { kind: 'HogQLQuery', query: hogql } }) }
    );
  }
}

function hintForStatus(status: number, path: string, body: string): string {
  if (status === 401) return `PostHog rejected the API key (401). Check POSTHOG_PERSONAL_API_KEY. ${body}`;
  if (status === 403) return `PostHog returned 403 for ${path}. The key is valid but is missing a scope — annotations need annotation:read and annotation:write, and check_changes needs query:read. ${body}`;
  if (status === 404) return `PostHog returned 404 for ${path}. Check POSTHOG_PROJECT_ID matches the number in your project URL. ${body}`;
  if (status === 429) return `PostHog rate limit hit (429). CRUD is 480/min and 4800/hour, the query endpoint 2400/hour, shared across your whole organization. Wait and retry. ${body}`;
  return `PostHog request to ${path} failed with ${status}. ${body}`;
}
```

- [ ] **Step 7: Confirm both test files pass, then commit**

```bash
npx vitest run
git add -A && git commit -m "feat: scaffold, config validation, and PostHog client with key redaction"
```

---

### Task 2: Annotation encoding

**Files:**
- Create: `src/annotation.ts`
- Test: `test/annotation.test.ts`

**Interfaces:**
- Produces: `ChangeRecord = { summary: string; category: Category; surface: string; metricHint?: string; date: string; annotationId?: number }`
- Produces: `encodeChange(r: Omit<ChangeRecord,'annotationId'>): string`
- Produces: `decodeChange(a: Annotation): ChangeRecord | { malformed: true; annotationId: number; reason: string } | null`
  (`null` means "not one of ours" — no `[chg:1]` prefix)
- Produces: `CATEGORIES` as a const tuple
- Produces: `CHANGE_PREFIX = '[chg:1] '`

- [ ] **Step 1: Write the failing tests**

```ts
// test/annotation.test.ts
import { describe, it, expect } from 'vitest';
import { encodeChange, decodeChange, CHANGE_PREFIX } from '../src/annotation.js';

const base = { summary: 'Asked questions first, saved progress before account',
  category: 'onboarding' as const, surface: '/free',
  metricHint: 'signup_started', date: '2026-09-01T00:00:00Z' };

describe('annotation encoding', () => {
  it('round-trips', () => {
    const content = encodeChange(base);
    const out = decodeChange({ id: 7, content, date_marker: base.date, scope: 'project', created_at: base.date });
    expect(out).toMatchObject({ summary: base.summary, category: 'onboarding', surface: '/free', metricHint: 'signup_started' });
  });

  it('puts the human summary on line one so PostHog charts read well', () => {
    expect(encodeChange(base).split('\n')[0]).toBe(CHANGE_PREFIX + base.summary);
  });

  it('survives characters that would break a delimiter format', () => {
    const tricky = { ...base, surface: 'store | checkout = "A|B"', summary: 'Cut price 20% | ref: a=b' };
    const out = decodeChange({ id: 1, content: encodeChange(tricky), date_marker: base.date, scope: 'project', created_at: base.date });
    expect(out).toMatchObject({ surface: tricky.surface, summary: tricky.summary });
  });

  it('returns null for annotations that are not ours', () => {
    expect(decodeChange({ id: 2, content: 'deployed v1.2.3', date_marker: base.date, scope: 'project', created_at: base.date })).toBeNull();
  });

  it('reports malformed records instead of throwing or silently dropping', () => {
    const out = decodeChange({ id: 3, content: CHANGE_PREFIX + 'x\n{not json', date_marker: base.date, scope: 'project', created_at: base.date });
    expect(out).toMatchObject({ malformed: true, annotationId: 3 });
  });

  it('rejects content over the PostHog 8192 limit', () => {
    expect(() => encodeChange({ ...base, summary: 'x'.repeat(9000) })).toThrow(/8192/);
  });
});
```

- [ ] **Step 2: Run, confirm fail. Then write `src/annotation.ts`**

```ts
import type { Annotation } from './posthog.js';

export const CATEGORIES = ['pricing','copy','onboarding','packaging','email','channel','other'] as const;
export type Category = typeof CATEGORIES[number];

export const CHANGE_PREFIX = '[chg:1] ';
const MAX_CONTENT = 8192; // verified against the PostHog annotation schema

export interface ChangeRecord {
  summary: string; category: Category; surface: string;
  metricHint?: string; date: string; annotationId?: number;
}
export interface MalformedRecord { malformed: true; annotationId: number; reason: string; }

export function encodeChange(r: Omit<ChangeRecord, 'annotationId'>): string {
  const meta = { v: 1, category: r.category, surface: r.surface,
                 ...(r.metricHint ? { metric_hint: r.metricHint } : {}) };
  const content = `${CHANGE_PREFIX}${r.summary.replace(/\s*\n\s*/g, ' ').trim()}\n${JSON.stringify(meta)}`;
  if (content.length > MAX_CONTENT) {
    throw new Error(`Encoded change is ${content.length} characters; PostHog annotation content is capped at ${MAX_CONTENT}. Shorten the summary.`);
  }
  return content;
}

export function decodeChange(a: Annotation): ChangeRecord | MalformedRecord | null {
  const content = a.content ?? '';
  if (!content.startsWith(CHANGE_PREFIX)) return null;
  const nl = content.indexOf('\n');
  if (nl === -1) return { malformed: true, annotationId: a.id, reason: 'missing metadata line' };
  const summary = content.slice(CHANGE_PREFIX.length, nl);
  try {
    const meta = JSON.parse(content.slice(nl + 1));
    if (!CATEGORIES.includes(meta.category)) {
      return { malformed: true, annotationId: a.id, reason: `unknown category ${String(meta.category)}` };
    }
    return { summary, category: meta.category, surface: String(meta.surface ?? ''),
             metricHint: meta.metric_hint, date: a.date_marker ?? a.created_at, annotationId: a.id };
  } catch {
    return { malformed: true, annotationId: a.id, reason: 'metadata line is not valid JSON' };
  }
}
```

- [ ] **Step 3: Run tests, confirm pass, commit**

```bash
npx vitest run test/annotation.test.ts
git add -A && git commit -m "feat: parseable [chg:1] annotation encoding"
```

---

### Task 3: `log_change` and the MCP server

First shippable slice — after this task the server logs changes.

**Files:**
- Create: `src/tools/logChange.ts`, `src/index.ts`
- Test: `test/logChange.test.ts`

**Interfaces:**
- Consumes: `encodeChange`, `CATEGORIES` (Task 2), `PostHogClient` (Task 1)
- Produces: `registerLogChange(server: McpServer, client: PostHogClient): void`

- [ ] **Step 1: Write the failing test**

```ts
// test/logChange.test.ts
import { describe, it, expect, vi } from 'vitest';
import { handleLogChange } from '../src/tools/logChange.js';

const client = () => ({ createAnnotation: vi.fn().mockResolvedValue({ id: 42 }), listAnnotations: vi.fn().mockResolvedValue([]) });

describe('log_change', () => {
  it('writes one annotation with the encoded record and returns the id', async () => {
    const c = client();
    const out = await handleLogChange(c as never, { summary: 'Cut Pro to $19', category: 'pricing', surface: '/pricing' });
    expect(c.createAnnotation).toHaveBeenCalledOnce();
    const body = c.createAnnotation.mock.calls[0][0];
    expect(body.content).toContain('[chg:1] Cut Pro to $19');
    expect(body.scope).toBe('project');
    expect(out).toContain('42');
  });

  it('defaults date to now in ISO-8601 with a Z offset', async () => {
    const c = client();
    await handleLogChange(c as never, { summary: 's', category: 'copy', surface: '/x' });
    expect(c.createAnnotation.mock.calls[0][0].date_marker).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it('never echoes the api key', async () => {
    const c = client();
    const out = await handleLogChange(c as never, { summary: 's', category: 'copy', surface: '/x' });
    expect(out).not.toMatch(/phx_/);
  });

  it('refuses a near-duplicate logged within the hour rather than double-logging', async () => {
    const c = client();
    c.listAnnotations.mockResolvedValue([
      { id: 9, content: '[chg:1] Cut Pro to $19\n{"v":1,"category":"pricing","surface":"/pricing"}',
        date_marker: new Date().toISOString(), scope: 'project', created_at: new Date().toISOString() },
    ]);
    const out = await handleLogChange(c as never, { summary: 'Cut Pro to $19', category: 'pricing', surface: '/pricing' });
    expect(c.createAnnotation).not.toHaveBeenCalled();
    expect(out).toMatch(/already logged/i);
  });
});
```

- [ ] **Step 2: Run, confirm fail. Then write `src/tools/logChange.ts`**

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CATEGORIES, encodeChange, decodeChange, type Category } from '../annotation.js';
import type { PostHogClient } from '../posthog.js';

export const logChangeShape = {
  summary: z.string().min(3).max(300)
    .describe('One line, human readable, past tense. What changed, not why. Example: "Asked onboarding questions before requiring an account".'),
  category: z.enum(CATEGORIES)
    .describe('pricing | copy | onboarding | packaging | email | channel | other. Use "other" only when none fit, and set metric_hint when you do.'),
  surface: z.string().min(1).max(200)
    .describe('Where it went live. Examples: "/free", "store checkout", "LinkedIn", "welcome email".'),
  metric_hint: z.string().max(120).optional()
    .describe('The funnel step this change most directly touches, as a PostHog event name where you know it. Example: "signup_started". Strongly improves the later verdict.'),
  date: z.string().datetime({ offset: true }).optional()
    .describe('ISO-8601 with offset. Defaults to now. Set it when logging a change that shipped earlier.'),
};

const DUPE_WINDOW_MS = 60 * 60 * 1000;

export async function handleLogChange(
  client: Pick<PostHogClient, 'createAnnotation' | 'listAnnotations'>,
  args: { summary: string; category: Category; surface: string; metric_hint?: string; date?: string }
): Promise<string> {
  const date = args.date ? new Date(args.date).toISOString() : new Date().toISOString();

  const recent = await client.listAnnotations({ limit: 50 });
  for (const a of recent) {
    const d = decodeChange(a);
    if (d && !('malformed' in d) && d.summary === args.summary && d.category === args.category
        && d.surface === args.surface
        && Math.abs(new Date(d.date).getTime() - new Date(date).getTime()) < DUPE_WINDOW_MS) {
      return `Already logged as annotation ${a.id} at ${d.date}. Not logging a duplicate. If this is genuinely a second, separate change, give it a summary that says how it differs.`;
    }
  }

  const content = encodeChange({ summary: args.summary, category: args.category,
    surface: args.surface, metricHint: args.metric_hint, date });
  const { id } = await client.createAnnotation({ content, date_marker: date, scope: 'project' });

  const hint = args.metric_hint ? '' :
    '\n\nNo metric_hint was given, so check_changes will fall back to the default ladder for this category. Naming the funnel step improves the verdict.';
  return `Logged change ${id} at ${date}.\n${content}${hint}`;
}

export function registerLogChange(server: McpServer, client: PostHogClient): void {
  server.registerTool('log_change', {
    title: 'Log a user-visible change',
    description:
      'Record ONE user-visible product change as a PostHog annotation so it can be graded later. ' +
      'Log only changes a user could notice: pricing, copy, onboarding, packaging, email, channel. ' +
      'Never log refactors, dependency bumps, tests, infra, or internal tooling. ' +
      'One change per call — never batch. Non-code changes count: a price change announced in chat ' +
      'logs exactly as well as a merged PR. If unsure whether something qualifies, ask the user once; never log speculatively.',
    inputSchema: logChangeShape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args) => ({ content: [{ type: 'text', text: await handleLogChange(client, args) }] }));
}
```

- [ ] **Step 3: Write `src/index.ts`**

```ts
#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, redact } from './config.js';
import { PostHogClient } from './posthog.js';
import { registerLogChange } from './tools/logChange.js';
import { registerCheckChanges } from './tools/checkChanges.js';

async function main() {
  const cfg = loadConfig();
  const client = new PostHogClient(cfg);
  const server = new McpServer({ name: 'changelog', version: '0.1.0' });
  registerLogChange(server, client);
  registerCheckChanges(server, client, cfg);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  // stdout is the MCP transport — diagnostics must go to stderr.
  console.error(redact(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
```

Until Task 10 lands, stub `registerCheckChanges` as a no-op export so this compiles.

- [ ] **Step 4: Run tests and typecheck, then commit**

```bash
npx vitest run && npx tsc --noEmit
git add -A && git commit -m "feat: log_change tool and MCP server over stdio"
```

---

### Task 4: Operator exclusion (F2, F3, F4)

The most load-bearing task in the project. Get this wrong and every verdict is wrong.

**Files:**
- Create: `src/operator.ts`
- Test: `test/operator.test.ts`

**Interfaces:**
- Produces: `buildOperatorPersonFilter(cfg: Config): string` — a HogQL subquery expression
- Produces: `operatorImpact(client, cfg, window): Promise<{ excludedPeople: number; excludedEvents: number }>`

- [ ] **Step 1: Write the failing tests — these encode the Phase 0 findings**

```ts
// test/operator.test.ts
import { describe, it, expect } from 'vitest';
import { buildOperatorPersonFilter } from '../src/operator.js';

const cfg = { apiKey: 'phx_x', projectId: '1', host: 'h', operatorHostPatterns: ['localhost%', '%.vercel.app'] };

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
    expect(sql).toContain('properties.$operator');
    expect(sql).toContain('person.properties.is_operator');
  });

  it('escapes single quotes in host patterns so a pattern cannot break out of the literal', () => {
    const sql = buildOperatorPersonFilter({ ...cfg, operatorHostPatterns: ["ev'il%"] });
    expect(sql).toContain("'ev\\'il%'");
  });
});
```

- [ ] **Step 2: Run, confirm fail. Then write `src/operator.ts`**

```ts
import type { Config } from './config.js';

export function sqlString(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * A HogQL subquery yielding every person_id that has ever emitted an operator signal.
 *
 * Person-level by design (spec F2): trial_created, trial_converted, payment_failed,
 * subscription_renewed and store_purchase_completed are sent from posthog-node with no
 * user agent. PostHog classifies those as $virt_is_bot = true. Filtering events on bot
 * properties would return zero trials forever. We exclude the *person*, then apply that
 * exclusion to all of their events including server-side ones.
 *
 * $host is the signal that actually works (spec F4): in the reference project it caught
 * 47 store checkouts with zero purchases from 9 people, while PostHog's bot detection
 * caught none of them — they are real headed browsers on localhost and preview hosts.
 */
export function buildOperatorPersonFilter(cfg: Config): string {
  const hostClauses = cfg.operatorHostPatterns
    .map(p => `properties.$host LIKE ${sqlString(p)}`)
    .join('\n          OR ');

  return `
    SELECT DISTINCT person_id
    FROM events
    WHERE timestamp >= now() - INTERVAL 365 DAY
      AND (
          ${hostClauses}
          OR properties.$operator = true
          OR person.properties.is_operator = true
      )`.trim();
}
```

- [ ] **Step 3: Add the live sanity check as a documented manual step**

Add to `docs/spec.md` under F4 a note that this query, run against the reference project,
must reproduce: clean 130 checkouts / 58 purchases, operator-touched 47 / 0.

- [ ] **Step 4: Run tests, commit**

```bash
npx vitest run test/operator.test.ts
git add -A && git commit -m "feat: person-level operator exclusion, never bot-property based"
```

---

### Task 5: Metric ladder (F5)

**Files:**
- Create: `src/metrics.ts`
- Test: `test/metrics.test.ts`

**Interfaces:**
- Produces: `type Metric = { name: string; numerator: string; denominator: string }`
- Produces: `LADDERS: Record<Category, Metric[]>`
- Produces: `resolveMetric(candidates, volumes): { chosen: Metric; skipped: {metric: Metric; reason: string}[] } | { chosen: null; skipped: [...] }`

`volumes` is a map from event name to `{ pre: number; post: number }`. A candidate is usable
only when **both** numerator and denominator have non-zero volume in **both** periods.

- [ ] **Step 1: Write the failing tests**

```ts
// test/metrics.test.ts
import { describe, it, expect } from 'vitest';
import { LADDERS, resolveMetric } from '../src/metrics.js';

describe('metric ladder', () => {
  it('picks the closest metric when it has volume in both periods', () => {
    const vols = { $pageview: {pre:11635,post:646}, signup_started: {pre:612,post:34}, signup_completed: {pre:610,post:33} };
    const r = resolveMetric(LADDERS.onboarding, vols);
    expect(r.chosen?.numerator).toBe('signup_completed');
    expect(r.chosen?.denominator).toBe('signup_started');
  });

  it('SKIPS a metric whose events did not exist pre-period, and says why (F5: the Sept 1 case)', () => {
    const vols = { onboarding_screen_viewed: {pre:0,post:57}, onboarding_screen_advanced: {pre:0,post:27},
                   $pageview: {pre:11635,post:646}, signup_started: {pre:612,post:34}, signup_completed: {pre:610,post:33} };
    const ladder = [{ name:'onboarding step-through', numerator:'onboarding_screen_advanced', denominator:'onboarding_screen_viewed' }, ...LADDERS.onboarding];
    const r = resolveMetric(ladder, vols);
    expect(r.chosen?.numerator).toBe('signup_completed');
    expect(r.skipped[0].reason).toMatch(/no pre-period volume/i);
    expect(r.skipped[0].metric.numerator).toBe('onboarding_screen_advanced');
  });

  it('returns no metric when nothing on the ladder is usable', () => {
    expect(resolveMetric(LADDERS.pricing, {}).chosen).toBeNull();
  });
});
```

- [ ] **Step 2: Run, confirm fail. Then write `src/metrics.ts`**

```ts
import type { Category } from './annotation.js';

export interface Metric { name: string; numerator: string; denominator: string; }

/**
 * Ordered closest-first. The revenue metric is always LAST: on the reference project,
 * grading an onboarding change on trial starts costs ~6x in resolution (spec F7 —
 * +-15.5pp on signup->trial vs +-2.53pp on visitors->signup_started over the same window).
 */
export const LADDERS: Record<Category, Metric[]> = {
  onboarding: [
    { name: 'signup completion',   numerator: 'signup_completed', denominator: 'signup_started' },
    { name: 'visitor to signup',   numerator: 'signup_started',   denominator: '$pageview' },
    { name: 'signup to trial',     numerator: 'trial_created',    denominator: 'signup_completed' },
  ],
  pricing: [
    { name: 'paywall to checkout', numerator: 'checkout_started', denominator: 'paywall_viewed' },
    { name: 'checkout to trial',   numerator: 'trial_created',    denominator: 'checkout_started' },
    { name: 'signup to trial',     numerator: 'trial_created',    denominator: 'signup_completed' },
  ],
  packaging: [
    { name: 'checkout to purchase', numerator: 'store_purchase_completed', denominator: 'store_checkout_started' },
    { name: 'paywall to checkout',  numerator: 'checkout_started',         denominator: 'paywall_viewed' },
  ],
  copy: [
    { name: 'visitor to signup',   numerator: 'signup_started',   denominator: '$pageview' },
    { name: 'signup completion',   numerator: 'signup_completed', denominator: 'signup_started' },
  ],
  email: [
    { name: 'visitor to signup',   numerator: 'signup_started',   denominator: '$pageview' },
  ],
  channel: [
    { name: 'visitor to signup',   numerator: 'signup_started',   denominator: '$pageview' },
  ],
  other: [
    { name: 'visitor to signup',   numerator: 'signup_started',   denominator: '$pageview' },
  ],
};

export type Volumes = Record<string, { pre: number; post: number }>;

export function resolveMetric(candidates: Metric[], volumes: Volumes) {
  const skipped: { metric: Metric; reason: string }[] = [];
  for (const m of candidates) {
    const n = volumes[m.numerator], d = volumes[m.denominator];
    if (!n || !d)                     { skipped.push({ metric: m, reason: `event not present in this project` }); continue; }
    if (d.pre === 0 || n.pre === 0)   { skipped.push({ metric: m, reason: `no pre-period volume — the change appears to have created these events, so there is nothing to compare against` }); continue; }
    if (d.post === 0)                 { skipped.push({ metric: m, reason: `no post-period volume` }); continue; }
    return { chosen: m, skipped };
  }
  return { chosen: null as Metric | null, skipped };
}
```

- [ ] **Step 3: Run tests, commit**

```bash
npx vitest run test/metrics.test.ts
git add -A && git commit -m "feat: closest-first metric ladder that skips metrics with no pre-period"
```

---

### Task 6: Daily series fetch

**Files:**
- Create: `src/series.ts`
- Test: `test/series.test.ts`

**Interfaces:**
- Consumes: `buildOperatorPersonFilter` (Task 4), `PostHogClient.query` (Task 1)
- Produces: `type DayPoint = { day: string; numerator: number; denominator: number }`
- Produces: `fetchSeries(client, cfg, metric, fromISO, toISO): Promise<DayPoint[]>`
- Produces: `fetchVolumes(client, cfg, events, changeDateISO, fromISO, toISO): Promise<Volumes>`

- [ ] **Step 1: Write the failing test**

```ts
// test/series.test.ts
import { describe, it, expect, vi } from 'vitest';
import { buildSeriesQuery } from '../src/series.js';

const cfg = { apiKey:'phx_x', projectId:'1', host:'h', operatorHostPatterns:['localhost%'] };
const metric = { name:'m', numerator:'signup_completed', denominator:'signup_started' };

describe('series query', () => {
  const sql = buildSeriesQuery(cfg, metric, '2026-06-01', '2026-09-06');

  it('counts people, not events, so one person cannot inflate a rate', () => {
    expect(sql).toMatch(/uniqIf\(person_id/);
    expect(sql).not.toMatch(/countIf\(event\s*=\s*'signup_completed'\)/);
  });

  it('excludes operator persons from BOTH numerator and denominator', () => {
    expect(sql).toContain('person_id NOT IN');
  });

  it('bounds the scan on timestamp in the WHERE clause', () => {
    expect(sql).toMatch(/WHERE[\s\S]*timestamp\s*>=/);
  });

  it('never touches bot properties', () => {
    expect(sql).not.toContain('$virt_is_bot');
  });
});
```

- [ ] **Step 2: Run, confirm fail. Then write `src/series.ts`**

```ts
import type { Config } from './config.js';
import type { Metric, Volumes } from './metrics.js';
import { buildOperatorPersonFilter, sqlString } from './operator.js';
import type { PostHogClient } from './posthog.js';

export interface DayPoint { day: string; numerator: number; denominator: number; }

export function buildSeriesQuery(cfg: Config, m: Metric, fromDate: string, toDate: string): string {
  const events = [...new Set([m.numerator, m.denominator])].map(sqlString).join(', ');
  return `
SELECT
    toDate(timestamp)                                   AS day,
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

export async function fetchSeries(client: PostHogClient, cfg: Config, m: Metric, from: string, to: string): Promise<DayPoint[]> {
  const r = await client.query(buildSeriesQuery(cfg, m, from, to));
  return r.results.map(row => ({ day: String(row[0]), numerator: Number(row[1]), denominator: Number(row[2]) }));
}
```

Also implement `buildVolumesQuery` / `fetchVolumes` in the same file, returning per-event
`pre` and `post` person counts split at the change date, using the same operator exclusion.

- [ ] **Step 3: Run tests, commit**

```bash
npx vitest run test/series.test.ts
git add -A && git commit -m "feat: operator-excluded daily series and pre/post volume fetch"
```

---

### Task 7: Minimum detectable effect

**Files:**
- Create: `src/stats/normal.ts`, `src/stats/mde.ts`
- Test: `test/mde.test.ts`

**Interfaces:**
- Produces: `Z_ALPHA_2 = 1.959964`, `Z_BETA_80 = 0.841621`, `tQuantile975(df: number): number`
- Produces: `mde(pPooled, nPre, nPost): number` — absolute, in proportion units
- Produces: `nPostNeeded(pPooled, nPre, targetMde): number | null` — `null` when unreachable
- Produces: `daysNeeded(pPooled, nPre, targetMde, denomPerDay): number | null`

- [ ] **Step 1: Write the failing tests using the verified Phase 0 numbers**

```ts
// test/mde.test.ts
import { describe, it, expect } from 'vitest';
import { mde, nPostNeeded, daysNeeded } from '../src/stats/mde.js';
import { tQuantile975 } from '../src/stats/normal.js';

describe('MDE — values verified against the reference project in Phase 0', () => {
  it('signup->trial over 5 post-days is +-15.5pp', () => {
    expect(mde(68/610, 610, 34)).toBeCloseTo(0.1554, 3);
  });
  it('visitors->signup_started over 5 post-days is +-2.53pp', () => {
    expect(mde(612/11635, 11635, 646)).toBeCloseTo(0.0253, 3);
  });
  it('visitors->signup_started over 30 post-days is +-1.16pp', () => {
    expect(mde(612/11635, 11635, 3870)).toBeCloseTo(0.0116, 3);
  });
  it('reports a floor that an infinite post-period cannot beat', () => {
    expect(mde(68/610, 610, Number.MAX_SAFE_INTEGER)).toBeCloseTo(0.0356, 3);
  });
  it('returns null when the target MDE is unreachable with the given pre-period', () => {
    expect(nPostNeeded(68/610, 610, 0.03)).toBeNull();
  });
  it('needs about 93 days of post-period to resolve a 5pp move on signup->trial', () => {
    expect(daysNeeded(68/610, 610, 0.05, 610/90)).toBeCloseTo(93, -1);
  });
});

describe('t quantile', () => {
  it('matches the table at df=33', () => { expect(tQuantile975(33)).toBeCloseTo(2.0345, 3); });
  it('converges to z for large df', () => { expect(tQuantile975(100000)).toBeCloseTo(1.95996, 4); });
});
```

- [ ] **Step 2: Run, confirm fail. Then write `src/stats/normal.ts`**

```ts
export const Z_ALPHA_2 = 1.959964;  // two-sided alpha = 0.05
export const Z_BETA_80 = 0.841621;  // power = 0.80
export const Z_SUM = Z_ALPHA_2 + Z_BETA_80; // 2.801585

/** Two-sided 97.5th percentile of Student's t. Cornish-Fisher expansion; matches tables to 4dp for df >= 5. */
export function tQuantile975(df: number): number {
  const z = Z_ALPHA_2, z2 = z*z, z3 = z2*z, z5 = z3*z2, z7 = z5*z2;
  return z
    + (z3 + z) / (4 * df)
    + (5*z5 + 16*z3 + 3*z) / (96 * df*df)
    + (3*z7 + 19*z5 + 17*z3 - 15*z) / (384 * df*df*df);
}
```

- [ ] **Step 3: Write `src/stats/mde.ts`**

```ts
import { Z_SUM } from './normal.js';

/** Absolute minimum detectable effect in proportion units, two-proportion z-test, alpha=.05 two-sided, power=.80. */
export function mde(pPooled: number, nPre: number, nPost: number): number {
  const v = pPooled * (1 - pPooled);
  return Z_SUM * Math.sqrt(v * (1 / nPre + 1 / nPost));
}

/** Post-period sample size needed to reach targetMde. null when the pre-period alone already exceeds it. */
export function nPostNeeded(pPooled: number, nPre: number, targetMde: number): number | null {
  const v = pPooled * (1 - pPooled);
  const total = (targetMde / Z_SUM) ** 2 / v;   // required (1/nPre + 1/nPost)
  const remaining = total - 1 / nPre;
  if (remaining <= 0) return null;              // unreachable: extend the pre-period instead
  return Math.ceil(1 / remaining);
}

export function daysNeeded(pPooled: number, nPre: number, targetMde: number, denomPerDay: number): number | null {
  const n = nPostNeeded(pPooled, nPre, targetMde);
  return n === null ? null : Math.ceil(n / denomPerDay);
}
```

- [ ] **Step 4: Run tests, commit**

```bash
npx vitest run test/mde.test.ts
git add -A && git commit -m "feat: minimum detectable effect and days-needed inversion"
```

---

### Task 8: Interrupted time series

**Files:**
- Create: `src/stats/matrix.ts`, `src/stats/its.ts`
- Test: `test/its.test.ts`

**Interfaces:**
- Produces: `solveSymmetric(A: number[][], b: number[]): number[]`, `invertSymmetric(A): number[][]`
- Produces: `ItsResult = { step: number; se: number; ciLow: number; ciHigh: number; df: number }`
- Produces: `fitIts(points: DayPoint[], interventionDay: string): ItsResult`

Model: `rate_t = b0 + b1·t + Σ b_dow·D_t + b_step·1[t ≥ intervention]`, fit by weighted least
squares with weights equal to each day's denominator (binomial variance is inversely
proportional to n). Nine parameters: intercept, trend, six day-of-week dummies, step.

- [ ] **Step 1: Write the failing tests**

```ts
// test/its.test.ts
import { describe, it, expect } from 'vitest';
import { fitIts } from '../src/stats/its.js';

function synth(days: number, base: number, trendPerDay: number, step: number, stepAt: number, n = 400) {
  const pts = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.UTC(2026, 0, 1 + i));
    const dow = d.getUTCDay();
    const weekend = (dow === 0 || dow === 6) ? -0.01 : 0;
    const rate = base + trendPerDay * i + weekend + (i >= stepAt ? step : 0);
    pts.push({ day: d.toISOString().slice(0, 10), numerator: Math.round(rate * n), denominator: n });
  }
  return pts;
}

describe('interrupted time series', () => {
  it('recovers a known +3pp step', () => {
    const pts = synth(120, 0.05, 0, 0.03, 90);
    const r = fitIts(pts, pts[90].day);
    expect(r.step).toBeCloseTo(0.03, 2);
    expect(r.ciLow).toBeGreaterThan(0);
  });

  it('does not credit a pre-existing upward trend to the change', () => {
    const pts = synth(120, 0.05, 0.0004, 0, 90);   // rising, no step
    const r = fitIts(pts, pts[90].day);
    expect(Math.abs(r.step)).toBeLessThan(0.01);
    expect(r.ciLow).toBeLessThan(0);
    expect(r.ciHigh).toBeGreaterThan(0);
  });

  it('does not credit weekly seasonality to the change', () => {
    const pts = synth(120, 0.05, 0, 0, 90);
    expect(Math.abs(fitIts(pts, pts[90].day).step)).toBeLessThan(0.005);
  });

  it('returns a CI containing zero for a flat series', () => {
    const r = fitIts(synth(120, 0.05, 0, 0, 90), synth(120,0.05,0,0,90)[90].day);
    expect(r.ciLow).toBeLessThan(0); expect(r.ciHigh).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run, confirm fail. Write `src/stats/matrix.ts`**

Gauss-Jordan with partial pivoting; throw a named error on a singular matrix so the caller
can degrade to `cannot tell yet` rather than emit `NaN`.

- [ ] **Step 3: Write `src/stats/its.ts`**

```ts
import type { DayPoint } from '../series.js';
import { invertSymmetric } from './matrix.js';
import { tQuantile975 } from './normal.js';

export interface ItsResult { step: number; se: number; ciLow: number; ciHigh: number; df: number; }

const P = 9; // intercept + trend + 6 dow dummies + step
const STEP_IX = 8;

export function fitIts(points: DayPoint[], interventionDay: string): ItsResult {
  const usable = points.filter(p => p.denominator > 0);
  const t0 = Date.parse(usable[0].day + 'T00:00:00Z');
  const cut = Date.parse(interventionDay.slice(0, 10) + 'T00:00:00Z');

  const X: number[][] = [], y: number[] = [], w: number[] = [];
  for (const p of usable) {
    const ms = Date.parse(p.day + 'T00:00:00Z');
    const t = (ms - t0) / 86_400_000;
    const dow = new Date(ms).getUTCDay();            // 0 = Sunday, treated as the reference level
    const row = new Array(P).fill(0);
    row[0] = 1; row[1] = t;
    if (dow >= 1 && dow <= 6) row[1 + dow] = 1;
    row[STEP_IX] = ms >= cut ? 1 : 0;
    X.push(row); y.push(p.numerator / p.denominator); w.push(p.denominator);
  }

  const XtWX = Array.from({length: P}, () => new Array(P).fill(0));
  const XtWy = new Array(P).fill(0);
  for (let i = 0; i < X.length; i++)
    for (let a = 0; a < P; a++) {
      XtWy[a] += w[i] * X[i][a] * y[i];
      for (let b = 0; b < P; b++) XtWX[a][b] += w[i] * X[i][a] * X[i][b];
    }

  const inv = invertSymmetric(XtWX);
  const beta = inv.map(r => r.reduce((s, v, k) => s + v * XtWy[k], 0));

  let rss = 0;
  for (let i = 0; i < X.length; i++) {
    const fit = X[i].reduce((s, v, k) => s + v * beta[k], 0);
    rss += w[i] * (y[i] - fit) ** 2;
  }
  const df = X.length - P;
  const s2 = rss / df;
  const se = Math.sqrt(s2 * inv[STEP_IX][STEP_IX]);
  const crit = tQuantile975(df);

  return { step: beta[STEP_IX], se, ciLow: beta[STEP_IX] - crit * se, ciHigh: beta[STEP_IX] + crit * se, df };
}
```

- [ ] **Step 4: Run tests, commit**

```bash
npx vitest run test/its.test.ts
git add -A && git commit -m "feat: WLS interrupted time series with trend and weekly seasonality"
```

---

### Task 9: Overlap detection and verdict gating

The rule that makes the tool trustworthy lives here.

**Files:**
- Create: `src/overlap.ts`, `src/verdict.ts`
- Test: `test/verdict.test.ts`

**Interfaces:**
- Produces: `findOverlaps(changes, resolvedMetricByChangeId, windowDays): Map<number, number[]>`
- Produces: `Verdict = 'moved' | 'did not move' | 'cannot tell yet'`
- Produces: `decide(input): { verdict: Verdict; reason: string; detail: {...} }`

Guard rails (spec F6 — engineering judgment, explicitly not cited as CausalImpact doctrine):
`MIN_PRE_DAYS = 28`, `MIN_POST_DAYS = 14`, `MIN_PRE_POST_RATIO = 3`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/verdict.test.ts
import { describe, it, expect } from 'vitest';
import { decide } from '../src/verdict.js';
import { findOverlaps } from '../src/overlap.js';

const ok = { preDays: 90, postDays: 30, nPre: 11635, nPost: 3870, pPooled: 0.0526,
  observedEffect: 0.02, its: { step: 0.02, se: 0.004, ciLow: 0.012, ciHigh: 0.028, df: 111 },
  overlappingWith: [] as number[], denomPerDay: 129 };

describe('verdict gating', () => {
  it('returns "moved" only when the effect clears MDE and the CI excludes zero', () => {
    expect(decide(ok).verdict).toBe('moved');
  });

  it('returns "cannot tell yet" for an underpowered null — NEVER "did not move"', () => {
    const r = decide({ ...ok, postDays: 5, nPost: 646, observedEffect: 0.001,
      its: { step: 0.001, se: 0.02, ciLow: -0.04, ciHigh: 0.042, df: 86 } });
    expect(r.verdict).toBe('cannot tell yet');
    expect(r.reason).toMatch(/would need/i);
  });

  it('returns "did not move" only when powered enough to have seen a real change', () => {
    const r = decide({ ...ok, observedEffect: 0.0005,
      its: { step: 0.0005, se: 0.003, ciLow: -0.0054, ciHigh: 0.0064, df: 111 } });
    expect(r.verdict).toBe('did not move');
  });

  it('refuses to grade when the post-period is too short for the ITS model', () => {
    const r = decide({ ...ok, postDays: 7, nPost: 903 });
    expect(r.verdict).toBe('cannot tell yet');
    expect(r.reason).toMatch(/14 post-period days/);
  });

  it('refuses to grade when the pre:post ratio is below 3:1', () => {
    const r = decide({ ...ok, preDays: 40, postDays: 30 });
    expect(r.verdict).toBe('cannot tell yet');
    expect(r.reason).toMatch(/3:1/);
  });

  it('refuses BOTH changes when two overlap on the same metric', () => {
    const r = decide({ ...ok, overlappingWith: [77] });
    expect(r.verdict).toBe('cannot tell yet');
    expect(r.reason).toMatch(/overlaps with change 77/);
  });
});

describe('overlap detection', () => {
  it('flags two changes on the same metric within the window', () => {
    const changes = [{ annotationId: 1, date: '2026-09-01T00:00:00Z' }, { annotationId: 2, date: '2026-09-10T00:00:00Z' }];
    const metrics = new Map([[1, 'visitor to signup'], [2, 'visitor to signup']]);
    expect(findOverlaps(changes, metrics, 30).get(1)).toContain(2);
  });

  it('does not flag two changes on different metrics', () => {
    const changes = [{ annotationId: 1, date: '2026-09-01T00:00:00Z' }, { annotationId: 2, date: '2026-09-10T00:00:00Z' }];
    const metrics = new Map([[1, 'visitor to signup'], [2, 'checkout to purchase']]);
    expect(findOverlaps(changes, metrics, 30).get(1) ?? []).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run, confirm fail. Then write `src/verdict.ts`**

Order of checks — this order is the contract:
1. `overlappingWith.length > 0` → `cannot tell yet`, naming the other change ids.
2. `postDays < MIN_POST_DAYS` → `cannot tell yet`, naming the shortfall and the date it clears.
3. `preDays < MIN_PRE_DAYS` → `cannot tell yet`.
4. `preDays / postDays < MIN_PRE_POST_RATIO` → `cannot tell yet`.
5. Compute `m = mde(pPooled, nPre, nPost)`.
6. If `|observedEffect| >= m` **and** the ITS CI excludes zero → `moved`.
7. If `m <= MEANINGFUL_FRACTION * pPooled` (default 0.25 — powered to see a 25% relative
   change) and the CI includes zero → `did not move`.
8. Otherwise → `cannot tell yet`, with `daysNeeded(...)` filled in so the reason says exactly
   what it would take.

- [ ] **Step 3: Run tests, commit**

```bash
npx vitest run test/verdict.test.ts
git add -A && git commit -m "feat: verdict gating that never calls an underpowered null a null result"
```

---

### Task 10: `check_changes`

**Files:**
- Create: `src/tools/checkChanges.ts`
- Modify: `src/index.ts` (replace the stub)
- Test: `test/checkChanges.test.ts`

- [ ] **Step 1: Write the failing integration test with a stubbed client**

Cover: one gradeable change, one underpowered change, two overlapping changes, one malformed
annotation. Assert the rendered output contains no `phx_`, no dashboard link, no arrow
glyphs, and exactly one of the three verdict strings per change.

- [ ] **Step 2: Implement the handler**

Pipeline per change: fetch volumes → resolve metric → fetch series → compute MDE →
detect overlap → fit ITS if the guard rails pass → decide → render.

Output block per change, plain text:

```
[moved] Cut Pro from $29 to $19            pricing · /pricing · 2026-07-14
  metric      paywall_viewed -> checkout_started  (closest available)
  baseline    12.4%   post 15.1%   (+2.7pp, +22% relative)
  resolution  MDE +-1.9pp at n=2140 pre / 1180 post
  method      interrupted time series (no control series - forecast only)
              trend and day-of-week removed before comparison
  excluded    9 operator people (312 events) via $host
```

- [ ] **Step 3: Register the tool**

```ts
server.registerTool('check_changes', {
  title: 'Grade logged changes',
  description:
    'Return a verdict for each logged change: moved, did not move, or cannot tell yet. ' +
    'Computes the minimum detectable effect from the project\'s real baseline before reporting ' +
    'anything, excludes operator traffic at the person level, prefers the metric closest to the ' +
    'change over the revenue metric, and refuses to grade changes that overlap in time on the same metric.',
  inputSchema: {
    since: z.string().datetime({ offset: true }).optional().describe('Only grade changes logged on or after this instant. Defaults to 180 days ago.'),
    category: z.enum(CATEGORIES).optional().describe('Only grade changes in this category.'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, handler);
```

- [ ] **Step 4: Run the full suite and typecheck, then commit**

```bash
npx vitest run && npx tsc --noEmit
git add -A && git commit -m "feat: check_changes verdict tool"
```

---

### Task 11: The skill file

**Files:**
- Create: `skills/changelog/SKILL.md`

The aggressive DO-NOT list is the whole design. Forty useless entries a week and the log is
dead. The file must state:

- Log only user-visible changes: pricing, copy, onboarding, packaging, email, channel.
- Never log refactors, dependency bumps, tests, infra, CI, internal tooling, or formatting.
- Non-code changes count and matter most. "Prices came down today" typed in chat logs
  exactly as well as a merged PR does.
- One change per entry. Never batch. Two prices in one deploy are two entries.
- If unsure, ask once. Never log speculatively.
- Include a worked DO table and a worked DO-NOT table with realistic examples of each.

- [ ] **Step 1: Write `skills/changelog/SKILL.md` with frontmatter (`name`, `description`)**
- [ ] **Step 2: Commit**

---

### Task 12: Opt-in telemetry

**Files:**
- Create: `src/telemetry.ts`
- Test: `test/telemetry.test.ts`

- [ ] **Step 1: Write the failing tests**

Assert: off by default; enabled only by `CHANGELOG_TELEMETRY=1`; the emitted payload contains
tool name, category, and verdict **only**; assert the payload never contains a summary, a
surface, a metric value, a rate, or anything matching `phx_`. With telemetry enabled and no
`CHANGELOG_TELEMETRY_URL`, it is a documented no-op (no hosted service is in scope).

- [ ] **Step 2: Implement, run, commit**

---

### Task 13: README and the live run

**Files:**
- Create: `README.md`
- Modify: `docs/spec.md` (record the live result)

- [ ] **Step 1: Write the README**

Setup (key scopes, project id, MCP client config JSON for Claude Code and Claude Desktop),
the telemetry section, and an **Operator traffic** section carrying the F4 table and the
optional 5-line posthog-js change:

```ts
posthog.init(KEY, { api_host: HOST });
if (process.env.NEXT_PUBLIC_OPERATOR === '1') {
  posthog.register({ $operator: true });      // super property on every event
  posthog.setPersonProperties({ is_operator: true });
}
```

State plainly what `$host` catches without this and what it misses.

- [ ] **Step 2: Run the live test against the Sept 1 onboarding change**

```bash
POSTHOG_PROJECT_ID=12345 node dist/index.js   # via the MCP client
```

Expected, from Phase 0: `cannot tell yet`. The closest metric is skipped because
`onboarding_screen_viewed` has no pre-period volume (F5); the chosen metric is
visitors → `signup_started`; MDE is roughly ±2.53pp against a 5.26% baseline over 5 post-days;
the reason states that roughly 30 post-days are needed for ±1.16pp.

Record the actual output verbatim in `docs/spec.md`. **If it returns anything other than
`cannot tell yet`, stop and investigate — the gating is wrong.**

- [ ] **Step 3: Commit and open the branch for review**

---

## Self-Review

**Spec coverage.** Phase 1 → Tasks 2, 3. Phase 2 → Task 11. Phase 3 → Tasks 4–10
(annotation read T10, metric pairing T5, operator exclusion T4, MDE-before-verdict T7+T9,
closest metric T5, three verdicts T9, ITS T8, overlap T9). Phase 4 → Task 12. Deliverables →
Task 13. No gaps.

**Placeholders.** Tasks 6, 9, 10, 11, 12 carry prose specifications rather than complete
code for their implementation steps. Each names exact files, exact interfaces, exact ordering
and complete test code — the contract is pinned even where the body is not transcribed.
Tasks 10 and 11 are prose by nature (rendering and documentation). If executing with a
subagent per task, expand Task 9's step 2 into literal code first; inline execution can work
from the ordered contract as written.

**Type consistency.** `Metric`, `Volumes`, `DayPoint`, `ItsResult`, `Config`, `ChangeRecord`,
`Category` are each defined once and referenced with matching shapes throughout.
`buildOperatorPersonFilter` and `sqlString` are both exported from `src/operator.ts` and
imported by `src/series.ts`. `redact` takes an optional second argument in `config.ts` and is
called with one argument in `index.ts` — consistent.
