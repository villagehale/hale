# Staged enablement checklist

VIL-405. Merging this page leaves every flag where it is.

Production env was not read. State comes from the flag read in `apps/web`, `apps/worker`, and `packages`, plus `.env.example`, `docs/capability-registry.md`, `docs/deploy/README.md`, `docs/evals/VIL-376-model-benchmark-results.md`, and the pull request that added the flag. `apps/worker` has no product flag reads. Eval scripts read `EVAL_GATEWAY_MODEL` only when someone runs an eval.

**Unconfirmed, verify in Vercel env** means the rollout brief treats the flag as live, and the repo still records the code default as off. No pull request records the production value.

Kill switch, every time: set the value on the Vercel production project for `apps/web`, then redeploy that project. `FIRST_TOUCH_LADDER_ENABLED` and `FIRST_TOUCH_LOCATION_CARD_ENABLED` are also read by `apps/site`. Redeploy the site project when either of those changes.

`true` means the value is exactly `true`, with no extra characters. `on` means trim, then exactly `on`. `true`, `ON`, and `1` do not turn an `on` flag on.

Owners: Noah (Head of Eng) for flow and infra. Eugene for model-routing and eval. Sloane for a flag that gates parent-visible copy.

## Every flag

| Flag | On value | State | Kill (then redeploy) | Owner |
| --- | --- | --- | --- | --- |
| `COLD_START_LADDER_ENABLED` | `true` | unconfirmed, verify in Vercel env | `false` | Noah |
| `COLD_START_LADDER_COPY_LOCKED` | `true` | unconfirmed, verify in Vercel env | `false` | Sloane |
| `COLD_START_INTENT_CLASSIFIER_ENABLED` | `true` | unconfirmed, verify in Vercel env | `false` | Eugene |
| `COPARENT_DUTY_SENDS_ENABLED` | `true` | unconfirmed, verify in Vercel env | `false` | Noah |
| `COPARENT_DUTY_COPY_LOCKED` | `true` | unconfirmed, verify in Vercel env | `false` | Sloane |
| `SAME_ACTIVITY_MEET_ENABLED` | `true` | unconfirmed, verify in Vercel env | `false` | Noah |
| `MID_ACTIVITY_ASK_ENABLED` | `true` | unconfirmed, verify in Vercel env | `false` | Noah |
| `ONBOARDING_FRIEND_VOICE_ENABLED` | `on` | unconfirmed, verify in Vercel env | empty, or `off` | Sloane |
| `BOOKED_DETECTION_ENABLED` | `true` | unconfirmed, verify in Vercel env | `false` | Noah |
| `BOOKED_DETECTION_BACKFILL_ENABLED` | `true` | unconfirmed, verify in Vercel env | `false` | Noah |
| `F14_ENABLED` | `true` | unconfirmed, verify in Vercel env | `false` | Noah |
| `LINQ_GROUP_COPARENT` | unset (anything except `off`) | on | `off` | Noah |
| `GCAL_PAST_CLASSIFY_SKIP` | unset (anything except `false`) | on | `false` | Noah |
| `REQUIRE_EMAIL_VERIFICATION` | unset (anything except `false`) | on | `false` | Noah |
| `VOICE_DISABLED` | unset | unset (voice runs) | `true` | Sloane |
| `WEEK_PLAN_SUMMARY_DISABLED` | unset | unset (summary runs) | `true` | Sloane |
| `HALE_CLASSIFY_EVENT_MODEL_MODE` | `candidate` | unset (means `current`) | `current` | Eugene |
| `HALE_TRIAGE_MODEL_MODE` | `candidate` | unset (means `current`) | `current` | Eugene |
| `HALE_REPLY_INTENT_MODEL_MODE` | `candidate` | unset (means `current`) | `current` | Eugene |
| `HALE_INTAKE_EXTRACT_MODEL_MODE` | `candidate` | unset (means `current`) | `current` | Eugene |
| `HALE_INBOUND_SCREEN_MODEL_MODE` | `candidate` | unset (means `current`) | `current` | Eugene |
| `HALE_MEMORY_INFER_MODEL_MODE` | `candidate` | unset (means `current`) | `current` | Eugene |
| `HALE_VILLAGE_SEARCH_PARSE_MODEL_MODE` | `candidate` | unset (means `current`) | `current` | Eugene |
| `ACTIVITY_REVIEWS_ENABLED` | `true` | off | `false` | Noah |
| `ACTIVITY_REVIEWS_SURFACE` | `true` | off | `false` | Sloane |
| `AUTHORIZED_SIGNUP_ENABLED` | `on` | off | empty, or `off` | Noah |
| `BOOKING_REFERENCE_CONNECTOR_ENABLED` | `on` | off | empty, or `off` | Noah |
| `CHECK_IN_ANCHOR_ENABLED` | `true` | off | `false` | Sloane |
| `COPARENT_DUTY_ASKS_ENABLED` | `true` | off | `false` | Noah |
| `COPARENT_DUTY_MEMORY_ENABLED` | `true` | off | `false` | Noah |
| `COPARENT_DUTY_LOPSIDED_ENABLED` | `true` | off | `false` | Sloane |
| `COPARENT_DUTY_BURDEN_SURFACE_ENABLED` | `true` | off | `false` | Sloane |
| `FAMILY_MEMORY_KINDS_ENABLED` | `true` | off | `false` | Noah |
| `FAMILY_MEMORY_KINDS_COPY_LOCKED` | `true` | off | `false` | Sloane |
| `FIRST_REPLY_ACTION_LINE` | `true` | off | `false` | Sloane |
| `FIRST_TOUCH_LADDER_ENABLED` | `on` | off | empty, or `off` | Sloane |
| `FIRST_TOUCH_LOCATION_CARD_ENABLED` | `true` | off | `false` | Noah |
| `FOLLOWUP_ASKS_ENABLED` | `true` | off | `false` | Noah |
| `GOING_COUNT_ENABLED` | `true` | off | `false` | Noah |
| `GOOGLE_PUSH_SYNC_ENABLED` | `true` | off | `false` | Noah |
| `GOOGLE_WRITE_SCOPES_ENABLED` | `true` | off | unset, or anything except `true` | Noah |
| `IMESSAGE_UPGRADE_ASK` | `on` | off | empty, or `off` | Sloane |
| `LINQ_GROUP_MEMBERS_ENABLED` | `true` | off | `false` | Noah |
| `LINQ_GROUP_ONBOARDING_V2_ENABLED` | `true` (trimmed) | off | empty, or `false` | Noah (copy: Sloane) |
| `LINQ_MULTI_FAMILY_GROUPS_ENABLED` | `true` | off | `false` | Noah |
| `LINQ_POLLS` | `on` | off | empty, or `off` | Sloane |
| `LOOP_SEND_ENABLED` | `true` | off | `false` | Noah |
| `MEMORY_DIGEST_APPLY` | `true` | off | `false` | Noah |
| `MEMORY_SYNTHESIS_APPLY` | `true` | off | `false` | Noah |
| `ORPHAN_USER_SWEEP_ENABLED` | `true` | off | `false` | Noah |
| `SIGNUP_SANDBOX_RUNTIME_ENABLED` | `true` | off | `false` | Noah |
| `SOCIAL_WATCHLIST` | `on` | off | empty, or `off` | Noah |
| `SPEND_CEILING_ENFORCED` | `true` | off | `false` | Noah |
| `TRAVEL_BRIEF_ENABLED` | `true` | off | `false` | Sloane |
| `VILLAGE_INTROS_ENABLED` | `true` | off | `false` | Noah |
| `WATCHED_SPOTS_ENABLED` | `true` | off | `false` | Noah |
| `WEEKDAY_CARE_ENABLED` | `true` | off | `false` | Sloane |
| `WORKSTREAMS_ENABLED` | `true` | off | `false` | Noah |
| `INTEREST_PASSPORT_ENABLED` | `true` | off | `false` | Noah |

