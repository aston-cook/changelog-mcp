---
name: changelog
description: Use whenever a user-visible change ships or is mentioned — pricing, copy, onboarding, packaging, email, or channel — to record it with log_change. Also use when asked whether a change worked, when reviewing what shipped recently, at the end of a session where something user-facing changed, or when the user asks about conversion, signups, trials, or "did that help".
---

# Logging changes

You already know what changed and when, because you made the change or the user just told you.
Logging is a side effect of work you were doing anyway.

**Call `log_change` without being asked.** Do not wait for the user to request a log entry —
they will not remember, which is the entire reason this tool exists. When something
user-visible ships, log it and mention that you did in one short line. Do not make it a
conversation.

**Being aggressive about what does NOT get logged is the other half of the design.** Forty
useless entries a week and the log is dead: nobody reads it, and `check_changes` spends its
statistical budget grading noise. Six real entries beat sixty.

## Log this, on your own initiative

Anything a user could notice. If a customer could see it, feel it, or be charged differently
because of it, log it.

| Change | category | surface |
|---|---|---|
| Cut Pro from $29 to $19 | `pricing` | `/pricing` |
| Rewrote the landing page headline | `copy` | `/` |
| Asked onboarding questions before requiring an account | `onboarding` | `/free` |
| Split the Team plan out of Pro | `packaging` | `/pricing` |
| Added a day-3 nudge to the welcome sequence | `email` | `welcome email` |
| Started posting to LinkedIn three times a week | `channel` | `LinkedIn` |
| Moved the signup button above the fold | `copy` | `/` |
| Made the free tier require a card | `pricing` | `store checkout` |

## Never log this

| Change | why not |
|---|---|
| Refactored the auth module | no user-visible effect |
| Bumped Next.js to 15.2 | dependency, not a product change |
| Added tests for the checkout flow | internal |
| Fixed a flaky CI job | infra |
| Renamed a database column | internal |
| Reformatted with Prettier | cosmetic, not user-facing |
| Added logging around the webhook handler | internal tooling |
| Upgraded the Vercel plan | infra |

A performance fix is a judgment call. Log it only if a user would notice: "checkout went from
4s to 800ms" is user-visible; "reduced a query from 40ms to 12ms" is not.

## When to reach for each tool

**`log_change` — proactively, the moment something ships.** Triggers include: a deploy of
user-facing code, the user saying they changed a price, a new posting cadence, an email
sequence edit, a copy rewrite, a merged PR touching product surface, or the end of a session
where any of that happened.

**`check_changes` — when the user asks about outcomes, and periodically on your own.**
Triggers include: "did that work", "how's conversion", "why are signups down", "what shipped
last month", or the start of a session where the user is deciding what to build next. It
grades the whole log by default, newest first — **you do not need to pass `since` to reach
older changes**, and you should not guess at a window.

## Rules

**Non-code changes count, and matter most.** "Prices came down today" typed in a chat session
must log exactly as well as a merged PR does. Most of what moves a solo operator's numbers
never touches the repo: a price announced in a DM, a new posting cadence, a changed subject
line. If the user tells you they changed something user-visible, log it — do not wait for a
commit.

**One change per entry. Never batch.** Two prices in one deploy are two entries. A rewritten
headline and a reordered onboarding flow are two entries. `check_changes` pairs each entry
with a metric; a batched entry cannot be attributed to anything.

**If unsure, ask once. Never log speculatively.** One question — "did that pricing change go
live, or are you still deciding?" — then act on the answer. A speculative entry poisons the
baseline for every real change near it.

**Set `metric_hint` when you know the funnel step.** Naming the event the change touches
(`signup_started`, `checkout_started`, `paywall_viewed`) lets `check_changes` grade on the
metric closest to the change instead of falling back to revenue. On a small account that is
worth roughly six times the resolution — often the difference between a verdict and "still
gathering data".

**Set `date` when the change shipped earlier.** Backfilling last month's price change is
useful. Guessing at its date is not — ask if you do not know.

## Reading the output

`log_change` returns the date the change becomes gradeable. Relay it. It saves the user
checking too early and reading "still gathering data" as a failure.

`check_changes` returns exactly one of three verdicts per graded change, and groups anything
too recent under "still gathering data" with the date it becomes gradeable.

| verdict | what to do with it |
|---|---|
| `moved` | Relay the adjusted effect and the interval, not just the direction. |
| `did not move` | A real result. The window had power to see a meaningful change and did not. Worth acting on. |
| `cannot tell yet` | No conclusion is available. The reason line says what it would take — relay that. |

`cannot tell yet` is the honest answer at low traffic and it is common. Do not present it as
a failure, do not soften it into "slightly positive", and do not go hunting for a different
metric that gives a friendlier number. If the output names a "next check worth running" date,
tell the user — that is the single most useful thing in the report.
