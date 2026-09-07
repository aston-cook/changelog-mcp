# changelog

[![CI](https://github.com/aston-cook/changelog-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/aston-cook/changelog-mcp/actions/workflows/ci.yml)

**Log what you shipped. Find out later whether it worked.**

An MCP server for solo builders who ship pricing, copy, and onboarding changes and never find
out if they helped — because nobody remembers to write down what changed, and almost nobody
has the traffic to A/B test it.

Your AI assistant already knows what changed and when, because it made the change. So logging
happens on its own, and a second tool grades it weeks later.

Two tools. No database, no hosted service, no account to create. Your PostHog key is the only
credential, and it stays on your machine.

---

## Quickstart

**1. Get a PostHog personal API key**

Go to [Settings -> Personal API keys](https://us.posthog.com/settings/user-api-keys) and create
one with these three scopes:

`annotation:read` · `annotation:write` · `query:read`

It starts with `phx_`. A `phc_` project key is a different thing and will not work.

**2. Find your project id**

It is the number in your PostHog URL:

```
https://us.posthog.com/project/12345
                               ^^^^^
```

**3. Add it to your AI tool**

<details open>
<summary><b>Claude Code</b> — create <code>.mcp.json</code> in your project root</summary>

```json
{
  "mcpServers": {
    "changelog": {
      "command": "npx",
      "args": ["-y", "changelog-mcp"],
      "env": {
        "POSTHOG_PERSONAL_API_KEY": "${POSTHOG_PERSONAL_API_KEY}",
        "POSTHOG_PROJECT_ID": "12345"
      }
    }
  }
}
```

Put the key itself in `.claude/settings.local.json`, which is gitignored:

```json
{
  "env": {
    "POSTHOG_PERSONAL_API_KEY": "phx_your_key_here"
  }
}
```

</details>

<details>
<summary><b>Claude Desktop</b> — edit <code>claude_desktop_config.json</code></summary>

```json
{
  "mcpServers": {
    "changelog": {
      "command": "npx",
      "args": ["-y", "changelog-mcp"],
      "env": {
        "POSTHOG_PERSONAL_API_KEY": "phx_your_key_here",
        "POSTHOG_PROJECT_ID": "12345"
      }
    }
  }
}
```

</details>

<details>
<summary><b>Cursor, Windsurf, other MCP clients</b></summary>

Same shape: command `npx`, args `["-y", "changelog-mcp"]`, and the two environment variables.

</details>

**4. Install the skill (Claude Code, optional but recommended)**

Copy `skills/changelog/` into your project's `.claude/skills/`. It teaches the assistant when
to log on its own — and, just as importantly, when not to.

**5. Restart, then check it connected**

Run `/mcp` in Claude Code. You should see `changelog` with two tools.

### Did it work?

Ask your assistant to run `check_changes`. The error messages say exactly what is wrong:

| What you see | What to fix |
|---|---|
| `No logged changes found` | Working. Nothing logged yet. |
| `POSTHOG_PERSONAL_API_KEY is not set` | The key is not reaching the server. Check the file you put it in. |
| `PostHog rejected the API key (401)` | Key is wrong or revoked. |
| `403 ... missing a scope` | Key works; you missed one of the three scopes. |
| `404 ... check POSTHOG_PROJECT_ID` | Wrong project number. |

---

## Everyday use

You do not call these tools by hand. You mention what you did, and it logs:

> **You:** shipped the new pricing page, Pro is $19 now
>
> **Assistant:** Logged change 431. Gradeable from 2026-09-21.

It catches things that never touch your repo, which is most of what actually moves the numbers:

> **You:** started posting to LinkedIn 3x a week
>
> **Assistant:** Logged change 432 under `channel`.

Then, weeks later:

> **You:** did the pricing change work?

```
6 changes logged. 4 graded (1 moved, 1 did not move, 2 cannot tell yet). 2 still gathering data.

[moved] Cut Pro from $29 to $19
  pricing | /pricing | 2026-07-14 | annotation 431
  metric      paywall_viewed -> checkout_started (closest to the change)
  baseline    12.40% over 90d  ->  post 15.10% over 30d  (+2.70pp, 22% relative)
  resolution  can resolve +/-1.90pp at n=2140 pre / 1180 post
  adjusted    +2.31pp after removing trend and day-of-week  (95% CI +0.44pp to +4.18pp)
  method      interrupted time series (no control series - forecast only)
  excluded    9 operator people (312 events) via $host [localhost%, %.vercel.app]
  why         2.31pp up (18.6% relative) after removing trend and day-of-week, which clears
              the 1.90pp this volume can resolve.

Still gathering data (no queries spent on these):
  2026-09-01  Asked onboarding questions first                gradeable 2026-09-15
  2026-09-05  Reworded the pricing FAQ                        gradeable 2026-09-19

Next check worth running: 2026-09-15
```

---

## What makes it different

**It refuses to answer when it cannot.** Every verdict is preceded by a minimum-detectable-
effect calculation from your real baseline and your real traffic. If a change cannot be
resolved at your volume you get `cannot tell yet` and what it would take, never a number
dressed up as a finding.

**`did not move` is never an underpowered null.** It says a change did not move only when the
window had the statistical power to see one and did not. Otherwise it says `cannot tell yet`.
This is the most important rule in the tool.

**It grades on the metric closest to the change that can actually move.** It walks a
closest-first ladder and skips rungs that cannot answer: events the change itself created, and
funnel steps already converting at 99% where no headroom exists. Reaching straight for revenue
costs roughly six times the resolution on a small account.

**It removes trend and weekly seasonality first.** A metric that was already climbing does not
get to make your change look good.

**It excludes your own traffic.** See below. This is the part most analytics gets wrong.

---

## Operator traffic

**This is the part that is easy to get backwards.**

The tool removes your own traffic at the **person** level: anyone who has ever emitted an event
from a host matching `CHANGELOG_OPERATOR_HOSTS`, or who carries an explicit flag, is dropped
from both legs of every metric.

### Why not PostHog's bot detection?

Because it would delete your revenue. Server-side events sent with `posthog-node` carry no user
agent, and PostHog classifies no-user-agent traffic as `$virt_is_bot = true`. On a typical
Next.js and Stripe setup that is every trial, every purchase, and every payment failure.

A filter of `$virt_is_bot = false` returns **zero trials, forever**. This server never uses
`$virt_is_bot`, `$virt_traffic_type`, `$virt_traffic_category`, or `$browser_type` as a filter,
and a test asserts they appear in no generated query.

### Why `$host` instead?

Because operator traffic is usually a real, headed browser on a dev or preview host, which no
bot detector flags. Measured on the project this was built against, over 90 days:

| segment | checkouts | purchases | rate |
|---|---|---|---|
| clean | 130 | 58 | **44.6%** |
| people who also emit localhost traffic | 47 | **0** | **0%** |
| blended, what the dashboard showed | 177 | 58 | **32.8%** |

That 32.8% is the number a pricing decision got made on. The real one was 44.6%.

### Closing the gap

`$host` catches any browser that has touched `localhost` or a preview URL. It misses a fresh
incognito session or a CI runner hitting production. To close that, flag yourself in your app:

```ts
posthog.init(KEY, { api_host: HOST });

if (process.env.NEXT_PUBLIC_OPERATOR === '1') {
  posthog.register({ $operator: true });        // super property on every event
  posthog.setPersonProperties({ is_operator: true });
}
```

Then run your own sessions with `NEXT_PUBLIC_OPERATOR=1`. The server picks up both with no
extra configuration.

---

## Data boundaries

Analytics accumulate hard boundaries: an identity key that changed, a webhook subscribed late,
a table migration. Reading a baseline across one gives a confident number built from data that
does not mean what the column says, which is the exact failure this tool exists to prevent
arriving through the back door.

The tool ships knowing nothing about your history. Declare your boundaries:

```
CHANGELOG_EVENT_VALID_FROM=store_purchase_completed:2026-07-05,store_checkout_started:2026-07-05
```

Rows before that date are excluded from every query, and the output names the boundary:

```
  bounded     history clipped to declared data boundaries: store_purchase_completed from 2026-07-05
```

Real example: store purchases were keyed by email rather than person id until 2026-07-05.
Counting distinct persons across that line silently undercounts every earlier purchase.

---

## Configuration

| variable | default | purpose |
|---|---|---|
| `POSTHOG_PERSONAL_API_KEY` | *required* | `phx_` personal API key |
| `POSTHOG_PROJECT_ID` | *required* | numeric project id |
| `POSTHOG_HOST` | `https://us.posthog.com` | use `https://eu.posthog.com` for EU cloud |
| `CHANGELOG_OPERATOR_HOSTS` | `localhost%,%.vercel.app` | SQL LIKE patterns; empty string disables |
| `CHANGELOG_EVENT_VALID_FROM` | unset | `event:YYYY-MM-DD` pairs marking trustworthy history |
| `CHANGELOG_TELEMETRY` | off | `1` to opt in |
| `CHANGELOG_TELEMETRY_URL` | unset | where counts go; without it telemetry is a no-op |

### `log_change`

| field | required | notes |
|---|---|---|
| `summary` | yes | one line, human readable |
| `category` | yes | `pricing` `copy` `onboarding` `packaging` `email` `channel` `other` |
| `surface` | yes | `/free`, `store checkout`, `LinkedIn` |
| `metric_hint` | no | the funnel step it touches, e.g. `signup_started` |
| `date` | no | ISO-8601, defaults to now |

Stored as a PostHog annotation: a human line PostHog shows on charts, and a machine line the
check tool reads back.

```
[chg:1] Asked onboarding questions before requiring an account
{"v":1,"category":"onboarding","surface":"/free","metric_hint":"signup_started"}
```

### `check_changes`

Grades the whole log by default, newest first. `since` and `category` narrow it; neither is
needed to reach older changes. Changes too recent to grade cost no queries at all.

---

## Method, honestly

The verdict engine is an **interrupted time series**, not CausalImpact.

```
rate_t = b0 + b1*t + sum(b_dow * D_t) + b_step * 1[t >= change]
```

Weighted least squares, weighted by each day's denominator. Nine parameters: intercept, linear
trend, six day-of-week dummies, and the step.

**Why not CausalImpact?** Its documentation requires "a set control time series that were
themselves not affected by the intervention." A solo operator changing their only funnel has
none, so the method would degenerate to a forecast from the series' own history anyway. This
model does that explicitly, with assumptions you can read.

The widely repeated "CausalImpact needs a 3:1 pre/post ratio and 30 to 50 pre-period
observations" figures do **not** appear in Google's CausalImpact documentation, the CRAN
vignette, or tfcausalimpact. They trace to third-party marketing content. Guard rails of that
shape are used here because they suit this model, not because any package requires them.

No verdict is produced below:

- **28** pre-period days with traffic
- **14** post-period days
- a **3:1** pre:post ratio

The standard error is floored at the binomial sampling error of the two periods, so the model
can never claim more precision than the raw counts support.

### What it does not do

No control series, so this is a counterfactual forecast, not causal identification. Two changes
on the same metric within 14 days refuse each other. A change that created the events measuring
it is graded on a metric further away, with the skip stated in the output.

---

## Telemetry

Off by default. Opt in with `CHANGELOG_TELEMETRY=1`.

Counts only: tools called, categories logged, verdicts returned. Never content, never metric
values, never keys. With no `CHANGELOG_TELEMETRY_URL` set it is a documented no-op. No hosted
service ships with this project.

---

## Development

```bash
npm install
npm test          # 180 tests, no network
npm run typecheck # covers src/ and test/
npm run build
```

MIT.
