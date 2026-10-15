# Linq chat-ID capacity

VIL-407. The Linq line holds **200 chat IDs**. Each 1:1 chat with a parent is one ID, and each group chat is one ID. Hale watches the count and pages **#ops**. It never blocks, delays or holds a send because of the count, at 100% included.

Code: `apps/web/lib/monitoring/linq-capacity.ts`, run as step 5 of `/api/cron/queue-maintenance` (every 10 minutes).

## What #ops sees, and when

| Count | Page |
| --- | --- |
| reaches 140 (70%) | `Hale: Linq chat IDs at 70% - <n> of 200 (1:1 <d>, groups <g>). Runbook: docs/linq-chat-capacity.md` |
| reaches 180 (90%) | The same line at 90%. |
| jumps past both in one tick | One page, at 90%. Both thresholds latch. |
| Linq cannot be counted, and the DB count reaches a threshold | `Hale: Linq count unavailable (<reason>); DB sees <n> of 200 chat IDs (undercounts parents mid-intake and erased families). Runbook: ...` |

Each threshold pages **once per upward crossing**. It re-arms only when the Linq count falls strictly below 130 (for 70%) or 170 (for 90%). A count that stays at 150 for weeks is one page. Falling back below the line posts nothing. The DB fallback can raise a page but never re-arms, so a Linq outage cannot flap a threshold.

The page carries counts only. No chat id, phone number, handle, name or key appears in the page, the logs or the cron's JSON.

The cron's JSON carries `capacity.outcome`:

- `below` (with any `rearmed` thresholds) or `latched`: normal.
- `alerted`: a page went out.
- `alert_send_failed` or `skipped_not_configured`: the page did not leave. The threshold stays armed, and the next tick retries. `skipped_not_configured` means `OPS_SLACK_WEBHOOK_URL` is unset in that environment.
- `claim_unavailable`: the latch table did not answer. The page is withheld.
- `linq_unavailable` (with `reason` and the DB count `db`): Linq could not be counted, and the DB count crossed nothing. If this repeats, check `LINQ_API_KEY` and the provider-health pages.

## How it counts

- **Linq (the source of truth).** `GET /v3/chats` with the existing `LINQ_API_KEY`, 100 per page, following `next_cursor`, ids deduped. No `from` filter, so it counts every chat the key sees. If the test line shares the prod account, test chats are inside the 200.
- **DB (fallback only).** Every distinct chat id any Hale table recorded (12 columns, canary chats excluded). It runs only when the Linq count fails.
- **Why the DB undercounts.** A parent still in intake has no family row yet, so their 1:1 is not in `channel_messages`. An erased family's rows are deleted, but its chats stay on Linq. A Linq count well above the DB count by much more than the number of parents mid-intake means drift worth a look.

## Probe

Read-only, counts only:

```
LINQ_API_KEY=... [DATABASE_URL=...] pnpm --filter @hale/web probe:linq-capacity --env test|prod
```

`--env` labels each line `key=<env> db=<env>`. Run the test line first, then prod.

## At 70%

1. Run the probe against prod and note the numbers on VIL-407.
2. List candidates that may be freeing nothing: `linq_group_rosters` rows with status `ejected` or `not_group`, chats from erased families, and test chats on a shared account.
3. Ask Linq whether leaving a chat (`leave_chat`, `handles[].left_at`) frees an ID, and whether the limit can be raised.

## At 90%

Barton chooses: a raised limit from Linq, or a second line.

## Never

- Never leave or archive a chat without Barton.
- Never block or hold new parents in code because of this count.

## Audit

No `audit_log` row. `audit_log.family_id` is NOT NULL, and this is a line-level ops event (the provider-health precedent). The latch rows in `rate_limits` under route `ops:linq-capacity` are the record: no row means armed, `count = 1` means paged, and a larger value is a page in flight. A stamp left by a crash is released after 2 minutes.
