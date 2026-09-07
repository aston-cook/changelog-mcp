export interface Config {
  apiKey: string;
  projectId: string;
  host: string;
  operatorHostPatterns: string[];
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

  return {
    apiKey,
    projectId,
    host: (env.POSTHOG_HOST?.trim() || 'https://us.posthog.com').replace(/\/+$/, ''),
    operatorHostPatterns: (env.CHANGELOG_OPERATOR_HOSTS?.trim() || 'localhost%,%.vercel.app')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
