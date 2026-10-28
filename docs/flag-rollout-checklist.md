# Staged enablement checklist

VIL-405. Merging this page leaves every flag where it is.

Production env was not read. State comes from the flag read in `apps/web`, `apps/worker`, and `packages`, plus `.env.example`, `docs/capability-registry.md`, `docs/deploy/README.md`, `docs/evals/VIL-376-model-benchmark-results.md`, and the pull request that added the flag. `apps/worker` reads one product flag, `AUTONOMOUS_EXECUTE_ENABLED`, in the orchestrator that `apps/web` runs from `/api/cron/drain`. Eval scripts read `EVAL_GATEWAY_MODEL` only when someone runs an eval.

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
| `SAME_ACTIVITY_MEET_ENABLED` | `true` | unconfirmed, verify in Vercel env | `false` | Noah |
| `MID_ACTIVITY_ASK_ENABLED` | `true` | unconfirmed, verify in Vercel env | `false` | Noah |
| `BOOKED_DETECTION_ENABLED` | `true` | unconfirmed, verify in Vercel env | `false` | Noah |
| `BOOKED_DETECTION_BACKFILL_ENABLED` | `true` | unconfirmed, verify in Vercel env | `false` | Noah |
| `F14_ENABLED` | `true` | unconfirmed, verify in Vercel env | `false` | Noah |
| `AUTONOMOUS_EXECUTE_ENABLED` | `true` (exact, untrimmed) | off: stays unset until Barton sets it. A kind still does not run until its turn-on text has been delivered | unset | Barton |
| `LINQ_GROUP_COPARENT` | unset (anything except `off`) | on | `off` | Noah |
| `GCAL_PAST_CLASSIFY_SKIP` | unset (anything except `false`) | on | `false` | Noah |
| `VOICE_DISABLED` | unset | unset (voice runs) | `true` | Sloane |
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
| `FIRST_REPLY_ACTION_LINE` | `true` | off | `false` | Sloane |
| `FIRST_TOUCH_LADDER_ENABLED` | `on` | off | empty, or `off` | Sloane |
| `FIRST_TOUCH_LOCATION_CARD_ENABLED` | `true` | off | `false` | Noah |
| `FOLLOWUP_ASKS_ENABLED` | `true` | off | `false` | Noah |
| `GOING_COUNT_ENABLED` | `true` | off | `false` | Noah |
| `GOOGLE_PUSH_SYNC_ENABLED` | `true` | off | `false` | Noah |
| `GOOGLE_WRITE_SCOPES_ENABLED` | `true` | off | unset, or anything except `true` | Noah |
| `LINQ_GROUP_MEMBERS_ENABLED` | `true` | off | `false` | Noah |
| `LINQ_GROUP_ONBOARDING_V2_ENABLED` | `true` (trimmed) | off | empty, or `false` | Noah (copy: Sloane) |
| `LINQ_MULTI_FAMILY_GROUPS_ENABLED` | `true` | off | `false` | Noah |
| `LINQ_POLLS` | `on` | off | empty, or `off` | Sloane |
| `LINQ_EFFECTS_ENABLED` | `true` (trimmed) | off | empty, or `false` | Sloane |
| `LOOP_SEND_ENABLED` | `true` | off | `false` | Noah |
| `MEMORY_DIGEST_APPLY` | `true` | off | `false` | Noah |
| `MEMORY_SYNTHESIS_APPLY` | `true` | off | `false` | Noah |
| `ORPHAN_USER_SWEEP_ENABLED` | `true` | off | `false` | Noah |
| `SIGNUP_SANDBOX_RUNTIME_ENABLED` | `true` | off | `false` | Noah |
| `BROWSER_USE_SIGNUP_ENABLED` | `true` | off | empty, or `false` | Barton |
| `BROWSER_USE_SIGNUP_PAYMENT_ENABLED` | `true` | off | empty, or `false` | Barton |
| `BROWSER_USE_WATCH_ENABLED` | `true` | off | empty, or `false` | Barton |
| `SOCIAL_WATCHLIST` | `on` | off | empty, or `off` | Noah |
| `TRAVEL_BRIEF_ENABLED` | `true` | on (verify in Vercel); read through the VIL-226 lane helper as `travel_brief`, no action | unset it — off is off for every household; while on, a non-empty `TRAVEL_BRIEF_FAMILY_ALLOWLIST` narrows the brief to the listed households | Sloane |
| `VILLAGE_INTROS_ENABLED` | `true` | off | `false` | Noah |
| `WATCHED_SPOTS_ENABLED` | `true` | off | `false` | Noah |
| `WEEKDAY_CARE_ENABLED` | `true` | off | `false` | Sloane |
| `WORKSTREAMS_ENABLED` | `true` | off | `false` | Noah |
| `INTEREST_PASSPORT_ENABLED` | `true` | off | `false` | Noah |
| `CALENDAR_ALERT_ENABLED` | `true` | off unless set | unset | Barton |
| `PARENT_CALENDAR_MIRROR_ENABLED` | `true` | off unless set | unset | Barton |
| `EMAIL_ALERT_ENABLED` | `true` | off unless set | unset | Barton |
| `REGISTRATION_LADDER_ENABLED` | `true` | off unless set | unset | Barton |
| `HOLDING_LINE_ENABLED` | `true` (no trim) | off | unset | Barton |
| `GENERAL_ANSWER_SEARCH_ENABLED` | kill switch: `false` (no trim) turns it off | on | unset | Barton |

