import { describe, it, expect } from 'vitest';
import {
  LADDERS,
  resolveMetric,
  applyHint,
  eventsForLadder,
  mixedSource,
} from '../src/metrics.js';

const realVolumes = {
  $pageview: { pre: 11635, post: 646 },
  signup_started: { pre: 612, post: 34 },
  signup_completed: { pre: 450, post: 24 },
  trial_created: { pre: 68, post: 4 },
};

describe('metric ladder', () => {
  it('picks the closest metric that has volume in both periods', () => {
    const r = resolveMetric(LADDERS.onboarding, {
      ...realVolumes,
      onboarding_screen_viewed: { pre: 300, post: 57 },
      onboarding_screen_advanced: { pre: 140, post: 27 },
    });
    expect(r.chosen?.numerator).toBe('onboarding_screen_advanced');
    expect(r.skipped).toHaveLength(0);
  });

  it('leads the onboarding ladder with the step-through, the closest possible metric', () => {
    expect(LADDERS.onboarding[0].denominator).toBe('onboarding_screen_viewed');
  });

  it('SKIPS a metric whose events did not exist pre-period, and says why (F5: the Sept 1 case)', () => {
    const volumes = {
      ...realVolumes,
      onboarding_screen_viewed: { pre: 0, post: 57 },
      onboarding_screen_advanced: { pre: 0, post: 27 },
    };
    const r = resolveMetric(LADDERS.onboarding, volumes);
    expect(r.chosen?.numerator).toBe('signup_completed');
    expect(r.skipped[0].metric.numerator).toBe('onboarding_screen_advanced');
    expect(r.skipped[0].reason).toMatch(/no pre-period volume/i);
  });

  it('never silently reaches for the revenue metric when a closer one is usable', () => {
    expect(resolveMetric(LADDERS.onboarding, realVolumes).chosen?.numerator).not.toBe(
      'trial_created',
    );
  });

  it('falls through to the revenue metric only when the closer rungs are unusable', () => {
    const volumes = {
      signup_completed: { pre: 450, post: 24 },
      trial_created: { pre: 68, post: 4 },
    };
    expect(resolveMetric(LADDERS.onboarding, volumes).chosen?.numerator).toBe('trial_created');
  });

  it('skips a metric whose events are absent from the project entirely', () => {
    const r = resolveMetric(LADDERS.packaging, realVolumes);
    expect(r.skipped[0].reason).toMatch(/not present in this project/);
  });

  it('skips the step-through when the project never emitted those events', () => {
    const r = resolveMetric(LADDERS.onboarding, realVolumes);
    expect(r.skipped[0].reason).toMatch(/not present in this project/);
    expect(r.chosen?.numerator).toBe('signup_completed');
  });

  it('skips a metric with no post-period volume', () => {
    const volumes = { signup_started: { pre: 612, post: 0 }, signup_completed: { pre: 450, post: 0 }, $pageview: { pre: 11635, post: 646 } };
    const r = resolveMetric(LADDERS.onboarding, volumes);
    expect(r.skipped[1].reason).toMatch(/no post-period volume/);
    expect(r.chosen?.denominator).toBe('$pageview');
  });

  it('returns no metric when nothing on the ladder is usable', () => {
    expect(resolveMetric(LADDERS.pricing, {}).chosen).toBeNull();
  });
});

describe('metric_hint', () => {
  it('promotes the ladder entry touching the hinted event', () => {
    const ordered = applyHint(LADDERS.onboarding, '$pageview');
    expect(ordered[0].denominator).toBe('$pageview');
  });

  it('matches the hint against the numerator too', () => {
    expect(applyHint(LADDERS.onboarding, 'trial_created')[0].numerator).toBe('trial_created');
  });

  it('leaves the ladder untouched when the hint matches nothing', () => {
    expect(applyHint(LADDERS.onboarding, 'unrelated_event')).toEqual(LADDERS.onboarding);
  });

  it('leaves the ladder untouched when there is no hint', () => {
    expect(applyHint(LADDERS.onboarding)).toEqual(LADDERS.onboarding);
  });

  it('still refuses a hinted metric that has no pre-period volume', () => {
    const volumes = { ...realVolumes, trial_created: { pre: 0, post: 4 } };
    const r = resolveMetric(applyHint(LADDERS.onboarding, 'trial_created'), volumes);
    expect(r.chosen?.numerator).not.toBe('trial_created');
    expect(r.skipped[0].reason).toMatch(/no pre-period volume/);
  });
});

describe('eventsForLadder', () => {
  it('deduplicates events across rungs', () => {
    const events = eventsForLadder(LADDERS.onboarding);
    expect(events).toEqual([
      'onboarding_screen_advanced',
      'onboarding_screen_viewed',
      'signup_completed',
      'signup_started',
      '$pageview',
      'trial_created',
    ]);
  });
});

describe('headroom', () => {
  const saturated = {
    $pageview: { pre: 11635, post: 646 },
    signup_started: { pre: 672, post: 40 },
    signup_completed: { pre: 669, post: 36 },
    trial_created: { pre: 70, post: 7 },
  };

  it('skips a near-saturated metric — no change can move a 99.6% rate enough to measure', () => {
    const r = resolveMetric(LADDERS.onboarding, saturated);
    expect(r.chosen?.denominator).toBe('$pageview');
    expect(r.chosen?.numerator).toBe('signup_started');
    const sat = r.skipped.find((s) => s.metric.numerator === 'signup_completed');
    expect(sat?.reason).toMatch(/only 0\.4pp of headroom/);
  });

  it('skips a metric too rare to resolve at any window length', () => {
    const r = resolveMetric(
      [{ name: 'rare', numerator: 'trial_created', denominator: '$pageview' }],
      { $pageview: { pre: 1000000, post: 50000 }, trial_created: { pre: 500, post: 25 } },
    );
    expect(r.chosen).toBeNull();
    expect(r.skipped[0].reason).toMatch(/too rare to resolve/);
  });
});

describe('mixedSource', () => {
  const m = { name: 'x', numerator: 'trial_created', denominator: 'signup_completed' };

  it('flags a client denominator with a server numerator', () => {
    expect(
      mixedSource(m, {
        signup_completed: { pre: 1, post: 1, lib: 'web' },
        trial_created: { pre: 1, post: 1, lib: 'posthog-node' },
      }),
    ).toEqual({ from: 'web', to: 'posthog-node' });
  });

  it('says nothing when both legs come from the same SDK', () => {
    expect(
      mixedSource(m, {
        signup_completed: { pre: 1, post: 1, lib: 'web' },
        trial_created: { pre: 1, post: 1, lib: 'web' },
      }),
    ).toBeNull();
  });

  it('says nothing when the SDK is unknown', () => {
    expect(
      mixedSource(m, { signup_completed: { pre: 1, post: 1 }, trial_created: { pre: 1, post: 1 } }),
    ).toBeNull();
  });
});
