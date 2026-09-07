# Changelog

## 0.1.1 — 2026-09-07

### Fixed

- **Windows setup instructions were wrong.** The quickstart told every Windows user to
  configure `"command": "npx"`, which MCP clients cannot spawn: `npx` is a `.cmd` shim, and
  Node refuses to spawn it with `shell: false` under the CVE-2024-27980 mitigation. Bare
  `npx` gives `ENOENT`, `npx.cmd` gives `EINVAL`; only `cmd /c npx` works. The README now
  documents the `cmd /c` form.

Docs only. No behaviour change from 0.1.0.

## 0.1.0 — 2026-09-07

First release.

### `log_change`

Records one user-visible change as a PostHog annotation with a parseable `[chg:1]` record.
Categories: pricing, copy, onboarding, packaging, email, channel, other. Returns the date the
change becomes gradeable. Refuses near-duplicates logged within the hour.

### `check_changes`

Returns exactly one of `moved`, `did not move`, or `cannot tell yet` per logged change.

- Computes the minimum detectable effect from the project's real baseline **before** reporting
  anything. `did not move` is returned only when the window had the power to detect a
  meaningful change; an underpowered null is `cannot tell yet`.
- Walks a closest-first metric ladder and skips rungs that cannot answer: events the change
  itself created, and funnel steps already saturated above 90% where no headroom exists.
- Excludes operator traffic at the **person** level via `$host` and an optional explicit flag.
  Never filters on `$virt_is_bot`, `$virt_traffic_type`, `$virt_traffic_category`, or
  `$browser_type` — on a typical Next.js and Stripe setup those mark every server-side trial
  and purchase as automation, and filtering on them returns zero revenue events forever.
- Fits an interrupted time series (linear trend, six day-of-week dummies, a step term, by
  weighted least squares) so trend and weekly seasonality are not credited to the change.
  The standard error is floored at the binomial sampling error of the two periods, so the
  model can never claim more precision than the raw counts support.
- Refuses to grade two changes that overlap within 14 days on the same metric, and truncates
  a change's post-period at the next change on the same metric.
- Honours per-event data boundaries via `CHANGELOG_EVENT_VALID_FROM`, so a baseline is never
  read across a point where an event's meaning changed.
- Changes too recent to grade cost no queries at all; identical queries are memoized per run.

### Notes

This is not CausalImpact and does not claim to be. CausalImpact requires control series
unaffected by the intervention, which a solo operator changing their only funnel does not
have. Guard rails (28 pre-period days, 14 post-period days, a 3:1 ratio) are engineering
judgment for this model, not a requirement of any published package.

Telemetry is off by default, opt-in, counts only, and a documented no-op without a
user-supplied destination.