Allowlists are separate reads. Empty in `.env.example`. A non-empty list turns those families on while the global flag is off. Two exceptions: `VILLAGE_INTROS_FAMILY_ALLOWLIST` only narrows a flag that is already `true`, and `MEMORY_DIGEST_FAMILY_ALLOWLIST` applies only together with `MEMORY_DIGEST_APPLY=true`. Live contents are unconfirmed, verify in Vercel env.

| Allowlist | Global flag it pairs with |
| --- | --- |
| `BOOKED_DETECTION_FAMILY_ALLOWLIST` | `BOOKED_DETECTION_ENABLED` |
| `COPARENT_DUTY_ASKS_FAMILY_ALLOWLIST` | `COPARENT_DUTY_ASKS_ENABLED` |
| `COPARENT_DUTY_SENDS_FAMILY_ALLOWLIST` | `COPARENT_DUTY_SENDS_ENABLED` |
| `F14_FAMILY_ALLOWLIST` | `F14_ENABLED` |
| `FOLLOWUP_ASKS_FAMILY_ALLOWLIST` | `FOLLOWUP_ASKS_ENABLED` |
| `MEMORY_DIGEST_FAMILY_ALLOWLIST` | `MEMORY_DIGEST_APPLY` (apply also needs this list) |
| `TRAVEL_BRIEF_FAMILY_ALLOWLIST` | `TRAVEL_BRIEF_ENABLED` |
| `GOOGLE_WRITE_SCOPES_ALLOWLIST` | `GOOGLE_WRITE_SCOPES_ENABLED` (Hale user ids, not family ids; a listed user is armed while the flag is unset) |
| `VILLAGE_INTROS_FAMILY_ALLOWLIST` | `VILLAGE_INTROS_ENABLED` |
| `METRICS_EXCLUDED_FAMILY_IDS` | none (drops those families from digest metrics) |

