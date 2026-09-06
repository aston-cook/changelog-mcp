import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PostHogClient } from '../posthog.js';
import type { Config } from '../config.js';

// Replaced in Task 10. Registered here so src/index.ts has a stable import from Task 3 on.
export function registerCheckChanges(
  _server: McpServer,
  _client: PostHogClient,
  _cfg: Config,
): void {
  // no-op until the verdict engine lands
}
