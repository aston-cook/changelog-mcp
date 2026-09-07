export interface Config {
  apiKey: string;
  projectId: string;
  host: string;
  operatorHostPatterns: string[];
  /**
   * Earliest date each event's data can be trusted, as `event -> YYYY-MM-DD`.
   *
   * Analytics accumulate hard boundaries: an identity key that changed, a webhook added
   * late, a migration that re-shaped a table. Reading across one silently produces a
   * confident wrong number. Declare them and the tool refuses to look further back.
   */
  eventValidFrom: Record<string, string>;
}

const VALID_FROM_ENTRY = /^([A-Za-z0-9_$.\-]+):(\d{4}-\d{2}-\d{2})$/;

export function parseEventValidFrom(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw?.trim()) return out;

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const m = VALID_FROM_ENTRY.exec(trimmed);
    if (!m) {
      throw new Error(
        `CHANGELOG_EVENT_VALID_FROM entry "${trimmed}" is malformed. ` +
          `Expected comma-separated "event_name:YYYY-MM-DD" pairs, ` +
          `e.g. "store_purchase_completed:2026-07-05,store_checkout_started:2026-07-05".`,
      );
    }
    out[m[1]!] = m[2]!;
  }
  return out;
}

const KEY_PATTERN = /phx_[A-Za-z0-9_-]+/g;

/**
 * Strip the PostHog personal API key from any text before it reaches a log, an error
 * message, or tool output. Redacts the configured key by exact match and, as a backstop,
 * anything else shaped like a personal API key.
 */
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
        'annotation:write and query:read scopes, then set it in your MCP client config.',
    );
  }
  if (!apiKey.startsWith('phx_')) {
    throw new Error(
      'POSTHOG_PERSONAL_API_KEY does not look like a personal API key (expected a phx_ prefix). ' +
        'Project API keys (phc_) and project secret keys (phs_) will not work for annotations.',
    );
  }
  if (!projectId) {
    throw new Error(
      'POSTHOG_PROJECT_ID is not set. Without it the PostHog API falls back to "the last ' +
        'project you visited in the UI", which is not deterministic. Find the id in your ' +
        'project URL: https://us.posthog.com/project/<THIS_NUMBER>',
    );
  }

  // An explicitly empty value means "no host patterns", not "fall back to the defaults" —
  // otherwise there is no way to turn host-based operator detection off.
  const rawHosts = env.CHANGELOG_OPERATOR_HOSTS;
  const hosts = rawHosts === undefined ? 'localhost%,%.vercel.app' : rawHosts;

  return {
    apiKey,
    projectId,
    host: (env.POSTHOG_HOST?.trim() || 'https://us.posthog.com').replace(/\/+$/, ''),
    operatorHostPatterns: hosts
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    eventValidFrom: parseEventValidFrom(env.CHANGELOG_EVENT_VALID_FROM),
  };
}
