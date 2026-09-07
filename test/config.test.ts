import { describe, it, expect } from 'vitest';
import { redact, loadConfig } from '../src/config.js';

describe('redact', () => {
  it('removes the api key from arbitrary text', () => {
    const key = 'phx_abc123SECRETvalue';
    const msg = `request failed: Authorization: Bearer ${key} (401)`;
    expect(redact(msg, key)).toBe(
      'request failed: Authorization: Bearer phx_***REDACTED*** (401)',
    );
    expect(redact(msg, key)).not.toContain('SECRET');
  });

  it('redacts any phx_ token even when it is not the configured key', () => {
    const out = redact('leaked phx_someOtherKey here', 'phx_configured');
    expect(out).not.toContain('someOtherKey');
    expect(out).toContain('REDACTED');
  });

  it('leaves text without a key untouched', () => {
    expect(redact('nothing to see', 'phx_x')).toBe('nothing to see');
  });
});

describe('loadConfig', () => {
  const good = { POSTHOG_PERSONAL_API_KEY: 'phx_key', POSTHOG_PROJECT_ID: '435332' };

  it('reads key, project and default host', () => {
    const cfg = loadConfig(good as NodeJS.ProcessEnv);
    expect(cfg.apiKey).toBe('phx_key');
    expect(cfg.projectId).toBe('435332');
    expect(cfg.host).toBe('https://us.posthog.com');
  });

  it('defaults operator host patterns to localhost and vercel previews', () => {
    expect(loadConfig(good as NodeJS.ProcessEnv).operatorHostPatterns).toEqual([
      'localhost%',
      '%.vercel.app',
    ]);
  });

  it('strips a trailing slash from a custom host', () => {
    const cfg = loadConfig({ ...good, POSTHOG_HOST: 'https://eu.posthog.com/' } as NodeJS.ProcessEnv);
    expect(cfg.host).toBe('https://eu.posthog.com');
  });

  it('rejects a project API key with an actionable message', () => {
    expect(() =>
      loadConfig({ ...good, POSTHOG_PERSONAL_API_KEY: 'phc_projectkey' } as NodeJS.ProcessEnv),
    ).toThrow(/phx_ prefix/);
  });

  it('refuses to run without a project id rather than guessing one', () => {
    expect(() => loadConfig({ POSTHOG_PERSONAL_API_KEY: 'phx_key' } as NodeJS.ProcessEnv)).toThrow(
      /POSTHOG_PROJECT_ID is not set/,
    );
  });
});