The four lane switches (VIL-226) hold work while they are off. They do not delete it. Like every other `true` flag above, the value must be exactly `true`: a piped `echo` stores `true` followed by a newline, which keeps the lane off. Set it with `printf '%s' true`, then redeploy. `TRAVEL_BRIEF_ENABLED` is read through the same helper under its own name.

- With `CALENDAR_ALERT_ENABLED` unset, both the 1:1 calendar text and the Linq household calendar notice are off. The sweep still remembers each change. A calendar text Hale already owes stays owed and is offered again when the lane is back on. One older than the usual pending limit is aged out by the lane-off sweep itself (`pending_expired`), so its held title and location are cleared on time. Kid events not yet told to the group stay unannounced until then. Passport stamps inferred from calendar changes follow this switch too: with the lane off no calendar stamp is written, even with `INTEREST_PASSPORT_ENABLED=true`, and the sweep returns `passport: 'lane_off'`. This includes a seeding run (a connection's first sync, or a full resync Google forces after a stale sync token).
- With `PARENT_CALENDAR_MIRROR_ENABLED` unset, mirrored `family_events` rows stay in the database and no new reminders are created for them (counted as `notScheduledLaneOff` in the reminders cron response). Reminders already scheduled stay `scheduled` and are counted as `heldLaneOff`. The connector sync logs the held window with `heldReason: 'lane_off'`.
- A reminder whose time passed (held by a lane, or late after a cron gap) is never turned into `missed` by a time window. When it is next classified it is sent if its event has not started (counted in `firedLate` beside `fired`), an evening-before reminder on the event's own day included, and dropped as `started` once the event has begun. A reminder opens with its event's own local date, never a word like "tomorrow", and the voice phrases the day from the event's local start and the send moment. Each drop is logged as `reminder: dropped, not sent` with its reason and writes a `reminder_suppressed` audit row. The per-family send decider (#859) is on main and dark; it does not classify reminders, so this rule still decides.
- With `REGISTRATION_LADDER_ENABLED` unset, the registration-sequence cron runs no ladder and answers `{ lane: 'registration_ladder', outcome: 'lane_off', groupSync: 'lane_off' }`. The sequence rows are left as they are, so a leg whose window is still open goes out once the lane is back on. The group-decision flush in the same route is held too: those syncs send group bubbles.
- `EMAIL_ALERT_ENABLED` holds the parent 1:1 text and the silent booked-detection backfill. With the lane on, Hale tells the parent what a parenting email says, in their 1:1. The backfill still sends no text; its `activity_bookings` rows feed how-it-went texts. With the lane off the backfill does not start a page, logs `booked detection backfill: email lane off, page not started`, and stamps nothing, so the page is read when the lane is back. `BOOKED_DETECTION_BACKFILL_ENABLED` keeps its own meaning. This coupling stays until the VIL-226 kid check runs in the backfill path.
- With `EMAIL_ALERT_ENABLED` unset, the Gmail ingest cursor (`historyId`) still advances, and a second watermark, `alertHistoryId`, stays where the lane went off. The sync logs `connector sync: gmail alert watermark` with `gmailCursor: 'held_lane_off'`. When the lane is back on, the held mail is released in that sweep and never dropped (`released`). A pass that throws leaves the watermark in place (`release_failed`) and the next sweep retries it. A history read that stops at its page limit carries the last record it reached forward as the watermark (`releasing`). Only if Gmail no longer has history that far back is the watermark dropped as `held_expired`, and that mail is not alerted.
- There is no per-family or per-sweep count on how many messages a lane may send. The lane switch is the stop. A calendar change older than the pending limit is still aged out (`pending_expired`), because a three-day-old "it moved" is no longer the week.
- Before VIL-226 merges, set `EMAIL_ALERT_ENABLED`, `CALENDAR_ALERT_ENABLED`, `PARENT_CALENDAR_MIRROR_ENABLED` and `REGISTRATION_LADDER_ENABLED` to exactly `true` and redeploy, so nothing that sends today stops. A lane whose value is missing at merge stops that lane with a named `lane_off` outcome until it is set.

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
| `METRICS_EXCLUDED_FAMILY_IDS` | none (required before the first daily #ops post; drops those families from the post and the Monday digest) |

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
| `COPARENT_DUTY_SENDS_ENABLED` | Hale may send duty questions in the co-parent group. The model writes the sentence. A miss holds the send (`model_unsent`) and writes `reply_copy_fallback`. | `channel_messages.category` = `duty_ask` with status `failed`, and more than two `duty_ask` rows for one family in 24 hours. | `false` | Noah |
| `SAME_ACTIVITY_MEET_ENABLED` | When a caller reaches this code, a meet reply is prepared only after both households opt in. `deliverSameActivityReply` returns `skipped: 'not_configured'`, so the line stays in process. Nothing in the inbound router calls this path today. | A `channel_messages` row that carries a meet line, or an audit row `same_activity_opt_in_recorded`. | `false` | Noah |
| `MID_ACTIVITY_ASK_ENABLED` | The nudge cron runs the sweep. A due ask is counted and not texted. The log line is `mid-activity ask: copy may leave but no sender is wired`. | That log line, and any `channel_messages` row with template key `mid-activity:ask`. | `false` | Noah |
| `BOOKED_DETECTION_ENABLED` | A booking confirmation is stored as a held spot. | `activity_booking_recorded` rows, and parent alerts that fire for mail the backfill should have stayed quiet on. | `false` | Noah |
| `BOOKED_DETECTION_BACKFILL_ENABLED` | One capped page of booking-shaped mail from the last 90 days is recorded, and the parent is not alerted. | Log line `gmail sweep: envelope outcome`. Backfill must not insert a `channel_messages` row. | `false` | Noah |
| `F14_ENABLED` | Hale may start a conversation (nudges, evening check-in, and the other proactive sweeps that read this flag). | Any outbound with no inbound from that parent the same day. A comment in `apps/web/lib/village/intros/run.ts` says this flag is on for real families. The capability registry still says the default is off. | `false` | Noah |
| `AUTONOMOUS_EXECUTE_ENABLED` | Hale acts on its own on an action type the parent opted into and approved five times in a row (rule #4), and only after the turn-on text for that grant has been delivered. Off, each such action is held for approval as `action.gated.lane_off`; a parent's own approval still executes. It stays unset until Barton sets it. On, a kind whose text has not been delivered is held as `action.gated.autonomy_notice_pending`, including overnight. The count of parents already at five approvals of a kind, run before it is ever set, is in the VIL-131 pull request: 0. | `action.executed` against `action.gated.*` per action type, and any `action.gated.lane_off` row while the value is `true`. | unset | Barton |

### On when unset

| Flag | What it does | Extra signal this week | Kill | Owner |
| --- | --- | --- | --- | --- |
| `LINQ_GROUP_COPARENT` | Co-parent seating and calendar notices stay in the Linq group. | Group `channel_messages` with status `failed`. | `off` | Noah |
| `GCAL_PAST_CLASSIFY_SKIP` | Calendar items that already ended skip the classifier. | A jump in classify volume or Anthropic spend after a calendar connect. | `false` | Noah |
| `VOICE_DISABLED` | Unset, voice compose runs when `ANTHROPIC_API_KEY` is set. | Odd parent-visible wording on composed sends, and `sms_turn_failed` on those turns. | `true` | Sloane |

### Ready to turn on

Code is merged. The repo still has these off. Flip one at a time, during a week when Noah is watching the five families. Do not flip a row in [Leave off](#leave-off) for those families.

| Flag | What it does | Extra signal this week | Kill | Owner |
| --- | --- | --- | --- | --- |
| `FIRST_TOUCH_LADDER_ENABLED` | A new parent is asked for a place, then shown a week find, before the older hello. | First-session `channel_messages` with status `failed`. Redeploy `apps/site` too. | empty, or `off` | Sloane |
| `FIRST_REPLY_ACTION_LINE` | The first radar reply may include the action URL. | Replies that contain a URL the parent did not ask for. | `false` | Sloane |
| `COPARENT_DUTY_ASKS_ENABLED` | Duty replies are parsed. This flag does not send. | `coparent duty shadow` log lines, and parse misses against the duty fixtures. | `false` | Noah |
| `COPARENT_DUTY_MEMORY_ENABLED` | A recorded duty is written onto the family calendar and the ICS feed. | A duty on the calendar the parent did not confirm. | `false` | Noah |
| `COPARENT_DUTY_LOPSIDED_ENABLED` | A parent can be told the split looks lopsided. | More than one such note to the same family in a month. | `false` | Sloane |
| `FAMILY_MEMORY_KINDS_ENABLED` | Memory reads start using kind and expiry. The model writes the parent reply. A miss holds it. | A "what do you know" reply that leaves while the model did not write it. | `false` | Noah |
| `FOLLOWUP_ASKS_ENABLED` | Hale may check back after an introduction. | A second follow-up to the same family the same day. | `false` | Noah |
| `GOING_COUNT_ENABLED` | A sweep may count how many others are going. | A count that does not match the booking rows. | `false` | Noah |
| `GOOGLE_PUSH_SYNC_ENABLED` | Gmail and Calendar can sync from push, not only the 15-minute poll. | Log lines `google push: skipped, flag_off` after the flip, and webhook failures. | `false` | Noah |
| `LINQ_GROUP_MEMBERS_ENABLED` | A household group can hold more seats. | A seat added with no opt-in from that phone. | `false` | Noah |
| `LINQ_MULTI_FAMILY_GROUPS_ENABLED` | One Linq group can hold more than one family. | A message in the shared thread that names another family's child. | `false` | Noah |
| `LINQ_POLLS` | After a find with two or more hits, Hale can ask which to look at first. | A poll on an empty find, a conflict, or a receipt. | empty, or `off` | Sloane |
| `LOOP_SEND_ENABLED` | Calendar reminders are allowed to send. | `channel_messages` for reminders with status `failed`, and new `email_opt_outs`. | `false` | Noah |
| `WEEKDAY_CARE_ENABLED` | Hale asks once how the household covers weekdays. | A second weekday question to the same family. | `false` | Sloane |
| `WATCHED_SPOTS_ENABLED` | Hale polls a spot the parent asked to watch. | Spot texts with status `failed`, or a text for a spot the parent did not name. | `false` | Noah |
| `WORKSTREAMS_ENABLED` | Open workstreams ride the reply context, and a due check-back can send one follow-up. | A follow-up during quiet hours, or a second follow-up to the same family the same day. | `false` | Noah |
| `INTEREST_PASSPORT_ENABLED` | Family and kid pages show the interest passport. Gmail and Calendar can infer a stamp (a Calendar stamp also needs `CALENDAR_ALERT_ENABLED`). A stamp line rides a text that is already going out. | A stamp with no source, a second stamp for the same activity and season, or a text sent only to ask about a stamp. | `false` | Noah |
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

- `AUTHORIZED_SIGNUP_ENABLED`, `SIGNUP_SANDBOX_RUNTIME_ENABLED`, `BOOKING_REFERENCE_CONNECTOR_ENABLED`, `BROWSER_USE_SIGNUP_ENABLED`: signup stays off until Barton arms it. Neither the sandbox flag nor the Browser Use flag turns signup on. The Browser Use engine also needs `BROWSER_USE_API_KEY` (unset) and migration 0172. `BROWSER_USE_SIGNUP_PAYMENT_ENABLED` lets the agent pay with each parent's own Stripe Link Agent Wallet. Before arming it: Stripe must issue Hale a Link Agent Wallet OAuth client (`LINK_OAUTH_CLIENT_ID`, `LINK_OAUTH_CLIENT_SECRET`, plus `STRIPE_PUBLISHABLE_KEY`), migration 0173 must be applied, and the parent Link sign-in route must exist. The cap is the approved price, never above $500.
- `BROWSER_USE_WATCH_ENABLED`: the hourly provider watch stays off until Barton arms it. It also needs `BROWSER_USE_API_KEY`, migration 0177 and at least one `provider_watch_targets` row. Spend is capped in code (`watch/sweep.ts`): $0.10 model cap per run, 2 runs per sweep, $1 per rolling 24 hours of recorded session cost.
- `FIRST_TOUCH_LOCATION_CARD_ENABLED`: the Linq location card stays off.
- `COPARENT_DUTY_BURDEN_SURFACE_ENABLED`: the answer string does not leave even when the flag is on.
- `ACTIVITY_REVIEWS_SURFACE`: stays off until three households have answered about one subject.
- `MEMORY_SYNTHESIS_APPLY` and `MEMORY_DIGEST_APPLY`: the jobs already observe. Apply waits on a reviewed night of `applied: false` audit rows. Digest apply also needs `MEMORY_DIGEST_FAMILY_ALLOWLIST`.
- `ORPHAN_USER_SWEEP_ENABLED`: unset counts candidates and writes nothing. The write is irreversible.
- `SOCIAL_WATCHLIST`: the watchlist poll stays off.
- `VILLAGE_INTROS_ENABLED`: cross-household intros stay off. A non-empty allowlist narrows the flag. It does not add families while the flag is off.
- `INTEREST_PASSPORT_DEMO`: preview only. It stays unset in production. On a Vercel preview it also needs `VERCEL_ENV=preview` (Vercel sets that) and `INTEREST_PASSPORT_ENABLED=true`. Then `/demo/passport` opens the Mia and Leo fixture with no account and no database. The code refuses the combination when `VERCEL_ENV` is `production`.
- `GOOGLE_WRITE_SCOPES_ENABLED`: stays unset in production. Linq delivers inbound texts to the production webhook, so a preview URL cannot receive a parent text. `GOOGLE_WRITE_SCOPES_ALLOWLIST` is comma-separated Hale user ids: only those accounts are asked for `calendar.events` and `gmail.compose`, and only their placements and Gmail drafts write to Google. Everyone else keeps today's readonly consent, and a placement still writes `family_events` and sends the iTIP invite. Preview may set the flag to `true` with an empty allowlist. Flip the global flag in production only after Google verification approves those scopes.
- `HOLDING_LINE_ENABLED`: a slow 1:1 answer gets one composed line first, then the typing bubble again. Barton lights it. Set it with `printf '%s' true`, never a piped `echo`: a trailing newline keeps it dark. Probe: `channel_messages` rows with `template_key` = `holding_line`. Each one sits before the answer to the same inbound text, and none is in a group thread or on email. Rollback: unset it and redeploy `apps/web`.
- `GENERAL_ANSWER_SEARCH_ENABLED`: **on by default; only the exact value `false` turns it off.** An off-topic question whose answer rests on a fact (a score, a forecast, a price, a ranking, a date, how to do something, whether something is safe) is looked up with Anthropic web search before Hale answers. Barton lights it: it is a new outbound data flow and each search is billed. The search is sent the de-identified question and today's date. When the answer depends on where the family is and the question does not say (a forecast with no city), it is also sent the family's city and country, and the province or state only when that table has the city's name in more than one of them (`Windsor`, `Springfield`). None is sent as stored: the country is the name the code fixes for it, and the city and the province or state are names from the lane's own checked-in table (`apps/web/lib/channel/off-domain/postal-cities/`), the city being either the family's stored city when it is one of those names or the city their postal area belongs to. The place is the family's active saved area (`family_areas`) when it has one, and its home row otherwise; an active area that cannot be named is not swapped for the home city. The table holds every Canadian forward sortation area and every US ZIP code its public sources have; 80.5% of the Canadian areas and 98.8% of the US ones resolve to one city, and the rest are named `ambiguous` or `unmapped`, never guessed. When the question is sensitive (health, the mind, money, the law, or safety), a place of fewer than 10,000 people (2021 Census of Population, Statistics Canada table 98-10-0002; 2020 Census, P.L. 94-171) is not the place sent: the nearest place of 10,000 or more in the same province or state within 150 km is, or that province or state alone when there is none (`apps/web/lib/channel/off-domain/postal-cities/coarsen.json`). A name is sent as itself only when that census shows 10,000 or more people for it in that province or state, after St. and Saint, Ste. and Sainte, Mt. and Mount, Ft. and Fort, and Mc spellings are treated as one name. Every other name is coarsened, including one the census does not list. Only an explicit `no` keeps the smaller place: a missing or unparseable reading is sent the coarser place. The weather stays the town because the sanitizer reads it as `no`. Hale onboards Canada only today, so no real family reaches the US table yet. The postal code and everything else about the family are never sent, and a family whose city cannot be named is asked for it instead. The city is read only in a thread the door said is the parent's own: in a group thread, or one the job does not describe, the family's row is not read and Hale asks which city. Unlit, or when a search fails or returns nothing, Hale says it cannot check right now. Lit, a reply that left a question open (Hale asked which city, or could not check) keeps that question, de-identified, in a row of `channel_pending_asks` keyed by that reply's `channel_messages` row, and the parent's next text in the same channel and chat is read beside it, after the lane screen has read that text (so a reply that completes a question costs one screen call more than it did); a text in another chat, or in a thread the job does not describe, never reads it. The row is deleted when the router next answers a text from that parent; the holding line is not an answer and deletes nothing. A co-parent who leaves the household has theirs deleted in the departure's own transaction, and the erasure response counts them (`openQuestionsDeleted`; `search_dark` unlit, `not_migrated` lit without the table). A newer word from any other sender (a reminder, a nudge, a holding line) closes the question for the reader too, and the hourly retention sweep deletes those once that word is older than the turn deadline, so a holding line an in-flight turn has not read yet is left in place. It also deletes a question whose own reply never reached a phone, and any question a year old, and neither of those waits on the deadline. So a question is kept only while it is open, give or take an hour. A question over 500 characters, or one whose missing detail is over 200, is not kept. Unlit, nothing is kept or read by the lane; the hourly sweep reads the table, when the database has it, and finds it empty. **Migration `0167_channel_messages_pending_ask` creates that table. It no longer has to be applied before this code deploys: no insert into `channel_messages` names anything new. Apply it before lighting this flag.** Lit without it, no question is kept and every other part of the turn works: the read logs `off-domain lane: no pending ask for this parent` with `not_migrated`, the write logs `pending ask: the reply landed; the question it left open was not kept`, and the hourly sweep logs `message retention: pending-ask table missing`. **Before lighting in Production, check one real 1:1 text carries the group field:** with the flag lit in Preview, send one off-topic text from a real phone in a 1:1 thread and read that turn's logs. The queued job must carry `in_group: false`. `thread_unknown` on `off-domain answer: no place for this family`, or on `off-domain lane: no pending ask for this parent`, means it did not: such a job reads as a thread the job does not describe, and then neither the family's city nor an open question is ever used. On a turn that searched, a composed reply is not sent when it names a web host the search did not return, whether written with `https://`, with `www.`, or bare (`name.tld` in any case or script, judged by the Public Suffix List in `apps/web/lib/channel/off-domain/public-suffix/` (Mozilla Public License 2.0; the list's own header is in `public_suffix_list.dat`), or a numbered address with a page under it); the whole reply is read for one, the page under a link included; the parent gets the existing could-not-get-to-it line and the log says `link_not_from_search`. On every other turn, unlit included, the rule is main's: only a link written with `https://` or `www.` is refused, and a site named by its bare domain (`Booking.com`) is sent as written. Set it with `printf '%s' true`, never a piped `echo`: a trailing newline keeps it dark. Probe: text an off-topic question about last night's score from a test family and read the `apps/web` logs for that turn; a searched answer logs `off-domain answer: live search ran` with `search: 'searched'` and its result count, and an unlit one logs `off-domain answer: no live search this turn` with `search: 'search_off'`. Lit, a question that leaves out what its answer depends on, for a family whose city cannot be named, is not searched and logs the second line with `search: 'missing_detail'`, after `off-domain answer: no place for this family` with the reason (`no_country`, `unsupported_country`, `no_postal`, `unmapped`, `ambiguous`, `group_thread`, `thread_unknown`). Unlit, the same question logs `search: 'search_off'` and Hale does not ask for the city. A lit turn the screen sends to the coach or to the general answer also logs `off-domain lane: no pending ask for this parent` with `none`, `other_thread`, `not_migrated` or `not_read` (and why: `thread_unknown`, `screen_unavailable`), or `off-domain answer: the reply to a pending ask` with `completed`, `unrelated` or `unread`. A question too long to keep logs `off-domain lane: the question this reply left open was not kept` with `too_long`. No line carries the question, the city, the province or the country. Rollback: unset it and redeploy `apps/web`.
- `LINQ_GROUP_ONBOARDING_V2_ENABLED`: when Hale is added to a family's group, it reads who is in the chat (`linq_group_rosters`) and claims the chat for the one family whose verified parent is in it. It seats nobody and sends nothing. Leave it off until the who's-who asks, the roles-confirmed send gate, and 1:1 connect links ship. Before the flag goes on, a sandbox probe has to show which webhook fires when a person adds Hale's line, and the live Linq subscription (do not change it in this PR) has to include `chat.created` and `participant.added` (the Sep 23 snapshot subscribed to `message.*` only). With the flag on and no send gate, a claimed chat would receive proactive group lines before anyone has said who they are. Migration `0158_linq_group_roster` must be applied first; until it is, the roster step answers `not_migrated`. Green-bubble / MMS groups cannot add a Linq line.
- `LINQ_EFFECTS_ENABLED`: iMessage screen and bubble effects stay off. The model is never asked. Design: rare, only when the parent would feel the moment too; never on logistics, reminders, asks, or anything sensitive; in a group only when the group itself is celebrating. Code holds quiet hours and a 24h-per-chat send-history cap. Leave it off until a judged recording of `linq-effect-eval.mjs` passes.

## First five families

The first five real families are watched every day until each has been on the thread for seven days. Noah posts one summary to Slack `#ops` each day. Sloane adds a line when a parent-visible sentence was wrong. Eugene adds a line when a `HALE_*_MODEL_MODE` flag is `candidate` or when turn latency jumped.

Each day's note names the five family ids and these counts:

1. `channel_messages` for those families: `failed` versus `sent` and `delivered`, split by category (`duty_ask`, onboarding, `followup`).
2. `audit_log` rows with `action_taken` = `sms_turn_failed`.
3. No-reply gaps: an outbound ask with no inbound from that parent for 24 hours.
4. Latency from the inbound `channel_messages` row to `sms_turn_answered`.
5. Opt-outs: STOP, new `email_opt_outs` rows, `same_activity_opt_in_revoked`.

A failed send, a `sms_turn_failed` row, a STOP, or a no-reply gap tied to a claimed-live flag is a kill the same day. The owner sets that flag's kill value and redeploys `apps/web` before the next send window. The summary says which flag was killed.

`SAME_ACTIVITY_MEET_ENABLED` and `MID_ACTIVITY_ASK_ENABLED` do not send. For those two, the kill signal is a `channel_messages` row from that path, not a no-reply gap.
