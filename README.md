# changelog

An MCP server that logs user-visible product changes to PostHog, then grades them later.

Built for solo operators who ship pricing, copy, onboarding and packaging changes and never
find out whether they worked — because nobody remembers to log what changed, and almost
nobody has enough traffic to A/B test it.

The agent already knows what changed and when, because it made the change. So logging becomes
a side effect of work already happening, and a second tool asks "did it work" later.

Two tools. No database, no hosted service, no UI, no runtime LLM call. It holds no
credentials beyond your own PostHog key.

---

## What makes it different

**It refuses to answer when it cannot.** Every verdict is preceded by a minimum-detectable-
effect calculation from your real baseline and your real traffic. If the change cannot be
resolved at your volume, the answer is `cannot tell yet` plus what it would take — never a
number dressed up as a finding.

**`did not move` is never returned for an underpowered null.** The tool says a change did not
move only when the window had the statistical power to see a change worth acting on and
didn't. Otherwise it says `cannot tell yet`. This is the single most important rule in it.

**It grades on the metric closest to the change that can actually move.** It walks a
closest-first ladder and skips rungs that cannot answer — events the change itself created,
and funnel steps already converting at 99% where no headroom exists. Reaching straight for
the revenue metric costs roughly six times the resolution on a small account.

**It removes trend and weekly seasonality before attributing anything.** A metric that was
already climbing does not get to make your change look good.

**It excludes your own traffic.** See below — this is the part most analytics gets wrong.

---

## Setup

### 1. Create a PostHog personal API key

At **Settings → Personal API keys** (`https://us.posthog.com/settings/user-api-keys`), create
a key with these scopes:

| scope | needed by |
|---|---|
| `annotation:read` | both tools |
| `annotation:write` | `log_change` |
| `query:read` | `check_changes` |

Personal API keys start with `phx_`. Project keys (`phc_`) and project secret keys (`phs_`)
will not work.

### 2. Find your project id

It is the number in your project URL: `https://us.posthog.com/project/435332` → `435332`.

Without it, the PostHog API falls back to "the last project you visited in the UI", which is
not deterministic. The server refuses to start rather than guess.

### 3. Add it to your MCP client

**Claude Code** — `.mcp.json` in your project, or `claude mcp add`:

```json
{
  "mcpServers": {
    "changelog": {
      "command": "npx",
      "args": ["-y", "changelog-mcp"],
      "env": {
        "POSTHOG_PERSONAL_API_KEY": "phx_...",
        "POSTHOG_PROJECT_ID": "435332"
      }
    }
  }
}
```

**Claude Desktop** — the same block in `claude_desktop_config.json`.

### 4. Install the skill

Copy `skills/changelog/` into your `.claude/skills/` directory. It tells the agent when to
call `log_change` — and, more importantly, when not to.

### Environment

| variable | default | purpose |
|---|---|---|
| `POSTHOG_PERSONAL_API_KEY` | *required* | `phx_` personal API key |
| `POSTHOG_PROJECT_ID` | *required* | numeric project id |
| `POSTHOG_HOST` | `https://us.posthog.com` | use `https://eu.posthog.com` for EU cloud |
| `CHANGELOG_OPERATOR_HOSTS` | `localhost%,%.vercel.app` | comma-separated SQL LIKE patterns; set to empty to disable |
| `CHANGELOG_EVENT_VALID_FROM` | unset | `event:YYYY-MM-DD` pairs marking where each event's data becomes trustworthy |
| `CHANGELOG_TELEMETRY` | unset (off) | `1` to opt in |
| `CHANGELOG_TELEMETRY_URL` | unset | where counts go; without it telemetry is a no-op |

---

## Tools

### `log_change`

Records one user-visible change as a PostHog annotation.

| field | required | notes |
|---|---|---|
| `summary` | yes | one line, human readable |
| `category` | yes | `pricing` `copy` `onboarding` `packaging` `email` `channel` `other` |
| `surface` | yes | where it went live: `/free`, `store checkout`, `LinkedIn` |
| `metric_hint` | no | the funnel step it touches, e.g. `signup_started` |
| `date` | no | ISO-8601, defaults to now |

The annotation content is two lines — a human summary PostHog shows on charts, and a JSON
record the check tool reads back:

```
[chg:1] Asked onboarding questions before requiring an account
{"v":1,"category":"onboarding","surface":"/free","metric_hint":"signup_started"}
```

### `check_changes`

Returns exactly one of three verdicts per change.

| verdict | means |
|---|---|
| `moved` | the effect clears what your volume can resolve, and the interval excludes zero |
| `did not move` | the window could have seen a meaningful change and did not |
| `cannot tell yet` | not enough data, or two changes overlap on the same metric |

```
[cannot tell yet] Asked onboarding questions first and saved progress before requiring an account
  onboarding | /free | 2026-09-01 | annotation 431434
  metric      $pageview -> signup_started (closest available)
  skipped     onboarding_screen_viewed -> onboarding_screen_advanced: no pre-period volume — the
              change appears to have created these events, so there is nothing to compare against
  skipped     signup_started -> signup_completed: baseline is already 99.6% — only 0.4pp of
              headroom exists, so no change can move it by enough to measure
  baseline    4.78% over 102d  ->  post 4.85% over 6d  (+0.07pp, 1% relative)
  resolution  can resolve +/-2.14pp at n=15347 pre / 824 post
  adjusted    +0.35pp after removing trend and day-of-week  (95% CI -2.24pp to +2.95pp)
  method      interrupted time series (no control series - forecast only)
  excluded    25 operator people (4776 events) via $host [localhost%, %.vercel.app]
  why         only 6 days since the change; the model needs at least 14 post-period days
              before a verdict means anything.
```