`SIGNUP_BROWSER_RUNTIME` (`local`, `vercel_sandbox`, or `browserbase`) is read only after `SIGNUP_SANDBOX_RUNTIME_ENABLED` is `true`. Unset. Owner: Noah.

## What to watch

Same checks for every row below, for the first seven days after it is confirmed on:

- `channel_messages.status`: `failed` against `queued`, `sent`, and `delivered`.
- `audit_log.action_taken` = `sms_turn_failed`.
- No-reply gap: an outbound ask with no inbound from that parent for 24 hours.
- Latency: inbound `channel_messages` row to the matching `sms_turn_answered` audit row.
- Opt-outs: a parent STOP, a new `email_opt_outs` row, or `same_activity_opt_in_revoked`.

One extra signal is named on the row.

### Claimed live

These are the flags the brief says are on. Confirm the Vercel value before treating the row as live. If the value is off, leave it off until that day's check has an owner.

| Flag | What it does | Extra signal this week | Kill | Owner |
| --- | --- | --- | --- | --- |
| `COLD_START_LADDER_ENABLED` | A new parent gets the short ladder (find, name, calendar, email, signup offer) instead of the old hello. | Ladder sends in `channel_messages` for families still on the first session. | `false` | Noah |
| `COLD_START_LADDER_COPY_LOCKED` | The locked ladder sentences are allowed to leave. | A ladder turn with no outbound body. | `false` | Sloane |
| `COLD_START_INTENT_CLASSIFIER_ENABLED` | A model classifies the parent's reply on that ladder. | Turn latency on ladder replies, and classifier errors in the web logs. | `false` | Eugene |
| `COPARENT_DUTY_SENDS_ENABLED` | Hale may send duty questions in the co-parent group. | `channel_messages.category` = `duty_ask` with status `failed`, and more than two `duty_ask` rows for one family in 24 hours. | `false` | Noah |
| `COPARENT_DUTY_COPY_LOCKED` | Duty sentences are allowed to leave. | `audit_log` action `reply_copy_fallback` (the fixed line went out instead of the model line). | `false` | Sloane |
| `SAME_ACTIVITY_MEET_ENABLED` | When a caller reaches this code, a meet reply is prepared only after both households opt in. `deliverSameActivityReply` returns `skipped: 'not_configured'`, so the line stays in process. Nothing in the inbound router calls this path today. | A `channel_messages` row that carries a meet line, or an audit row `same_activity_opt_in_recorded`. | `false` | Noah |
| `MID_ACTIVITY_ASK_ENABLED` | The nudge cron runs the sweep. A due ask is counted and not texted. The log line is `mid-activity ask: copy may leave but no sender is wired`. | That log line, and any `channel_messages` row with template key `mid-activity:ask`. | `false` | Noah |
| `ONBOARDING_FRIEND_VOICE_ENABLED` | The model writes each onboarding step. Off this flag, the locked ladder copy stays. | Onboarding replies that ask two questions, and compose fallbacks in the web logs (`model_failed`, `unusable`). | empty, or `off` | Sloane |
| `BOOKED_DETECTION_ENABLED` | A booking confirmation is stored as a held spot. | `activity_booking_recorded` rows, and parent alerts that fire for mail the backfill should have stayed quiet on. | `false` | Noah |
| `BOOKED_DETECTION_BACKFILL_ENABLED` | One capped page of booking-shaped mail from the last 90 days is recorded, and the parent is not alerted. | Log line `gmail sweep: envelope outcome`. Backfill must not insert a `channel_messages` row. | `false` | Noah |
| `F14_ENABLED` | Hale may start a conversation (nudges, evening check-in, and the other proactive sweeps that read this flag). | Any outbound with no inbound from that parent the same day. A comment in `apps/web/lib/village/intros/run.ts` says this flag is on for real families. The capability registry still says the default is off. | `false` | Noah |

