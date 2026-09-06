# changelog — Specification

**Status:** Phase 0 complete, verified against primary sources and against the AssertHired
PostHog project (id 435332) on 2026-09-06.

## Problem

Solo builders ship user-visible changes — pricing, copy, onboarding, packaging — and never
find out whether they worked. Two reasons:

1. Nobody remembers to log what changed and when.
2. At solo-operator traffic, A/B testing is not available, so the counterfactual is missing.

The agent that made the change already knows what changed and when. Logging becomes a side
effect of work already happening. A second tool asks "did it work" later.

## Non-goals (v1)

GA4. Any hosted service. Any UI. Any storage the tool controls. Any runtime LLM call.

The tool holds no database and no credentials beyond the user's own PostHog key.

---

## Phase 0 findings that constrain the design

These are verified facts, not assumptions. Each one changed a design decision.

### F1. MCP has no server-to-server composition

The protocol is strictly client↔server. A server *can* act as a client to another server,
but that is ordinary application code, not a protocol feature, and would require its own
transport plus OAuth to `mcp.posthog.com` — on top of the same PostHog credential.

Additionally, `PostHog/mcp` is archived and moved into the PostHog monorepo, and its tool
surface has consolidated behind a single `exec` dispatcher: annotation tools are reachable
only as CLI strings (`exec({command: "call annotation-create {...}"})`).

**Decision:** write annotations directly against the PostHog REST API. No MCP dependency.
The two servers coexist without conflict — both write to the same annotation store.

### F2. Server-side events are classified as bot traffic

In the AssertHired project, these events are sent from `posthog-node` with no user agent:

    trial_created, trial_converted, payment_failed,
    subscription_renewed, store_purchase_completed

PostHog classifies no-user-agent traffic as `$virt_traffic_type = 'Automation'`,
`$virt_traffic_category = 'no_user_agent'`, `$virt_is_bot = true`. Over 90 days that is
3,039 events across **802 real people**.

**A filter of `$virt_is_bot = false` returns zero trials, forever**, and would silently
report "did not move" on every pricing and packaging change.

**Decision:** operator exclusion is **person-level**, derived from client-side signals, and
applied to all of that person's events including server-side ones. `$virt_is_bot`,
`$virt_traffic_type`, and `$virt_traffic_category` are **never** used as filters.

### F3. `navigator.webdriver` is not readable from PostHog

posthog-js blocks capture client-side when `navigator.webdriver` is true or the user agent
contains `HeadlessChrome`. Blocked events are never sent, so they cannot be filtered on
afterwards. Confirmed: `Automation/headless_browser` is 8 events / 5 people over 90 days.

`$browser_type` (values `bot` / `browser`) exists only if the app sets
`opt_out_useragent_filter: true` in posthog-js. AssertHired does not.

**Decision:** do not depend on webdriver or `$browser_type`. Use `$host` plus an explicit
opt-in flag.

### F4. Operator contamination is real, live, and caught by `$host`

Last 90 days, `store_checkout_started` → `store_purchase_completed`:

| segment                                   | checkouts | purchases | rate      |
|-------------------------------------------|-----------|-----------|-----------|
| clean                                     | 130       | 58        | **44.6%** |
| people who also emit localhost traffic    | 47        | **0**     | **0%**    |
| blended (what the analytics currently show)| 177      | 58        | **32.8%** |

Same shape as the "40 checkouts, zero payments" incident that drove a price cut. None of the
47 are flagged as bots — they are real headed browsers on `localhost:3000`–`localhost:4013`
and `asserthired.vercel.app`.

**Decision:** the operator signal is `$host`, propagated to the person. Works retroactively
on existing data with zero instrumentation. An explicit flag closes the remaining gap
(fresh incognito session or CI runner against production) and is documented in the README
as an optional 5-line change to the host app.

### F5. A change can create the events that would measure it

`onboarding_screen_viewed` and `onboarding_screen_advanced` have **zero events in every week
before 2026-08-31**. The Sept 1 onboarding change created them. There is no pre-period for
the metric closest to the change.

**Decision:** the metric ladder must verify that a candidate metric has non-zero volume in
**both** the pre- and post-period before selecting it, and must state in the output when it
skipped a closer metric and why.

