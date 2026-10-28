# Launch runbook

Hale is an iMessage assistant. A parent texts the Hale Linq number, **+1 646 235 2164** (`LINQ_FROM_E164`). Hale answers in that chat. The web app is the receipts surface.

Production web is the Vercel project **hale-web**.

## iMessage onboarding

The parent opens the thread. Each step below is one reply, decided in code. The model writes every reply (friend voice; #868 removed the fixed ladder copy).

### Door

1. Linq posts the parent's message to `POST /api/channels/linq/inbound?version=2026-02-03`.
2. The route is `apps/web/app/api/channels/linq/inbound/route.ts`. It calls `handleLinqInboundRequest` in `apps/web/lib/channel/linq/inbound.ts`.
3. The signature check is `verifyLinqWebhookSignature` in `apps/web/lib/channel/linq/signature.ts`. The secret is `LINQ_WEBHOOK_SECRET` (the `whsec_` value). The signed content is `{webhook-id}.{webhook-timestamp}.{raw body}`. A timestamp more than five minutes off is rejected.
4. Missing `LINQ_API_KEY` or `LINQ_WEBHOOK_SECRET` returns **503** `linq_not_configured`. Nothing is parsed and nothing is written. Linq retries a 503.
5. A bad signature returns **403** `invalid_signature`. A wrong `version` query returns **400** `unsupported_webhook_version`.
6. A healthy door returns **200**. The reply is sent in that request through the Linq partner API (`LINQ_API_KEY`), from the intake machine. A throw becomes **500**. Linq retries a 5xx, and `#ops` is paged (see the webhook playbook).

A 1:1 text is marked read on Linq before the turn finishes. A refused mark-read is logged and the reply still goes out.

### Where the conversation lives

| While | Table | What you see |
| --- | --- | --- |
| Before a family exists | `sms_intake_sessions` | One open row per number. `state` is the step. `data_encrypted` holds the transcript, the collected postal code and ages, and any contact-card claim. `family_id` is null. |
| After the family is created | `channel_messages` | Inbound and outbound rows, `channel = 'imessage'`, `category = 'intake'`. Inbound `body` is the parent's text. Outbound `body` is null. `provider_chat_id` is the Linq chat. |
| Every write that has a family | `audit_log` | One row per action. Names used below. |
| The number, once enrolled | `parent_channels` | Active row for that parent. `linq_contact_card_shared_at` is the last time the Hale card was shared (or a share still in flight). |

`channel_messages.family_id` is required, so a brand-new parent's first texts are not in `channel_messages` yet. They are on `sms_intake_sessions`. Provisioning replays that transcript into `channel_messages`.

Code: `apps/web/lib/channel/intake/session.ts` (read/write the session), `apps/web/lib/channel/intake/machine.ts` (`handleInboundSms`), `apps/web/lib/channel/inbound-route.ts` (post-onboarding handoff).

### Steps

`FIRST_TOUCH_LADDER_ENABLED` must be `on` (trim, then exactly `on`) for this ladder. Any other value, including unset and `true`, uses the older first text: one ask for kids, ages, and a postal code (`deliverFirstHello` in `machine.ts`). A session already on the ladder keeps going if the flag later flips.

| What the parent does | Hale sends | Code | Session `state` | Rows |
| --- | --- | --- | --- | --- |
| Texts the number | Postal-code question. If `FIRST_TOUCH_LOCATION_CARD_ENABLED` is exactly `true` (no trim) and Linq accepts, a location card goes first and the text asks them to tap it. | `openFirstTouch`, `sendPlaceAsk` | `awaiting_place` | `sms_intake_sessions`. Audit `first_touch_location_requested` is written at provisioning, with `outcome`. |
| Sends a Canadian postal code (or the location share resolves to a city) | Asks only for the kids' ages. No activity list on this step. | `friendOnboardingTurn` | `awaiting_ages` | Same session. Collected place is inside `data_encrypted` (`firstTouch.place`). |
| Sends the kids' ages | The family is created. Hale sends the first find: age-fit activities for the year. | `provision` → `provisionFromIntake` in `provision.ts`, then `radar.compose` | `awaiting_ladder`, or `awaiting_cold_start` when the cold-start flag is on | See "Family create" below. PostHog `intake_completed`. |
| Answers the name question | What to call them, and the kids' first names if they want. | `handleLadder` when `ladder_next` is `name` / `name_reply`. Cold-start uses `continueColdStart`. | stays `awaiting_ladder` or `awaiting_cold_start` | `channel_messages`. Name capture writes `audit_log.action_taken = 'parent_name_captured'`. |
| Next replies | A link to connect Google Calendar, then a link to connect Gmail. Code mints the URL and appends it. | `sendYearConnectorCards` in `connector-offer.ts` | `complete` when the ladder finishes | `channel_messages`, deduped per family. Template keys `intake:calendar_card` and `intake:gmail_card`. |

The Hale contact card is not one of those questions. After a successful 1:1 iMessage outbound, `shareLinqCardAfterFirstOutbound` shares the Name and Photo card once per America/Toronto day for that chat, after that day's first outbound. SMS and groups are not shared. The name is `Hale` plus a hibiscus (U+1F33A), from `HALE_CONTACT_FIRST_NAME`, and a stored line-card name that differs is patched to that before the share. Setup is `POST /v3/contact_card`; HTTP 409 or Linq code 2014 is `PATCH /v3/contact_card`. Share waits until `GET /v3/contact_card` says `is_active`. Linq code 2012 (no card) creates the card, confirms it, then shares. Before a family exists, the claim sits in the session blob. `provisionFromIntake` copies it onto `parent_channels.linq_contact_card_shared_at` and writes audit `linq_contact_card_shared` with `chatId` and `sharedOn`. A share already recorded for that chat today is not repeated. The next Toronto day's first outbound shares again. Code: `apps/web/lib/channel/linq/contact-card.ts`.

PostHog `intake_started` fires on the first reply. `intake_completed` fires when the family row exists.

### Family create

`provisionFromIntake` writes these in one transaction:

- `users` (no email; the phone is the account)
- `families` (`onboarding_stage` starts as `sms_intake`)
- `family_members` (`primary_parent`)
- `children` (age the parent gave; date of birth is derived)
- `parent_channels` (verified, phone stored encrypted, lookup by `phone_e164_hash`)
- `loop_prefs`
- `channel_messages` replay of the pre-family transcript
- `audit_log`: `family_created`, `sms_intake_provisioned`, `channel_sms_enrolled`, and `linq_contact_card_shared` when the card already went out

### Friend voice


On, the machine still picks the step. The model writes that one reply from `packages/agent/skills/onboarding-friend.md`, via `speakFriend` in `apps/web/lib/channel/intake/friend-voice.ts`. Find lines and connector URLs are appended in code. The model does not choose the next step.

A failed, judged-bad, or timed-out compose is retried once on a smaller prompt. If that also fails, nothing canned is sent. The miss is logged `onboarding-friend: reply not sent` and paged to Slack #ops. The next inbound, or the morning nudge, tries the model again.

With friend voice on, an empty this-week list is not announced. The ages question goes out alone. When cold start is also on and the year list has titles, that list is the "which of these" question, and the name question comes on the next reply. Calendar and Gmail each wait for their own reply. When cold start is off, the year-find turn asks the name, and the connector links follow on later replies.

### Cold-start flag

`COLD_START_LADDER_ENABLED` exactly `true` (no trim) and a first-touch session: the find turn stops after the activity list. Name, calendar, and Gmail leave on later replies (`continueColdStart`). The locked name, calendar, and email lines leave only when `COLD_START_LADDER_COPY_LOCKED` is exactly `true`. Friend voice writes those replies from the skill instead, and does not wait on the copy-lock flag.

`COLD_START_INTENT_CLASSIFIER_ENABLED` exactly `true` lets a later "set me up" or "what can you do" pull the next ask. Off, that pull is skipped and the text continues to the coach once the session closes.

With cold start off, English sends the name ask on the find turn. French, with friend voice off, skips the name and sends the calendar link on that turn. `sms_intake_sessions` keeps `ladder_next`: `name`, `name_reply`, `calendar`, `gmail`, then the co-parent ask, then `state = complete`.

### Crons that touch this door

All of these are Vercel Cron routes under `apps/web/app/api/cron`, listed in `apps/web/vercel.json`. Each requires `Authorization: Bearer <CRON_SECRET>` or it returns 401 and does no work.

| Route | Schedule | What it does for iMessage |
| --- | --- | --- |
| `/api/cron/drain` | every minute | Drains the queue. Onboarding replies are sent inside the webhook. Replies after onboarding are queued, then drained here. |
| `/api/cron/inbound-canary` | every 10 minutes | Posts a Linq-signed inbound at the real webhook and checks the previous tick's `channel_messages` row (`provider_message_id` prefix `hale-canary-`). |
| `/api/cron/queue-maintenance` | every 10 minutes | Re-drives inbound `channel_messages` rows whose `handed_off_at` is still null, and pages #ops when the Linq line crosses 70% or 90% of its chat IDs ([linq-chat-capacity.md](linq-chat-capacity.md)). |
| `/api/cron/intake-sitting-reminder` | hourly | One nudge for a parent who stopped on the place or ages question. |

A cron that returns stamps `cron_heartbeats`. A throw does not. `/api/health/crons` reads that table.

## Rollback

Two different moves.

**Bad deploy.** Vercel → project **hale-web** → Deployments → the last good Production deployment → Promote. That points the production domain at that deployment. It keeps that deployment's environment values.

**Flag.** Change the Production env var, then redeploy the current production code so the functions read the new value. Promoting an older deployment does not pick up an env edit you just saved.

Redeploy steps, same for every flag:

1. Vercel → **hale-web** → Settings → Environment Variables. Edit the Production value.
2. Deployments → the deployment marked Production → Redeploy.
3. Wait until the new deployment is Production.
4. Send one text to +1 646 235 2164, or wait for the next inbound-canary tick, and confirm the behavior in the tables below.

| Flag | Set Production to | What changes |
| --- | --- | --- |
| `FIRST_TOUCH_LADDER_ENABLED` | empty | Older first text (kids, ages, and postal code in one ask). `on` is the only value that opens the postal-then-ages ladder. |
| `FIRST_TOUCH_LOCATION_CARD_ENABLED` | empty | Postal-code sentence. The location card is requested only when the value is exactly `true`. |
| `COLD_START_LADDER_ENABLED` | empty | Name and connector links can leave on the find turn. Exactly `true` parks the session on `awaiting_cold_start`. |
| `COLD_START_LADDER_COPY_LOCKED` | empty | Locked cold-start name, calendar, and email lines do not leave. Exactly `true` lets them leave. |
| `COLD_START_INTENT_CLASSIFIER_ENABLED` | empty | "Set me up" / "what can you do" does not pull the next ask. |
| `LINQ_POLLS` | empty | Year-find polls are not sent. `on` is the only value that sends them. |
| `LINQ_GROUP_COPARENT` | `off` | In-group co-parent seating stops. Any other value, including empty, leaves it on. |
| `LINQ_GROUP_MEMBERS_ENABLED` | empty | Extra household seats stay dark. Trimmed `true` enables them. |
| `LINQ_GROUP_ONBOARDING_V2_ENABLED` | empty | Hale's own add to a group is acknowledged and nothing else happens (`signal_from_me`; a `chat.created` answers `chat.created`). No roster is read and no chat is claimed. Rosters and claims already written stay. Trimmed `true` enables it. |
| `LINQ_GROUP_MENTIONS_ENABLED` | empty | Inbound iMessage mentions are parsed and unused. Group replies go out without a `mention` field. Trimmed `true` enables them. |
| `LINQ_MULTI_FAMILY_GROUPS_ENABLED` | empty | Shared groups that hold more than one family stay dark. Trimmed `true` enables them. |
| `LINQ_GROUP_POLLS_ENABLED` | empty | Parent-made group polls stay dark. Trimmed `true` enables them. Native cards also need `LINQ_POLLS=on`. |

To close the Linq door, clear `LINQ_API_KEY` or `LINQ_WEBHOOK_SECRET` on hale-web Production and redeploy with the steps above. The route returns 503 `linq_not_configured` and writes nothing. Linq retries that 503, so put the secret back and redeploy to accept the retries.

Migrations are additive. A bad migration is fixed forward. Do not drop columns from this runbook.

## On call

Slack handles only. Page in **#ops**.

A Linq chat-ID capacity page has its own runbook: [linq-chat-capacity.md](linq-chat-capacity.md).

| Who | Handle | Owns |
| --- | --- | --- |
| Barton, founder | @barton | Product, and the person to reach on Slack |
| Eugene, CTO | @eugene | Backend and models |
| Noah, engineering agent | @noah | Engineering agent |

@barton is the first page. @eugene for a model outage, a bad compose (`onboarding-friend: fallback reply` with `model_failed`), or a migration. @noah for a code change on the webhook, the intake machine, or a flag.

## Where to look

**Vercel runtime logs.** Project hale-web, production, filter the function `/api/channels/linq/inbound`. Lines that matter:

- `linq inbound: not configured` — a secret is missing. The `missing` field names `LINQ_API_KEY` or `LINQ_WEBHOOK_SECRET`.
- `linq inbound: subscription URL is not pinned to webhook version 2026-02-03`
- `linq inbound: routed` — the door accepted the text. `outcome` is the machine's result.
- `channel webhook threw` with `route: linq_inbound` — the handler threw. The response was 500.
- `onboarding-friend: fallback reply` — friend voice did not use the model's sentence.
- `linq contact card: first outbound share did not finish` — the text went out; the card did not.
- `webhook alert: founder page not delivered` — the #ops page did not land.

**Supabase** (production, read-only):

- `channel_messages` — `channel = 'imessage'`, newest `created_at`. Inbound rows have `direction = 'in'` and a `body`. A parent who already has a family should grow a row per text. `handed_off_at` null on an inbound row means the coach queue does not have it yet.
- `sms_intake_sessions` — open rows have `closed_at` null. `state` is `awaiting_place`, `awaiting_ages`, `awaiting_ladder`, `awaiting_cold_start`, or `complete`. `updated_at` moves on each reply.
- `parent_channels` — `revoked_at` null is the live number. `linq_contact_card_shared_at` is the last share time. Null means no share is held, including a setup that failed before the card was pushed.
- `audit_log` — `action_taken` of `sms_intake_inbound`, `sms_intake_outbound`, `sms_intake_provisioned`, `family_created`, `linq_contact_card_shared`, `sms_reply_received`.

**PostHog.** Event `webhook_route_failed` with `route = linq_inbound` (distinct id `route:linq_inbound`). Events `intake_started` and `intake_completed` for the funnel. The failure event carries the route and the error class.

**Slack #ops.** A thrown webhook posts `Hale ALERT: linq_inbound threw`. The page is at most once per 15 minutes per instance. The inbound canary and cron dead-man also post here. The webhook URL is `OPS_SLACK_WEBHOOK_URL`.

**Daily #ops post.** At 13:14 UTC, `/api/cron/ops-daily` posts one `Hale daily` summary. The 24h block is over every real family (probe-range households, `METRICS_EXCLUDED_FAMILY_IDS` and the founder excluded): reply p50/p95, gaps over 15 minutes, unanswered steps, failed and held sends, failed turns, cache reads and recorded spend. The same post carries the founder counts: W4 retention and open promises as of the window end, and over the trailing 7 days the intake funnel with median time to first answer, medical answers that used the fixed 811/911 line, whether the registration re-verify sweep ran (and the tally that run recorded), plus the database's Linq chat-ID count against the 200 limit. Counts only. Set `METRICS_EXCLUDED_FAMILY_IDS` to the QA family ids before the first post; an empty list counts those households. A post that did not land is retried by `curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/cron/ops-daily`; a day already posted answers `already_posted`. It needs `APP_ENCRYPTION_KEY` and throws without it.

## Linq webhook failure

### Symptoms

Parents get no replies. For a parent who already finished onboarding, no new inbound rows appear in `channel_messages`. For a parent still in the first texts, `sms_intake_sessions` does not gain a row and `updated_at` does not move. The inbound canary starts failing.

A 403 or 400 does not page. A thrown handler does: 500, a Vercel log `channel webhook threw`, a PostHog `webhook_route_failed`, and a #ops alert.

### Checks

1. **Linq dashboard, webhook delivery.** Confirm the subscription URL is `https://<production host>/api/channels/linq/inbound?version=2026-02-03` and that recent deliveries show a response. 503 means a secret is missing. 403 means the signature did not verify. 400 means the version query is wrong. 500 means the handler threw.
2. **Signature secret.** `LINQ_WEBHOOK_SECRET` on hale-web Production is the subscription's `whsec_` secret, with no extra wrapping. A rotated Linq secret that was not copied here fails every delivery with 403.
3. **Route status.** Vercel → hale-web → the Production deployment → Functions → `/api/channels/linq/inbound`. Read the latest invocations and the log lines above.
4. **Recent deploys.** Vercel → hale-web → Deployments. Note anything promoted in the last hour. Compare with the Linq delivery timestamps.

Also confirm `LINQ_API_KEY` and `LINQ_FROM_E164` are set. The door stays dark if the key is missing, even when the signing secret is present. Replies go out with the key; the from-number is the Hale line.

### Fixes

- **503 / not configured.** Set the missing secret on hale-web Production and redeploy (steps in Rollback). Linq retries the 503s.
- **403 / invalid signature.** Paste the current subscription signing secret into `LINQ_WEBHOOK_SECRET` and redeploy. If Linq was rotated, create the matching value; the old secret will keep failing.
- **400 / unsupported version.** Point the Linq subscription at `?version=2026-02-03`.
- **500 after a deploy.** Promote the last good hale-web deployment. Then read the thrown error class in the Vercel log and in PostHog.
- **200s and no replies.** The door accepted the text. Read `outcome` on `linq inbound: routed`. Then check `sms_intake_sessions` for an open row, and `channel_messages` for a parent who already has a family. If `handed_off_at` is null, `/api/cron/queue-maintenance` and `/api/cron/drain` are the next place to look. If the log says `onboarding-friend: fallback reply`, the text did leave, on the fallback sentence.
- **Texts arrive, card does not.** The reply path is fine. Read `linq contact card:` in the same request log. `parent_channels.linq_contact_card_shared_at` stays at the previous share time (or null) until this attempt claims the day.

### Escalation

1. Post the symptom, the Linq delivery status, and the Vercel log line in **#ops**.
2. Page **@barton**.
3. Page **@eugene** when the log is `model_failed`, a 500 from the database, or a migration.
4. Page **@noah** when the fix is a code change on the webhook, the intake machine, or a flag rollback that needs a deploy.

## Poster QR codes and PostHog attribution

Every poster QR URL carries `?src=<poster-slug>&utm_source=poster&utm_medium=qr&utm_campaign=<poster-slug>`. The site reads `s`, then `src`, then (on `utm_source=poster` links only) `utm_campaign` (apps/site/lib/analytics/source-code.ts), keeps the first touch in sessionStorage, and registers it as the `source_code` super property on every site event. The text CTA pre-writes `(via <slug>)` into the SMS body (apps/site/lib/text-entry.ts `buildSmsBody`); intake reads it back (`sourceCodeFromBody`) onto `first_text_received.source_code` and `$set_once.first_source_code`. A slug must be registered in `SOURCE_VENUES` (apps/web/lib/channel/intake/copy.ts) and match `^[a-z0-9]+(-[a-z0-9]+)*$` (max 48).

| slug | poster location | QR URL |
|---|---|---|
| `earlyon-richmondhill` | Richmond Hill | `https://villagehale.com/?src=earlyon-richmondhill&utm_source=poster&utm_medium=qr&utm_campaign=earlyon-richmondhill` |
| `earlyon-georgetown` | Georgetown | `https://villagehale.com/?src=earlyon-georgetown&utm_source=poster&utm_medium=qr&utm_campaign=earlyon-georgetown` |
| `earlyon-acton` | Acton | `https://villagehale.com/?src=earlyon-acton&utm_source=poster&utm_medium=qr&utm_campaign=earlyon-acton` |
| `ossington` | Ossington | `https://villagehale.com/?src=ossington&utm_source=poster&utm_medium=qr&utm_campaign=ossington` |
| `markham` | Markham | `https://villagehale.com/?src=markham&utm_source=poster&utm_medium=qr&utm_campaign=markham` |
| `earlyon-markham` | Markham | `https://villagehale.com/?src=earlyon-markham&utm_source=poster&utm_medium=qr&utm_campaign=earlyon-markham` |
| `poster-bayview-sheppard` | Bayview & Sheppard | `https://villagehale.com/?src=poster-bayview-sheppard&utm_source=poster&utm_medium=qr&utm_campaign=poster-bayview-sheppard` |
| `poster-yonge-sheppard` | Yonge & Sheppard | `https://villagehale.com/?src=poster-yonge-sheppard&utm_source=poster&utm_medium=qr&utm_campaign=poster-yonge-sheppard` |
| `poster-yonge-hollywood` | Yonge & Hollywood | `https://villagehale.com/?src=poster-yonge-hollywood&utm_source=poster&utm_medium=qr&utm_campaign=poster-yonge-hollywood` |
| `poster-north-york-centre` | North York Centre | `https://villagehale.com/?src=poster-north-york-centre&utm_source=poster&utm_medium=qr&utm_campaign=poster-north-york-centre` |
| `poster-yonge-ellerslie` | Yonge & Ellerslie | `https://villagehale.com/?src=poster-yonge-ellerslie&utm_source=poster&utm_medium=qr&utm_campaign=poster-yonge-ellerslie` |
| `poster-kensington` | Kensington Market | `https://villagehale.com/?src=poster-kensington&utm_source=poster&utm_medium=qr&utm_campaign=poster-kensington` |
| `poster-spadina-dundas` | Spadina & Dundas | `https://villagehale.com/?src=poster-spadina-dundas&utm_source=poster&utm_medium=qr&utm_campaign=poster-spadina-dundas` |
| `poster-grange-park` | Grange Park | `https://villagehale.com/?src=poster-grange-park&utm_source=poster&utm_medium=qr&utm_campaign=poster-grange-park` |
| `poster-queen-john` | Queen & John | `https://villagehale.com/?src=poster-queen-john&utm_source=poster&utm_medium=qr&utm_campaign=poster-queen-john` |
| `poster-queen-spadina` | Queen & Spadina | `https://villagehale.com/?src=poster-queen-spadina&utm_source=poster&utm_medium=qr&utm_campaign=poster-queen-spadina` |
| `poster-queen-bathurst` | Queen & Bathurst | `https://villagehale.com/?src=poster-queen-bathurst&utm_source=poster&utm_medium=qr&utm_campaign=poster-queen-bathurst` |
| `poster-leslieville-carlaw` | Leslieville - Queen & Carlaw | `https://villagehale.com/?src=poster-leslieville-carlaw&utm_source=poster&utm_medium=qr&utm_campaign=poster-leslieville-carlaw` |
| `poster-leslieville-jones` | Leslieville - Queen & Jones | `https://villagehale.com/?src=poster-leslieville-jones&utm_source=poster&utm_medium=qr&utm_campaign=poster-leslieville-jones` |
| `poster-queen-coxwell` | Queen & Coxwell | `https://villagehale.com/?src=poster-queen-coxwell&utm_source=poster&utm_medium=qr&utm_campaign=poster-queen-coxwell` |
| `poster-beaches-woodbine` | The Beaches - Queen & Woodbine | `https://villagehale.com/?src=poster-beaches-woodbine&utm_source=poster&utm_medium=qr&utm_campaign=poster-beaches-woodbine` |
| `poster-beaches-lee` | The Beaches - Queen & Lee | `https://villagehale.com/?src=poster-beaches-lee&utm_source=poster&utm_medium=qr&utm_campaign=poster-beaches-lee` |
| `poster-high-park-humberside` | High Park & Humberside | `https://villagehale.com/?src=poster-high-park-humberside&utm_source=poster&utm_medium=qr&utm_campaign=poster-high-park-humberside` |
| `poster-high-park-annette` | High Park & Annette | `https://villagehale.com/?src=poster-high-park-annette&utm_source=poster&utm_medium=qr&utm_campaign=poster-high-park-annette` |
| `poster-junction-pacific` | The Junction - Dundas & Pacific | `https://villagehale.com/?src=poster-junction-pacific&utm_source=poster&utm_medium=qr&utm_campaign=poster-junction-pacific` |
| `poster-junction-clendenan` | The Junction - Dundas & Clendenan | `https://villagehale.com/?src=poster-junction-clendenan&utm_source=poster&utm_medium=qr&utm_campaign=poster-junction-clendenan` |
| `poster-leaside-laird` | Leaside - Eglinton & Laird | `https://villagehale.com/?src=poster-leaside-laird&utm_source=poster&utm_medium=qr&utm_campaign=poster-leaside-laird` |
| `poster-leaside-rumsey` | Leaside - Millwood & Rumsey | `https://villagehale.com/?src=poster-leaside-rumsey&utm_source=poster&utm_medium=qr&utm_campaign=poster-leaside-rumsey` |
| `poster-bayview-belsize` | Bayview & Belsize | `https://villagehale.com/?src=poster-bayview-belsize&utm_source=poster&utm_medium=qr&utm_campaign=poster-bayview-belsize` |
| `poster-bayview-fleming` | Bayview & Fleming | `https://villagehale.com/?src=poster-bayview-fleming&utm_source=poster&utm_medium=qr&utm_campaign=poster-bayview-fleming` |
| `poster-queen-broadview` | Riverdale - Queen & Broadview | `https://villagehale.com/?src=poster-queen-broadview&utm_source=poster&utm_medium=qr&utm_campaign=poster-queen-broadview` |
| `poster-queen-logan` | Riverdale - Queen & Logan | `https://villagehale.com/?src=poster-queen-logan&utm_source=poster&utm_medium=qr&utm_campaign=poster-queen-logan` |
| `poster-danforth-broadview` | The Danforth - Broadview | `https://villagehale.com/?src=poster-danforth-broadview&utm_source=poster&utm_medium=qr&utm_campaign=poster-danforth-broadview` |
| `poster-danforth-playter` | The Danforth - Playter Estates | `https://villagehale.com/?src=poster-danforth-playter&utm_source=poster&utm_medium=qr&utm_campaign=poster-danforth-playter` |
| `poster-danforth-pape` | The Danforth - 975 Danforth Ave | `https://villagehale.com/?src=poster-danforth-pape&utm_source=poster&utm_medium=qr&utm_campaign=poster-danforth-pape` |
| `poster-roncesvalles-marion` | Roncesvalles - Marion | `https://villagehale.com/?src=poster-roncesvalles-marion&utm_source=poster&utm_medium=qr&utm_campaign=poster-roncesvalles-marion` |
| `poster-roncesvalles-galley` | Roncesvalles - Galley | `https://villagehale.com/?src=poster-roncesvalles-galley&utm_source=poster&utm_medium=qr&utm_campaign=poster-roncesvalles-galley` |
| `poster-roncesvalles-fermanagh` | Roncesvalles - Fermanagh | `https://villagehale.com/?src=poster-roncesvalles-fermanagh&utm_source=poster&utm_medium=qr&utm_campaign=poster-roncesvalles-fermanagh` |
| `poster-roncesvalles-grenadier` | Roncesvalles - Grenadier | `https://villagehale.com/?src=poster-roncesvalles-grenadier&utm_source=poster&utm_medium=qr&utm_campaign=poster-roncesvalles-grenadier` |
| `poster-roncesvalles-howard-park` | Roncesvalles - Howard Park | `https://villagehale.com/?src=poster-roncesvalles-howard-park&utm_source=poster&utm_medium=qr&utm_campaign=poster-roncesvalles-howard-park` |
| `poster-bloor-parkside` | High Park - Bloor & Parkside | `https://villagehale.com/?src=poster-bloor-parkside&utm_source=poster&utm_medium=qr&utm_campaign=poster-bloor-parkside` |
| `poster-bloor-west-glendonwynne` | Bloor West Village - Glendonwynne | `https://villagehale.com/?src=poster-bloor-west-glendonwynne&utm_source=poster&utm_medium=qr&utm_campaign=poster-bloor-west-glendonwynne` |
| `poster-bloor-west-willard` | Bloor West Village - Willard | `https://villagehale.com/?src=poster-bloor-west-willard&utm_source=poster&utm_medium=qr&utm_campaign=poster-bloor-west-willard` |
| `poster-bloor-west-riverview` | Bloor West Village - Riverview Gardens | `https://villagehale.com/?src=poster-bloor-west-riverview&utm_source=poster&utm_medium=qr&utm_campaign=poster-bloor-west-riverview` |
| `poster-bloor-west-old-mill` | Old Mill & Swansea | `https://villagehale.com/?src=poster-bloor-west-old-mill&utm_source=poster&utm_medium=qr&utm_campaign=poster-bloor-west-old-mill` |
| `poster-yonge-davisville` | Davisville - Yonge & Davisville | `https://villagehale.com/?src=poster-yonge-davisville&utm_source=poster&utm_medium=qr&utm_campaign=poster-yonge-davisville` |
| `poster-yonge-millwood` | Davisville - Yonge & Millwood | `https://villagehale.com/?src=poster-yonge-millwood&utm_source=poster&utm_medium=qr&utm_campaign=poster-yonge-millwood` |
| `poster-mt-pleasant-manor` | Mount Pleasant - Manor Rd | `https://villagehale.com/?src=poster-mt-pleasant-manor&utm_source=poster&utm_medium=qr&utm_campaign=poster-mt-pleasant-manor` |
| `poster-yonge-eglinton` | Yonge & Eglinton | `https://villagehale.com/?src=poster-yonge-eglinton&utm_source=poster&utm_medium=qr&utm_campaign=poster-yonge-eglinton` |
| `poster-yonge-lawrence-park` | Lawrence Park - 3060 Yonge | `https://villagehale.com/?src=poster-yonge-lawrence-park&utm_source=poster&utm_medium=qr&utm_campaign=poster-yonge-lawrence-park` |
| `poster-yonge-bedford-park` | Bedford Park - Yonge & Woburn | `https://villagehale.com/?src=poster-yonge-bedford-park&utm_source=poster&utm_medium=qr&utm_campaign=poster-yonge-bedford-park` |
| `poster-beaches-kew` | The Beaches - Kew Gardens | `https://villagehale.com/?src=poster-beaches-kew&utm_source=poster&utm_medium=qr&utm_campaign=poster-beaches-kew` |
| `poster-kingston-waverley` | The Beaches - Kingston & Waverley | `https://villagehale.com/?src=poster-kingston-waverley&utm_source=poster&utm_medium=qr&utm_campaign=poster-kingston-waverley` |
| `poster-upper-beaches` | Upper Beaches | `https://villagehale.com/?src=poster-upper-beaches&utm_source=poster&utm_medium=qr&utm_campaign=poster-upper-beaches` |
| `poster-high-park-glenlake` | High Park - Glenlake | `https://villagehale.com/?src=poster-high-park-glenlake&utm_source=poster&utm_medium=qr&utm_campaign=poster-high-park-glenlake` |
| `poster-high-park-dundas` | High Park - Dundas | `https://villagehale.com/?src=poster-high-park-dundas&utm_source=poster&utm_medium=qr&utm_campaign=poster-high-park-dundas` |
| `poster-st-clair-christie` | St Clair West - Christie | `https://villagehale.com/?src=poster-st-clair-christie&utm_source=poster&utm_medium=qr&utm_campaign=poster-st-clair-christie` |
| `poster-st-clair-rushton` | St Clair West - Rushton | `https://villagehale.com/?src=poster-st-clair-rushton&utm_source=poster&utm_medium=qr&utm_campaign=poster-st-clair-rushton` |
| `poster-st-clair-atlas` | St Clair West - Atlas | `https://villagehale.com/?src=poster-st-clair-atlas&utm_source=poster&utm_medium=qr&utm_campaign=poster-st-clair-atlas` |
