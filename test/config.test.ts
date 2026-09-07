import { describe, it, expect } from 'vitest';
import { redact, loadConfig, parseEventValidFrom } from '../src/config.js';

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

describe('parseEventValidFrom', () => {
  it('parses comma-separated event:date pairs', () => {
    expect(
      parseEventValidFrom('store_purchase_completed:2026-07-05,store_checkout_started:2026-07-05'),
    ).toEqual({
      store_purchase_completed: '2026-07-05',
      store_checkout_started: '2026-07-05',
    });
  });

  it('returns empty for unset or blank', () => {
    expect(parseEventValidFrom(undefined)).toEqual({});
    expect(parseEventValidFrom('   ')).toEqual({});
  });

  it('tolerates whitespace around entries', () => {
    expect(parseEventValidFrom(' a:2026-01-01 , b:2026-02-02 ')).toEqual({
      a: '2026-01-01',
      b: '2026-02-02',
    });
  });

  it('refuses a malformed entry rather than silently ignoring a data boundary', () => {
    expect(() => parseEventValidFrom('store_purchase_completed')).toThrow(/malformed/);
    expect(() => parseEventValidFrom('evt:07-05-2026')).toThrow(/YYYY-MM-DD/);
  });
});

describe('operator host patterns', () => {
  const base = { POSTHOG_PERSONAL_API_KEY: 'phx_key', POSTHOG_PROJECT_ID: '1' };

  it('treats an explicitly empty value as "no host patterns", not as unset', () => {
    const cfg = loadConfig({ ...base, CHANGELOG_OPERATOR_HOSTS: '' } as NodeJS.ProcessEnv);
    expect(cfg.operatorHostPatterns).toEqual([]);
  });

  it('accepts custom patterns', () => {
    const cfg = loadConfig({
      ...base,
      CHANGELOG_OPERATOR_HOSTS: 'localhost%,staging.example.com',
    } as NodeJS.ProcessEnv);
    expect(cfg.operatorHostPatterns).toEqual(['localhost%', 'staging.example.com']);
  });

  it('reads data boundaries from the environment', () => {
    const cfg = loadConfig({
      ...base,
      CHANGELOG_EVENT_VALID_FROM: 'store_purchase_completed:2026-07-05',
    } as NodeJS.ProcessEnv);
    expect(cfg.eventValidFrom).toEqual({ store_purchase_completed: '2026-07-05' });
  });
});