### F6. CausalImpact's stated requirements are not what was assumed

Google's official CausalImpact vignette (google.github.io and CRAN) and the tfcausalimpact
README state **no** numeric minimum for pre-period observations and **no** 3:1 pre/post
ratio. Those figures come from third-party marketing content, not package documentation.

What the documentation does require: "a set control time series that were *themselves not
affected by the intervention*." A solo operator changing their only funnel has no control
series. Without controls the method degenerates to a Bayesian structural time series
forecast from the metric's own history.

**Decision:** implement an explicit interrupted time series (ITS) model — linear trend plus
day-of-week seasonality plus a step term, fit by weighted least squares. Label it honestly
in output as `interrupted time series (no control series — forecast only)`. Never call it
causal impact. Keep the volume guard rails as engineering judgment, documented as such
rather than cited as doctrine.

### F7. Measured baseline, and the resulting resolution limits

Last 90 days ending 2026-09-06, AssertHired:

| measure                        | value          |
|--------------------------------|----------------|
| unique visitors (`$pageview`)  | 11,635 (129/d) |
| `signup_started`               | 612 people     |
| `signup_completed`             | 610 people     |
| `trial_created`                | 68 people      |
| signup → trial                 | **11.1%**      |
| visitors → signup_started      | **5.26%**      |

Minimum detectable effect, α=0.05 two-sided, 80% power:

| metric                      | baseline | 5d post   | 30d post  | 60d post  |
|-----------------------------|----------|-----------|-----------|-----------|
| signup → trial              | 11.1%    | ±15.5pp   | —         | —         |
| visitors → signup_started   | 5.26%    | ±2.53pp   | ±1.16pp   | ±0.92pp   |

On signup → trial, a 90-day pre-period caps resolution at **±3.6pp even with an infinite
post-period**. Metric choice is worth roughly **6x** in resolution.

Note: the operator's recalled figures (426 signups / 34 trials / 8.0%) do not match PostHog
(610 / 68 / 11.1%). The tool computes the baseline from PostHog at check time rather than
accepting a supplied number.

---

## Tools

### `log_change`

| field         | type                | required | notes                                        |
|---------------|---------------------|----------|----------------------------------------------|
| `summary`     | string              | yes      | one line, human readable                     |
| `category`    | enum                | yes      | pricing, copy, onboarding, packaging, email, channel, other |
| `surface`     | string              | yes      | where it went live: `/free`, `store checkout`, `LinkedIn` |
| `metric_hint` | string              | no       | funnel step the change most directly touches |
| `date`        | ISO-8601            | no       | defaults to now                              |

Writes one PostHog annotation. Returns the annotation id and the encoded content.

### `check_changes`

Returns a verdict per logged change. Exactly one of: `moved`, `did not move`,
`cannot tell yet`. No dashboards, no engagement metrics, no green arrows.

---

## Annotation encoding

Two lines. Line 1 is human-readable and is what PostHog surfaces on a chart. Line 2 is a
machine record.

```
[chg:1] Asked onboarding questions first, saved progress before requiring an account
{"v":1,"category":"onboarding","surface":"/free","metric_hint":"signup_started"}
```

- Prefix `[chg:1]` is the version marker and the scan filter.
- Line 2 must parse as JSON. A malformed record is reported as malformed and skipped, never
  crashed on and never silently dropped.
- `content` max length is 8192 characters (verified in the PostHog annotation schema).
- Written with `scope: "project"`. `hidden_in_user_interface` is set when available so a
  high-frequency log does not crowd the charts — to be confirmed against the REST API in
  Task 2, since it is currently verified only in PostHog's MCP layer.

## Auth

`POSTHOG_PERSONAL_API_KEY` (prefix `phx_`, verified) passed as
`Authorization: Bearer $POSTHOG_PERSONAL_API_KEY`. Read from env. Never logged, never echoed
in tool output, redacted from all error paths.

`POSTHOG_PROJECT_ID` required — the API otherwise defaults to "the last project you visited
in the UI", which is not deterministic.

`POSTHOG_HOST` defaults to `https://us.posthog.com`.