### On when unset

| Flag | What it does | Extra signal this week | Kill | Owner |
| --- | --- | --- | --- | --- |
| `LINQ_GROUP_COPARENT` | Co-parent seating and calendar notices stay in the Linq group. | Group `channel_messages` with status `failed`. | `off` | Noah |
| `GCAL_PAST_CLASSIFY_SKIP` | Calendar items that already ended skip the classifier. | A jump in classify volume or Anthropic spend after a calendar connect. | `false` | Noah |
| `REQUIRE_EMAIL_VERIFICATION` | An unverified email cannot sign in. | Sign-in errors on `/sign-in` for a new parent. | `false` | Noah |
| `VOICE_DISABLED` | Unset, voice compose runs when `ANTHROPIC_API_KEY` is set. | Odd parent-visible wording on composed sends, and `sms_turn_failed` on those turns. | `true` | Sloane |
| `WEEK_PLAN_SUMMARY_DISABLED` | Unset, the week-plan summary is composed. Sending still needs `LOOP_SEND_ENABLED`. | Summary text that names the wrong child or the wrong day. | `true` | Sloane |

### Ready to turn on

Code is merged. The repo still has these off. Flip one at a time, during a week when Noah is watching the five families. Do not flip a row in [Leave off](#leave-off) for those families.

| Flag | What it does | Extra signal this week | Kill | Owner |
| --- | --- | --- | --- | --- |
| `FIRST_TOUCH_LADDER_ENABLED` | A new parent is asked for a place, then shown a week find, before the older hello. | First-session `channel_messages` with status `failed`. Redeploy `apps/site` too. | empty, or `off` | Sloane |
| `FIRST_REPLY_ACTION_LINE` | The first radar reply may include the action URL. | Replies that contain a URL the parent did not ask for. | `false` | Sloane |
| `COPARENT_DUTY_ASKS_ENABLED` | Duty replies are parsed. This flag does not send. | `coparent duty shadow` log lines, and parse misses against the duty fixtures. | `false` | Noah |
| `COPARENT_DUTY_MEMORY_ENABLED` | A recorded duty is written onto the family calendar and the ICS feed. | A duty on the calendar the parent did not confirm. | `false` | Noah |
| `COPARENT_DUTY_LOPSIDED_ENABLED` | A parent can be told the split looks lopsided. | More than one such note to the same family in a month. | `false` | Sloane |
| `FAMILY_MEMORY_KINDS_ENABLED` | Memory reads start using kind and expiry. | A "what do you know" reply while `FAMILY_MEMORY_KINDS_COPY_LOCKED` is still off (it should stay quiet). | `false` | Noah |
| `FAMILY_MEMORY_KINDS_COPY_LOCKED` | Parent-facing memory sentences may leave. | `reply_copy_fallback` on a memory turn. | `false` | Sloane |
| `FOLLOWUP_ASKS_ENABLED` | Hale may check back after an introduction. | A second follow-up to the same family the same day. | `false` | Noah |
| `GOING_COUNT_ENABLED` | A sweep may count how many others are going. | A count that does not match the booking rows. | `false` | Noah |
| `GOOGLE_PUSH_SYNC_ENABLED` | Gmail and Calendar can sync from push, not only the 15-minute poll. | Log lines `google push: skipped, flag_off` after the flip, and webhook failures. | `false` | Noah |
| `LINQ_GROUP_MEMBERS_ENABLED` | A household group can hold more seats. | A seat added with no opt-in from that phone. | `false` | Noah |
| `LINQ_MULTI_FAMILY_GROUPS_ENABLED` | One Linq group can hold more than one family. | A message in the shared thread that names another family's child. | `false` | Noah |
| `LINQ_POLLS` | After a find with two or more hits, Hale can ask which to look at first. | A poll on an empty find, a conflict, or a receipt. | empty, or `off` | Sloane |
| `LOOP_SEND_ENABLED` | The weekly plan and calendar reminders are allowed to send. | `channel_messages` for `weekly_plan` and reminders with status `failed`, and new `email_opt_outs`. | `false` | Noah |
| `WEEKDAY_CARE_ENABLED` | Hale asks once how the household covers weekdays. | A second weekday question to the same family. | `false` | Sloane |
| `WATCHED_SPOTS_ENABLED` | Hale polls a spot the parent asked to watch. | Spot texts with status `failed`, or a text for a spot the parent did not name. | `false` | Noah |
| `WORKSTREAMS_ENABLED` | Open workstreams ride the reply context, and a due check-back can send one follow-up. | A follow-up during quiet hours, or a second follow-up to the same family the same day. | `false` | Noah |
| `INTEREST_PASSPORT_ENABLED` | Family and kid pages show the interest passport. Gmail and Calendar can infer a stamp. A stamp line rides a text that is already going out. | A stamp with no source, a second stamp for the same activity and season, or a text sent only to ask about a stamp. | `false` | Noah |
| `TRAVEL_BRIEF_ENABLED` | A trip can produce a short brief. The family also has to pass `F14_ENABLED`. | A brief for a family that is dark on F14 (the count should stay `dark`). | `false` | Sloane |
| `CHECK_IN_ANCHOR_ENABLED` | The evening check-in can name that day's activity. The lane still needs F14. | An evening text that names an activity from a different day. | `false` | Sloane |
| `ACTIVITY_REVIEWS_ENABLED` | How an activity went is reduced to a verdict. This pass sends nothing. | Verdicts filed for a family that did not answer. | `false` | Noah |
| `HALE_CLASSIFY_EVENT_MODEL_MODE` | `candidate` uses Sonnet 5.5 for event classification. Unset stays on Sonnet 5. | Classify errors and fallback count in the web logs. | `current` | Eugene |
| `HALE_TRIAGE_MODEL_MODE` | `candidate` uses JEV for sentinel triage, with Haiku when confidence is low. | Triage latency and low-confidence retries. | `current` | Eugene |
| `HALE_REPLY_INTENT_MODEL_MODE` | `candidate` uses JEV for reply intent. Assent still goes through Sonnet. | A yes/no stored for a reply the parent did not mean. | `current` | Eugene |
| `HALE_INTAKE_EXTRACT_MODEL_MODE` | `candidate` uses Sonnet 5.5 for intake extraction. The benchmark kept `current`. | Extracted ages or place that the parent did not say. | `current` | Eugene |
| `HALE_INBOUND_SCREEN_MODEL_MODE` | `candidate` uses JEV for the inbound screen, with Haiku when the margin is thin. | Screen latency and Haiku retry count. | `current` | Eugene |
| `HALE_MEMORY_INFER_MODEL_MODE` | `candidate` uses DeepSeek for memory inference. A failed tool loop is not retried. | Duplicate memory rows after a failed run. | `current` | Eugene |
| `HALE_VILLAGE_SEARCH_PARSE_MODEL_MODE` | `candidate` uses DeepSeek to parse a village search. Ranking stays put. | Searches that return an empty board after a normal question. | `current` | Eugene |

Set one model flag to `candidate` only. `AI_GATEWAY_API_KEY` has to be set for JEV and DeepSeek. Eugene watches that slice for the week.

### Leave off

These stay off for the first families. The kill value is in the inventory table.

- `AUTHORIZED_SIGNUP_ENABLED`, `SIGNUP_SANDBOX_RUNTIME_ENABLED`, `BOOKING_REFERENCE_CONNECTOR_ENABLED`: signup stays off until Barton arms it. The sandbox flag does not turn signup on.
- `FIRST_TOUCH_LOCATION_CARD_ENABLED`: the Linq location card stays off.
- `COPARENT_DUTY_BURDEN_SURFACE_ENABLED`: the answer string does not leave even when the flag is on.
- `ACTIVITY_REVIEWS_SURFACE`: stays off until three households have answered about one subject.
- `MEMORY_SYNTHESIS_APPLY` and `MEMORY_DIGEST_APPLY`: the jobs already observe. Apply waits on a reviewed night of `applied: false` audit rows. Digest apply also needs `MEMORY_DIGEST_FAMILY_ALLOWLIST`.
- `ORPHAN_USER_SWEEP_ENABLED`: unset counts candidates and writes nothing. The write is irreversible.
- `SPEND_CEILING_ENFORCED`: unset warns and keeps ingest. `true` drops events before classify.
- `SOCIAL_WATCHLIST`: the watchlist poll stays off.
- `VILLAGE_INTROS_ENABLED`: cross-household intros stay off. A non-empty allowlist narrows the flag. It does not add families while the flag is off.
- `IMESSAGE_UPGRADE_ASK`: the later year-retention ask stays off.
- `GOOGLE_WRITE_SCOPES_ENABLED`: stays unset in production. Linq delivers inbound texts to the production webhook, so a preview URL cannot receive a parent text. `GOOGLE_WRITE_SCOPES_ALLOWLIST` is comma-separated Hale user ids: only those accounts are asked for `calendar.events` and `gmail.compose`, and only their placements and Gmail drafts write to Google. Everyone else keeps today's readonly consent, and a placement still writes `family_events` and sends the iTIP invite. Preview may set the flag to `true` with an empty allowlist. Flip the global flag in production only after Google verification approves those scopes.
- `LINQ_GROUP_ONBOARDING_V2_ENABLED`: when Hale is added to a family's group, it reads who is in the chat (`linq_group_rosters`) and claims the chat for the one family whose verified parent is in it. It seats nobody and sends nothing. Leave it off until the who's-who asks, the roles-confirmed send gate, and 1:1 connect links ship. Before the flag goes on, a sandbox probe has to show which webhook fires when a person adds Hale's line, and the live Linq subscription (do not change it in this PR) has to include `chat.created` and `participant.added` (the Sep 23 snapshot subscribed to `message.*` only). With the flag on and no send gate, a claimed chat would receive proactive group lines before anyone has said who they are. Migration `0158_linq_group_roster` must be applied first; until it is, the roster step answers `not_migrated`. Green-bubble / MMS groups cannot add a Linq line.

## First five families

The first five real families are watched every day until each has been on the thread for seven days. Noah posts one summary to Slack `#ops` each day. Sloane adds a line when a parent-visible sentence was wrong. Eugene adds a line when a `HALE_*_MODEL_MODE` flag is `candidate` or when turn latency jumped.

Each day's note names the five family ids and these counts:

1. `channel_messages` for those families: `failed` versus `sent` and `delivered`, split by category (`duty_ask`, onboarding, `followup`, weekly plan).
2. `audit_log` rows with `action_taken` = `sms_turn_failed`.
3. No-reply gaps: an outbound ask with no inbound from that parent for 24 hours.
4. Latency from the inbound `channel_messages` row to `sms_turn_answered`.
5. Opt-outs: STOP, new `email_opt_outs` rows, `same_activity_opt_in_revoked`.

A failed send, a `sms_turn_failed` row, a STOP, or a no-reply gap tied to a claimed-live flag is a kill the same day. The owner sets that flag's kill value and redeploys `apps/web` before the next send window. The summary says which flag was killed.

`SAME_ACTIVITY_MEET_ENABLED` and `MID_ACTIVITY_ASK_ENABLED` do not send. For those two, the kill signal is a `channel_messages` row from that path, not a no-reply gap.
