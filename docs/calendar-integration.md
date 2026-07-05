# Calendar integration (not built — honest boundary)

`create_calendar_event` / `update_calendar_event` are **wired to an interface but
not implemented**. The executor calls `deps.calendar.createEvent/updateEvent`
(`apps/worker/src/services/calendar-client.ts`), and the default production client
throws `HALE_NOT_CONFIGURED: Google Calendar not connected` on every call. So an
approved calendar action fails **loud** (rule #8) rather than pretending to
succeed — same behavior as before, now behind a seam a Fake can replace in tests.

This is a **real integration project**, not a quick executor change. Finishing it
requires all of the following; none of it exists in the repo today.

## 1. A Google Cloud OAuth app

- A Google Cloud project with the **Google Calendar API** enabled.
- An **OAuth 2.0 client** (Web application) with the app's redirect URI registered.
- OAuth **consent screen** configured and (for public launch) **verified** by
  Google — the Calendar scopes (`.../auth/calendar.events`) are sensitive scopes
  that trigger Google's verification/security-assessment review.
- Client id + secret provided to the worker/web as secrets (never inline).

## 2. Per-family calendar tokens (new storage + a consent flow)

- A **consent/connect flow** in `apps/web` where a parent authorizes Hale to write
  to their calendar (the OAuth authorization-code round-trip). This is a **user
  consent gate** distinct from the in-product approval gate — connecting the
  calendar must be an explicit, revocable opt-in (PIPEDA/Law 25; rule #1).
- **Per-family token storage**: access token + refresh token + expiry + the
  chosen `calendarId`, encrypted at rest, family-scoped. The existing
  `credentials` / `integrations` schema is the likely home — a new
  additive migration (rule #9), not a destructive change.
- **Refresh handling**: access tokens expire (~1h); the client must refresh via
  the stored refresh token and persist the rotated token. A revoked/expired grant
  must surface as "calendar disconnected — reconnect", not a silent failure.

## 3. The real `CalendarClient`

- Implement `createEvent` / `updateEvent` in `calendar-client.ts` against the
  Google Calendar API using the family's stored token (loaded by `familyId`).
- Map `CalendarEventInput` (`title`, `startsAt`, `endsAt`, `description`,
  `providerEventId`) to the Calendar event body; return the provider event id as
  the reversal handle (so a revert can delete/patch it).
- `update` requires a stored `provider_event_id` from the original create — the
  action payload/executor result must carry it.

## Notes / guardrails already in place

- The reviewer's `REQUIRED_CHECKS` for calendar (`check_action_time_window`,
  `check_action_idempotency`) gate the mint (quiet-hours window + no double-create).
  Calendar events **don't spend money**, so `check_spending_cap` (rule #7) is not
  in the calendar contract — no cap plumbing is needed for the calendar path.
- Every executed calendar action still produces its `action.executed` audit row
  via `recordExecution` (rule #6), independent of this integration.
