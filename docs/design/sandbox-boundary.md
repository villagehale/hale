# Sandbox boundary (VIL-387)

The authorized-signup runner on main is hands-only at the browser. Decisions, the consent check, parent confirmation, and stop rules stay in the backend. The browser receives a URL and then field name/value pairs. It does not receive credentials, tokens, or the family record.

This note describes `apps/web/lib/signup/` as it is on main after [PR #720](https://github.com/villagehale/hale/pull/720). [PR #725](https://github.com/villagehale/hale/pull/725) (durable slot grant, still a draft) is not merged. No flag default changes here. `AUTHORIZED_SIGNUP_ENABLED` stays off unless it is exactly `on` after trim (`apps/web/lib/signup/flag.ts`).

## Where the loop lives

`runAuthorizedSignup` in `apps/web/lib/signup/run.ts` is the loop. It runs in the web process. One turn does this, in order:

1. Read the flag. Off returns `flag_off` and does not claim the turn.
2. Require an explicit enroll phrase (`isExplicitSignupUtterance` in `apps/web/lib/signup/authorize.ts`). A bare "yes" is not an authorization.
3. Load the one pending offer (`loadPendingOffer` in `apps/web/lib/signup/store.ts`).
4. Choose the report door (`chooseReportDoor` in `apps/web/lib/signup/door.ts`). A result that would open a new 1:1 is held. The browser does not open.
5. `authorizeSignup` picks one session and checks the approved price against the family's busy intervals (`parent_calendar_blocks`, start and end only).
6. `loadSignupIdentity` reads the child, the parent, and the postal code. A teenager (`deriveStage` === `teenager`) stops with `teen_privacy` before any browser or handoff pack.
7. `registrationUrlAllowed` (`apps/web/lib/signup/url.ts`) refuses a URL that is not public https or loopback http.
8. `bookingRoute` (`apps/web/lib/signup/providers.ts`) sends a denylisted host to assisted handoff. `BOOKING_CONNECTORS` is empty, so every other allowed host takes the browser.
9. The backend calls `inspectRegistrationPage` (`apps/web/lib/signup/inspect.ts`), which calls `planBookingStep` (`apps/web/lib/signup/forms/plan.ts`). That function decides fill, continue, submit, or stop.
10. Only then does the backend call `page.fill` / `page.select` / `page.continue` / `page.submit`. At most three steps, same origin. The backend reads the next snapshot and decides again.
11. Every step writes `audit_log` with `action_taken = authorized_signup_step`. `redactSignupAudit` (`apps/web/lib/signup/audit.ts`) drops name, email, phone, postal, and value keys.

The browser does not choose the next step. A snapshot comes back. The backend returns a handback line, a completed line, or nothing when the door is held.

## What the sandbox is

The sandbox is `SignupBrowser` / `SignupPage` in `apps/web/lib/signup/types.ts`, implemented by `playwrightSignupBrowser` in `apps/web/lib/signup/browser.ts`. Playwright is loaded with `require('@playwright/test')` only when the flag is on and the route is the browser. If Chromium is missing, the backend returns `browser_unavailable`.

The page methods are the whole interface:

| Method | What the backend passes |
| --- | --- |
| `open(url)` | The already-allowed registration URL, as one string |
| `snapshot()` | Nothing. The page returns controls, prices, and flags |
| `fill(name, value)` | The HTML control name and the string `planBookingStep` already chose |
| `select(name, value)` | Same, for a `<select>` |
| `continue()` / `submit()` | No arguments |
| `close()` | Nothing |

`planBookingStep` classifies controls through the adapters in `apps/web/lib/signup/forms/adapters/`. The closed slot vocabulary is `FieldSlot` in `types.ts`:

`child_first_name`, `child_last_name`, `child_dob`, `parent_first_name`, `parent_email`, `postal_code`, `session`, `visit_date`, `party_size`, `seating_note`.

A required control outside that set stops as `unexpected_field`. An optional unknown control is left blank. Hidden, submit, and button controls are ignored. `child_dob` is filled only when the stored precision is `exact` (`loadSignupIdentity`). Phone is not a column on `SignupIdentity` and is not a slot. `signupInfoPack` (`apps/web/lib/signup/pack.ts`) is the assisted-handoff text, not a browser payload, and it omits phone and date of birth.

Chromium is launched with `--no-sandbox` and `--disable-dev-shm-usage` (`browser.ts`). That flag disables the OS sandbox so the process can start in a container. The hands-only rule is the application boundary above, not that Chromium flag.

## Consent, confirmation, and stop rules

On main, parent confirmation is the explicit phrase plus one session plus an approved price, recorded as `authorizingMessageId` on `authorized_signup_offers` when the offer leaves `pending` (`packages/db/src/schema/authorized-signup-offers.ts`, `markOffer` in `store.ts`). There is no `authorized_signup_consents` table in this tree. Draft PR #725 would write a row of slot names (no values) before the browser opens. Until that lands, the closed `FieldSlot` set is the list the runner is willing to type.

Stop reasons are `SignupStopReason` in `types.ts`. The ones enforced before a submit include: no offer, bare yes, ambiguous or full or unknown session, unapproved or changed price, payment, captcha, login or one-time-code, waiver, medical, allergy, waiting room, resident or identity verification, timed open-at, unexpected required field, missing detail, teen, URL refusal, browser missing, unconfirmed submit, a second attempt, and a result that would start a new 1:1. Payment and login classification live in `apps/web/lib/signup/forms/safety.ts`. A password control, or a control whose hay matches password / 2FA / OTP, returns `login_wall` before any fill.

`credentials` (`packages/db/src/schema/credentials.ts`) holds an argon2id password hash and a verification token for Hale login. The signup runner does not read that table.

## Connector path

`ConnectorBookingInput` in `providers.ts` includes the whole `SignupIdentity` (names, exact date of birth, email, postal code). That is an API call, not the browser. `BOOKING_CONNECTORS` is empty, so this path does not run. A future connector has to be narrowed to the same slot list before it is registered. This document does not add one.

## Test

`apps/web/lib/signup/sandbox-boundary.pglite.test.ts` drives `runAuthorizedSignup` with a recording browser.

- A class form with the four known slots, plus an optional `api_token` field and a hidden `csrf_token`, completes. `open` receives only the registration URL. `fill` and `select` receive two strings each. The control name is one of the `FieldSlot` names. The value is the child given name, the parent email, the postal code, or the session id. The child last name `tok_sandbox_secret`, the date of birth, and the parent display name `Test Parent` are absent from every browser argument.
- The same form with `type="password"` returns `login_wall`. `fill` and `select` are not called.

The assertion to add when PR #725 merges: the values typed are a subset of the slot names stored on `authorized_signup_consents` for that message, activity, and host, and a grant that is missing or short returns `consent_short` without calling `fill`.