That is real output against a real project. Both skip lines matter: the first is a change
that created the very events that would measure it, the second is a funnel step already
converting at 99.6% where no change has room to move. Neither is something a dashboard
would have told you.

---

## Operator traffic

**This is the part that matters most, and the part that is easy to get backwards.**

The tool excludes your own traffic at the **person** level: any person who has ever emitted
an event from a host matching `CHANGELOG_OPERATOR_HOSTS`, or who carries the explicit flag,
is removed from both legs of every metric.

### Why not PostHog's bot detection?

Because it would delete your revenue. Server-side events sent with `posthog-node` carry no
user agent, and PostHog classifies no-user-agent traffic as `$virt_traffic_type = 'Automation'`,
`$virt_is_bot = true`. On a typical Next.js + Stripe setup that is every trial, every
purchase, and every payment failure.

A filter of `$virt_is_bot = false` returns **zero trials, forever**. This server never uses
`$virt_is_bot`, `$virt_traffic_type`, `$virt_traffic_category`, or `$browser_type` as a
filter, and a test asserts they appear in no generated query.

### Why `$host` instead?

Because operator traffic is usually a real, headed browser on a dev or preview host, which no
bot detector flags. Measured on the project this was built against, over 90 days:

| segment | checkouts | purchases | rate |
|---|---|---|---|
| clean | 130 | 58 | **44.6%** |
| people who also emit localhost traffic | 47 | **0** | **0%** |
| blended — what the analytics showed | 177 | 58 | **32.8%** |

That 32.8% is the number a pricing decision got made on. The clean number was 44.6%.

### Closing the gap

`$host` person-tainting catches any browser that has touched `localhost` or a preview URL. It
misses a fresh incognito session or a CI runner hitting production directly. To close that,
set an explicit flag in your app:

```ts
posthog.init(KEY, { api_host: HOST });

if (process.env.NEXT_PUBLIC_OPERATOR === '1') {
  posthog.register({ $operator: true });        // super property on every event
  posthog.setPersonProperties({ is_operator: true });
}
```

Then run your own sessions and automation with `NEXT_PUBLIC_OPERATOR=1`. The server picks up
both `$operator` on events and `is_operator` on persons with no extra configuration.

---

## Data boundaries

Analytics accumulate hard boundaries: an identity key that changed, a webhook subscribed
late, a table migration. Reading a baseline across one produces a confident number built
from data that does not mean what the column name says it means — the exact failure this
tool exists to prevent, arriving through the back door.

The tool ships with no knowledge of your history. Declare your boundaries:

```
CHANGELOG_EVENT_VALID_FROM=store_purchase_completed:2026-07-05,store_checkout_started:2026-07-05
```

Rows for those events before that date are excluded from every query — the series, the
volumes check, and the usability decision. If that leaves too little clean history, the
guard rails refuse a verdict rather than grade on the remainder, and the output names the
boundary that clipped the window:

```
  bounded     history clipped to declared data boundaries: store_purchase_completed from 2026-07-05
```

A real example from the project this was built against: store purchases were keyed by email
rather than by person id until 2026-07-05. Counting distinct persons across that line
silently undercounts every purchase before it.

## Capture sources

`check_changes` samples `$lib` per event and warns when a metric's two legs were captured by
different SDKs:

```
  mixed       legs captured by different SDKs (web -> posthog-node); the ratio is
              comparable over time but the absolute rate is not a true rate
```

Ad blockers suppress client-side events and not server-side ones, so a client denominator
with a server numerator inflates the rate. For a before/after comparison this largely
cancels while the ad-block rate holds steady, which is why it is reported rather than
refused — but do not read the absolute baseline as the true rate.

---

## Method, honestly

The verdict engine is an **interrupted time series**, not CausalImpact.

```
rate_t = b0 + b1*t + sum(b_dow * D_t) + b_step * 1[t >= change]
```

Fit by weighted least squares, weighted by each day's denominator. Nine parameters:
intercept, linear trend, six day-of-week dummies, and the step.

**Why not CausalImpact?** Its documentation requires "a set control time series that were
themselves not affected by the intervention." A solo operator changing their only funnel has
none, so the method would degenerate to a forecast from the series' own history anyway. This
model does that explicitly, with assumptions you can read.

The widely repeated "CausalImpact needs a 3:1 pre/post ratio and 30–50 pre-period
observations" figures do **not** appear in Google's CausalImpact documentation, in the CRAN
vignette, or in tfcausalimpact. They trace to third-party marketing content. Guard rails of
that shape are used here because they are sensible for this model — day-of-week seasonality
costs six parameters and cannot be identified from less than four full weeks — not because
any package documentation requires them.

Guard rails, below which no verdict is produced:

- at least **28** pre-period days with traffic
- at least **14** post-period days
- at least a **3:1** pre:post ratio

The model's standard error is floored at the binomial sampling error of the two periods, so
it can never claim more precision than the raw counts support.

### What it does not do

No control series, so this is a counterfactual forecast rather than causal identification.
Two changes on the same metric within 14 days refuse each other. A change that created the
events measuring it has no pre-period and is graded on a metric further away, with the skip
stated in the output.

---

## Telemetry

Off by default. Opt in with `CHANGELOG_TELEMETRY=1`.

Counts only: tools called, categories logged, verdicts returned. Never content, never metric
values, never keys. With telemetry enabled and no `CHANGELOG_TELEMETRY_URL` set it is a
documented no-op — no hosted service ships with this project.

---

## Development

```bash
npm install
npm test          # 177 tests, no network
npm run typecheck
npm run build
```

MIT.
