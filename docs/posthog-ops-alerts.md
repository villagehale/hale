# PostHog launch alerts and dashboard

Server-side product analytics and error tracking (`apps/web`, `apps/worker`, `posthog-node`). Dark until the flags below are exactly `true` in Prod. Telemetry is fire-and-forget and never blocks a parent reply. Distinct ids are HMAC-SHA256 of the family (or intake session) id with `POSTHOG_ID_SALT`. Group type `family` uses that hash; Linq group chats also set group type `group_chat` to the hashed chat id. No phone numbers, names, or message text.

The listing script is `scripts/posthog-ops-alerts.sh`. Create the alerts in PostHog Insights → Alerts, destination Slack `#ops`.

## Env vars

| Variable | Purpose | Default |
| --- | --- | --- |
| `NEXT_PUBLIC_POSTHOG_KEY` | Product-events project (same key as the browser) | unset → no product events |
| `POSTHOG_PROJECT_API_KEY` | `$exception` + `$ai_generation` project (may be the same project) | unset → no error tracking / LLM trace |
| `POSTHOG_HOST` / `NEXT_PUBLIC_POSTHOG_HOST` | Region host | `https://us.i.posthog.com` |
| `POSTHOG_ID_SALT` | HMAC key for family / group-chat ids | unset → launch events skipped |
| `POSTHOG_PRODUCT_EVENTS_ENABLED` | Launch product events | off (must be exactly `true`) |
| `POSTHOG_ERROR_TRACKING_ENABLED` | `$exception` + `send_failed` / `message_unanswered` / `turn_failed` / `registration_run_failed` | off (must be exactly `true`) |
| `POSTHOG_OPS_ALERTS_ENABLED` | PostHog insight alerts are the paging path; the daily `#ops` Slack post still runs until Barton retires it | off (must be exactly `true`) |
| `POSTHOG_UNANSWERED_AFTER_MINUTES` | Inbound with no `sms_turn_answered` after this many minutes | `15` |

## Product events

Keyed on HMAC(family id). Pre-family intake steps use HMAC(session id) until a family exists.

### `message_inbound` / `message_outbound`

Fired at the `channel_messages` insert (inbound hand-off, intake ledger, conversation reply, loop dispatch, claimed-group send). Not from parsing text.

| Property | Values |
| --- | --- |
| `channel` | `imessage` / `sms` / `group` / `email` |
| `is_group` | boolean |
| `family_count` | families currently in that Linq group (`1` on 1:1) |
| `media_type` | `none` / `image` / `video` / `audio` / `file` / `mixed` |
| `reply_ms` | outbound: ms since the inbound this reply answers. inbound: omitted. unanswered error: age of the inbound. Named `reply_ms` because `buildEvent` drops keys containing `lat` (latitude). |

### `task_completed`

Fired when the state change is committed (DB write).

| Property | Values |
| --- | --- |
| `type` | `registration` / `carpool` / `calendar_change` / `rsvp` / `reminder` / `email_action` |
| `source` | `parent_report` / `browser_use` / `plan` / `assisted` / `group` / `cron` / `email` / `worker` |

### `group_chat_created` / `group_chat_member_added`

| Property | Values |
| --- | --- |
| `family_count` | live families in the chat after the write |

### `onboarding_step`

Each intake `saveSession` that commits a new state (`awaiting_details`, `awaiting_place`, `awaiting_ages`, `awaiting_follow_up`, `awaiting_watch_reply`, `awaiting_clarify`, `awaiting_ladder`, `awaiting_cold_start`, `complete`, `stopped`, `superseded`).

| Property | Values |
| --- | --- |
| `step` | the committed intake state |

### `onboarding_completed`

Intake session state becomes `complete`.

### `family_signed_up`

`provisionFromIntake` committed a families row.

## Error events

Gated by `POSTHOG_ERROR_TRACKING_ENABLED`. Each also records a redacted `$exception` (class + frames, no message).

| Event | When | Properties |
| --- | --- | --- |
| `send_failed` | Linq send error committed on the ledger | `channel`, `is_group`, `reason` (Linq code) |
| `message_unanswered` | inbound `reply` with no `sms_turn_answered` after N minutes (`/api/cron/unanswered`) | `channel`, `is_group`, `reply_ms` |
| `turn_failed` | agent turn threw or the model could not write, so nothing was sent | `reason` |
| `registration_run_failed` | Browser Use signup / plan / assisted run ended `error` | `provider_domain`, `stage`, `source` (`signup` / `plan` / `assisted`) |

`$exception` is also captured from `captureSafeException` (API / cron / webhook / worker / agent) when the same flag is on.

## Slack `#ops` alerts to create

Destination: Slack `#ops`. Create these as PostHog insight alerts (Trends, unique event count unless noted). Keep the existing daily `#ops` post (`/api/cron/ops-daily`); `POSTHOG_OPS_ALERTS_ENABLED` does not skip it.

1. **send_failed > 0 in 15m** — event `send_failed`, last 15 minutes, total count > 0.
2. **message_unanswered > 0** — event `message_unanswered`, last 15 minutes, total count > 0.
3. **turn_failed spike** — event `turn_failed`, last 15 minutes vs the prior 15 minutes, alert when the current window is ≥ 3 and ≥ 3× the previous window.
4. **registration_run_failed > 0** — event `registration_run_failed`, last 15 minutes, total count > 0.

## Dashboard definitions

Exact recipes for the launch dashboard. Use the **product** project (`NEXT_PUBLIC_POSTHOG_KEY`). Breakdowns and counts use the hashed `distinct_id` (the family). Filter test families out in PostHog if a hashed exclusion list is maintained there; this repo never sends phone numbers.

### Weekly active families

Any family with `message_inbound` in the week.

- Insight: **Trends**
- Series: unique users (`distinct_id`) who performed `message_inbound`
- Interval: **week**
- Formula: none — the unique-user count **is** weekly active families

### 4-week retention

Of families with `message_inbound` in week 0, the share who also had `message_inbound` in week 4.

- Insight: **Retention**
- Start event: `message_inbound`
- Return event: `message_inbound`
- Period: **week**
- Look at column **Week 4**

### 8-week retention

Same as 4-week retention; read column **Week 8**.

### Things done per family per week

- Insight: **Trends**, interval **week**
- Series A: total count of `task_completed`
- Series B: unique users who performed `message_inbound` (weekly active families)
- Formula: `A / B`
- This is things done per weekly-active family per week. `task_completed.type` can be a breakdown (`registration`, `carpool`, `calendar_change`, `rsvp`, `reminder`, `email_action`).

### Count of multi-family groups

Linq chats with more than one Hale family.

- Insight: **Trends**
- Series: unique groups, group type **`group_chat`**
- Events: `group_chat_created` **or** `group_chat_member_added`
- Filter: `family_count >= 2`
- Interval: **all time** (or week, for new multi-family groups that week)

The unique `group_chat` group count under that filter is the count of multi-family groups.
