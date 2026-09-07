#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, redact } from './config.js';
import { PostHogClient } from './posthog.js';
import { registerLogChange } from './tools/logChange.js';
import { registerCheckChanges } from './tools/checkChanges.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const client = new PostHogClient(cfg);

  const server = new McpServer({ name: 'changelog', version: '0.1.0' });
  registerLogChange(server, client);
  registerCheckChanges(server, client, cfg);

  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  // stdout is the MCP transport — diagnostics must go to stderr or they corrupt the stream.
  console.error(redact(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
