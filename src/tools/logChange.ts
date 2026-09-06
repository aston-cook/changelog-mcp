import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CATEGORIES, encodeChange, decodeChange, isMalformed, type Category } from '../annotation.js';
import type { PostHogClient } from '../posthog.js';
import { counters } from '../telemetry.js';

export const logChangeShape = {
  summary: z
    .string()
    .min(3)
    .max(300)
    .describe(
      'One line, human readable, past tense. What changed, not why. ' +
        'Example: "Asked onboarding questions before requiring an account".',
    ),
  category: z
    .enum(CATEGORIES)
    .describe(
      'pricing | copy | onboarding | packaging | email | channel | other. ' +
        'Use "other" only when none of the rest fit, and set metric_hint when you do.',
    ),
  surface: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'Where it went live. Examples: "/free", "store checkout", "LinkedIn", "welcome email".',
    ),
  metric_hint: z
    .string()
    .max(120)
    .optional()
    .describe(
      'The funnel step this change most directly touches, as a PostHog event name where you ' +
        'know it. Example: "signup_started". Strongly improves the later verdict.',
    ),
  date: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe(
      'ISO-8601 with offset. Defaults to now. Set it when logging a change that shipped earlier.',
    ),
};

export interface LogChangeArgs {
  summary: string;
  category: Category;
  surface: string;
  metric_hint?: string;
  date?: string;
}

const DUPE_WINDOW_MS = 60 * 60 * 1000;

export async function handleLogChange(
  client: Pick<PostHogClient, 'createAnnotation' | 'listAnnotations'>,
  args: LogChangeArgs,
): Promise<string> {
  const date = args.date ? new Date(args.date).toISOString() : new Date().toISOString();

  const recent = await client.listAnnotations({ limit: 50 });
  for (const a of recent) {
    const d = decodeChange(a);
    if (d === null || isMalformed(d)) continue;
    if (
      d.summary === args.summary &&
      d.category === args.category &&
      d.surface === args.surface &&
      Math.abs(new Date(d.date).getTime() - new Date(date).getTime()) < DUPE_WINDOW_MS
    ) {
      return (
        `Already logged as annotation ${a.id} at ${d.date}. Not logging a duplicate.\n` +
        `If this is genuinely a second, separate change, give it a summary that says how it differs.`
      );
    }
  }

  const content = encodeChange({
    summary: args.summary,
    category: args.category,
    surface: args.surface,
    metricHint: args.metric_hint,
    date,
  });

  const { id } = await client.createAnnotation({ content, date_marker: date, scope: 'project' });
  counters.logged(args.category);

  const hint = args.metric_hint
    ? ''
    : '\n\nNo metric_hint was given, so check_changes will fall back to the default ladder for ' +
      'this category. Naming the funnel step this change touches improves the verdict.';

  return `Logged change ${id} at ${date}.\n${content}${hint}`;
}

export function registerLogChange(server: McpServer, client: PostHogClient): void {
  server.registerTool(
    'log_change',
    {
      title: 'Log a user-visible change',
      description:
        'Record ONE user-visible product change as a PostHog annotation so it can be graded later. ' +
        'Log only changes a user could notice: pricing, copy, onboarding, packaging, email, channel. ' +
        'Never log refactors, dependency bumps, tests, infra, CI, or internal tooling. ' +
        'One change per call — never batch. Non-code changes count and matter most: a price change ' +
        'announced in a chat session logs exactly as well as a merged PR does. ' +
        'If unsure whether something qualifies, ask the user once; never log speculatively.',
      inputSchema: logChangeShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => ({
      content: [{ type: 'text' as const, text: await handleLogChange(client, args) }],
    }),
  );
}
