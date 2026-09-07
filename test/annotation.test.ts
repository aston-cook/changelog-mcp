import { describe, it, expect } from 'vitest';
import { encodeChange, decodeChange, isMalformed, CHANGE_PREFIX } from '../src/annotation.js';
import type { Annotation } from '../src/posthog.js';

const base = {
  summary: 'Asked questions first, saved progress before account',
  category: 'onboarding' as const,
  surface: '/free',
  metricHint: 'signup_started',
  date: '2026-09-01T00:00:00Z',
};

const ann = (id: number, content: string): Annotation => ({
  id,
  content,
  date_marker: base.date,
  scope: 'project',
  created_at: base.date,
});

describe('annotation encoding', () => {
  it('round-trips', () => {
    const out = decodeChange(ann(7, encodeChange(base)));
    expect(out).toMatchObject({
      summary: base.summary,
      category: 'onboarding',
      surface: '/free',
      metricHint: 'signup_started',
      annotationId: 7,
    });
  });

  it('puts the human summary on line one so PostHog charts read well', () => {
    expect(encodeChange(base).split('\n')[0]).toBe(CHANGE_PREFIX + base.summary);
  });

  it('survives characters that would break a delimiter format', () => {
    const tricky = {
      ...base,
      surface: 'store | checkout = "A|B"',
      summary: 'Cut price 20% | ref: a=b',
    };
    const out = decodeChange(ann(1, encodeChange(tricky)));
    expect(out).toMatchObject({ surface: tricky.surface, summary: tricky.summary });
  });

  it('flattens a multi-line summary so line two stays the metadata line', () => {
    const out = decodeChange(ann(1, encodeChange({ ...base, summary: 'line one\n  line two' })));
    expect(out).toMatchObject({ summary: 'line one line two' });
  });

  it('omits metric_hint from the record when it was not given', () => {
    const { metricHint: _drop, ...noHint } = base;
    const content = encodeChange(noHint);
    expect(content).not.toContain('metric_hint');
    const out = decodeChange(ann(1, content));
    expect(out).toMatchObject({ metricHint: undefined });
  });

  it('returns null for annotations that are not ours', () => {
    expect(decodeChange(ann(2, 'deployed v1.2.3'))).toBeNull();
  });

  it('reports malformed records instead of throwing or silently dropping', () => {
    const out = decodeChange(ann(3, CHANGE_PREFIX + 'x\n{not json'));
    expect(isMalformed(out)).toBe(true);
    expect(out).toMatchObject({ malformed: true, annotationId: 3 });
  });

  it('reports a record with no metadata line as malformed', () => {
    expect(decodeChange(ann(4, CHANGE_PREFIX + 'only a summary'))).toMatchObject({
      malformed: true,
      reason: /missing metadata/,
    });
  });

  it('reports an unknown category as malformed rather than trusting it', () => {
    const out = decodeChange(ann(5, `${CHANGE_PREFIX}x\n{"v":1,"category":"refactor","surface":"/"}`));
    expect(out).toMatchObject({ malformed: true, reason: /unknown category refactor/ });
  });

  it('falls back to created_at when the annotation has no date_marker', () => {
    const out = decodeChange({
      id: 6,
      content: encodeChange(base),
      date_marker: null,
      scope: 'project',
      created_at: '2026-08-15T09:00:00Z',
    });
    expect(out).toMatchObject({ date: '2026-08-15T09:00:00Z' });
  });

  it('rejects content over the PostHog 8192 limit', () => {
    expect(() => encodeChange({ ...base, summary: 'x'.repeat(9000) })).toThrow(/8192/);
  });
});
