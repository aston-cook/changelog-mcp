/**
 * Opt-in telemetry. Off by default.
 *
 * Counts only: tools called, categories logged, verdicts returned. Never content, never
 * metric values, never keys. No hosted service is in scope for v1, so the destination is
 * user-supplied via CHANGELOG_TELEMETRY_URL; with telemetry enabled and no URL set this is
 * a documented no-op.
 */
export interface TelemetrySnapshot {
  tools: Record<string, number>;
  categories: Record<string, number>;
  verdicts: Record<string, number>;
}

const state: TelemetrySnapshot = { tools: {}, categories: {}, verdicts: {} };

function bump(bucket: Record<string, number>, key: string): void {
  bucket[key] = (bucket[key] ?? 0) + 1;
}

export function isEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CHANGELOG_TELEMETRY === '1';
}

export const counters = {
  toolCalled(name: string): void {
    bump(state.tools, name);
  },
  logged(category: string): void {
    bump(state.categories, category);
  },
  verdict(v: string): void {
    bump(state.verdicts, v);
  },
};

export function snapshot(): TelemetrySnapshot {
  return {
    tools: { ...state.tools },
    categories: { ...state.categories },
    verdicts: { ...state.verdicts },
  };
}

export function reset(): void {
  state.tools = {};
  state.categories = {};
  state.verdicts = {};
}

/**
 * Fire-and-forget. Returns what was sent (or null when disabled / unconfigured) so the
 * payload can be asserted on in tests without a network round trip.
 */
export async function flush(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<TelemetrySnapshot | null> {
  if (!isEnabled(env)) return null;
  const url = env.CHANGELOG_TELEMETRY_URL?.trim();
  const payload = snapshot();
  if (!url) return null;
  try {
    await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // Telemetry must never affect the tool's behaviour.
  }
  return payload;
}
