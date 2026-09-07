---
name: changelog
description: Use when a user-visible product change ships — pricing, copy, onboarding, packaging, email, or channel — to record it with log_change so it can be graded later. Also use when the user asks whether a past change worked.
---

# Logging changes

You already know what changed and when, because you made the change. Logging is a side
effect of work you were doing anyway. Call `log_change` when a user-visible change ships.

**Being aggressive about what does NOT get logged is the whole design.** Forty useless
entries a week and the log is dead — nobody reads it, and `check_changes` spends its
statistical budget grading noise. A log with six real entries beats one with sixty.

## Log this

A change a user could notice. If a customer could see it, feel it, or be charged
differently because of it, log it.

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

A performance fix is a judgment call. Log it only if a user would notice — "checkout page
went from 4s to 800ms" is user-visible; "reduced a query from 40ms to 12ms" is not.

## Rules

**Non-code changes count, and matter most.** "Prices came down today" typed in a chat
session must log exactly as well as a merged PR does. Most of what moves a solo operator's
numbers never touches the repo: a price announced in a DM, a new posting cadence, a changed
email subject line. If the user tells you they changed something user-visible, log it — do
not wait for a commit.

**One change per entry. Never batch.** Two prices changed in one deploy are two entries.
A rewritten headline and a reordered onboarding flow are two entries. `check_changes` pairs
each entry with a metric; a batched entry cannot be attributed to anything.

**If unsure, ask once. Never log speculatively.** One question — "did that pricing change go
live, or are you still deciding?" — then act on the answer. Do not log a change you think
might have shipped. A speculative entry poisons the baseline for every real change near it.

**Set `metric_hint` when you know the funnel step.** Naming the event the change touches
(`signup_started`, `checkout_started`, `paywall_viewed`) lets `check_changes` grade on the
metric closest to the change instead of falling back to revenue. On a small account that is
worth roughly six times the resolution — it is often the difference between a verdict and
"cannot tell yet".

**Set `date` when the change shipped earlier.** Backfilling last month's price change is
useful. Guessing at its date is not — ask if you do not know.

## Grading

`check_changes` returns exactly one of three verdicts per change: `moved`, `did not move`,
`cannot tell yet`.

`cannot tell yet` is the honest answer at low traffic and it is common — it means the data
could not have detected a change worth acting on, so no conclusion is available. Do not
present it as a failure, do not soften it into "slightly positive", and do not go looking
for a different metric that gives a friendlier number. The reason line says what it would
take; relay that.

When the tool says a change `moved`, relay the adjusted effect and the interval, not just
the direction. When it says `did not move`, that means the window had the power to see a
meaningful change and did not — that is a real result and worth acting on.