Rate limits (verified): CRUD 480/min and 4800/hour; query endpoint 2400/hour. Limits apply
across the whole organization, not per key.

## Verdict gating

`did not move` is returned **only** when the study had the power to see a meaningful change
and did not. An underpowered null result is `cannot tell yet`. This is the single most
important rule in the tool.

ITS guard rails (engineering judgment, not doctrine — F6):

- ≥ 28 pre-period days with non-zero denominator (four full weeks; day-of-week seasonality
  costs 6 parameters and cannot be identified below this)
- ≥ 14 post-period days
- ≥ 3:1 pre:post day ratio

Below any of these, the ITS model is not fit and the verdict is `cannot tell yet` with the
specific shortfall named.

## Overlap

Two logged changes overlap when their evaluation windows intersect **and** they resolve to
the same metric. Both are refused with `cannot tell yet` and the reason names the other
change.

## Telemetry (Phase 4)

Off by default. Explicit opt-in via `CHANGELOG_TELEMETRY=1`. Counts only: tools called,
categories logged, verdicts returned. Never content, never metrics, never keys.

Since no hosted service is in scope, the destination is user-supplied via
`CHANGELOG_TELEMETRY_URL`. With telemetry enabled and no URL set, it is a documented no-op.

---

## F8. A metric can be too saturated to grade (found during the live run)

`signup_started` -> `signup_completed` runs at **99.6%** in the reference project. Only 0.4pp
of headroom exists, so no change can move it by enough to measure — the minimum detectable
effect (±10.3pp over the test window) exceeded the range the metric can physically occupy.

The volume checks in F5 do not catch this: the events are present and have volume on both
sides. It is the *rate* that makes the metric useless.

**Decision:** `resolveMetric` skips any rung whose pre-period rate is above
`SATURATION_MAX = 0.90` or below `NEAR_ZERO_MIN = 0.002`, and states the headroom in the
skip reason. Discovered only by running against real data; no synthetic fixture would have
produced a 99.6% funnel step.

---

## Live run — 2026-09-06

Change logged to the real project as annotation **431434**:

```
[chg:1] Asked onboarding questions first and saved progress before requiring an account
{"v":1,"category":"onboarding","surface":"/free","metric_hint":"signup_started"}
```

`hidden_in_user_interface` is confirmed present on the REST annotation model (returned as
`null`), resolving the open question from Task 2.

Verdict, with the ladder running unhinted so both skips are visible:

```
1 logged change(s): 1 cannot tell yet

[cannot tell yet] Asked onboarding questions first and saved progress before requiring an account
  onboarding | /free | 2026-09-01 | annotation 431434
  metric      $pageview -> signup_started (closest available)
  skipped     onboarding_screen_viewed -> onboarding_screen_advanced: no pre-period volume — the change
              appears to have created these events, so there is nothing to compare against
  skipped     signup_started -> signup_completed: baseline is already 99.6% — only 0.4pp of headroom
              exists, so no change can move it by enough to measure
  baseline    4.78% over 102d  ->  post 4.85% over 6d  (+0.07pp, 1% relative)
  resolution  can resolve +/-2.14pp at n=15347 pre / 824 post
  adjusted    +0.35pp after removing trend and day-of-week  (95% CI -2.24pp to +2.95pp)
  method      interrupted time series (no control series - forecast only)
  excluded    25 operator people (4776 events) via $host [localhost%, %.vercel.app] and the explicit flag
  why         only 6 days since the change; the model needs at least 14 post-period days before a
              verdict means anything.
```

**This matches the Phase 0 prediction.** Predicted: skip the closest metric for want of a
pre-period, grade on visitors -> `signup_started`, roughly ±2.5pp against a ~5.3% baseline,
verdict `cannot tell yet`. Actual: ±2.14pp against 4.78%, `cannot tell yet`. The baseline is
slightly lower and the interval slightly tighter than predicted because operator exclusion
removed 25 people and 4,776 events, and the window is a year rather than 90 days.

The change is genuinely ungradeable today. Re-run after 2026-09-15 for the 14-day minimum;
roughly 30 post-period days gets the resolution to about ±1.2pp.
