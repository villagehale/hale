# Per-family Hale inbox (VIL-390)

Proposal only. No route, no flag, and no schema change. Parents would forward a booking receipt to the Hale address the family already has. Hale would read that message and no other mail in the parent's mailbox.

Booked detection today reads Gmail through a connected integration (`alertParentForGmailSweep` in `apps/web/lib/integrations/email-alert.ts`). This design is the forward path into the same `bookingDraft` decision (`apps/web/lib/integrations/booking.ts`). `BOOKED_DETECTION_ENABLED` and `BOOKED_DETECTION_FAMILY_ALLOWLIST` stay as they are (`apps/web/lib/integrations/booked.ts`).

## Address scheme

The address already exists. `apps/web/lib/channel/email/forward-address.ts` mints `hale+<token>@<inbound domain>` and stores the token on `families.inbound_forward_token` (unique, lowercase hex, 30 characters, 120 bits). The domain is `HALE_INBOUND_EMAIL_DOMAIN` (`apps/web/lib/channel/email/config.ts`). Nulling the column revokes the address.

Two local-part shapes are already parsed:

- `hale+<token>` — a forwarded document. The token is the family. Envelope `From` is not the family id.
- `hale+<token>.<ref>` — an answer about one pending sender. `<ref>` is 8 hex characters on `family_forward_senders.ref`.

This proposal uses the document form as the family inbox. It does not add a second token. A raw family id in the local part would be a write handle; the existing comment in `forward-address.ts` is why the token is a secret.

The reply door (a parent writing Hale, `From` is the identity) stays on the same webhook and the same domain. `forwardRecipient` returns `reply`, `forward`, or `malformed` so a broken `hale+` tag cannot fall through and be treated as a reply.

## Sender verification

Two different sends arrive at this address today (`apps/web/lib/channel/email/forward.ts` and `forward-parse.ts`).

A Gmail filter auto-forward has no banner. Envelope `From` is the school. DKIM, when it passes, attests the school. The family is the token. The school domain is allowlisted per family on `family_forward_senders` (`pending` / `allowed` / `blocked`), with a matching `consent_records` row when the parent says yes. An allowed sender currently ends at `forward_ready`: the comment says no summariser is wired, and nothing is stored.

A manual forward has a banner (`---------- Forwarded message ----------`, `Begin forwarded message:`, or `---------- Original message ----------`). `parseForwardedMessage` reads the original `From` and subject from that banner. The envelope `From` is the parent's mailbox.

The receipt inbox uses the manual-forward case only.

Proposed check, before any extraction:

1. Resolve the token to a family. Unknown token stays `forward_unknown_token` and does not fall through to the reply door.
2. Require an envelope `From` that `assessSenderTrust` (`apps/web/lib/channel/email/trust.ts`) accepts: our MTA's `Authentication-Results` (`HALE_INBOUND_AUTHSERV_ID`), DKIM aligned with the `From` domain. SPF is parsed and does not decide, because forwarding breaks SPF.
3. That address must equal `users.email` for a `primary_parent` or `co_parent` of the token's family. Any other `From` is refused and stored nowhere. A school auto-forward fails this check on purpose. It keeps the existing sender-allowlist door and does not become a booking.
4. `parseForwardedMessage` must return an `originalFrom`. That domain is the provider host passed to booked detection. A missing banner is refused on this path (`original_sender_unread`), not filled in with the parent's address.

The parent's own address is the verification. The provider's address is the document.

## How it feeds booked detection

The Gmail sweep classifies an envelope with `classifyChildEventEmail` and then `bookingDraft` (`email-alert.ts` → `booking.ts`). A draft requires kind `booking_confirmation`, confidence at least `BOOKING_CONFIDENCE_FLOOR` (0.7), a title, a future first session, and neither teen-content nor teen-attributed. The row is `activity_bookings`.

The inbox path, once built, calls that same pure function and no second classifier. The input is the parsed original subject and body, the original sender's domain, and the family id from the token. The parent id is the verified `users` row, which is who a follow-up may text (`activity_bookings.parent_user_id`).

What blocks a write today, so this proposal does not pretend a forward can insert a row:

- `activity_bookings.integration_id` is `NOT NULL` and is the Gmail connection id. A forward has no `integrations` row. The unique key is `(integration_id, message_id)` (`packages/db/src/schema/activity-bookings.ts`).
- `channel_message_id` is also `NOT NULL`, and the booking is written after a send (`booking.ts`).

Until a later migration gives a forward a source key, the inbox path may compute a draft and must not insert `activity_bookings`. That migration is out of scope here. `forward_ready` remains the live outcome for an allowed sender: nothing is summarised and nothing is stored (`forward.ts`).

`BOOKED_DETECTION_ENABLED` still gates the write. A forward that arrives while the flag is off for that family produces no booking row, the same as a Gmail receipt.

## Dedupe with the VIL-371 hardening

[PR #723](https://github.com/villagehale/hale/pull/723) is open and not merged. It is the dedupe this inbox has to share. On main, two emails with different message ids insert two bookings. The session string in `sessionKey` (`apps/web/lib/integrations/going.ts`) is `host|folded title|instant` and is not a unique constraint.

The PR's class key, as its description states it, is one live row per `(family, sender domain, canonical title, UTC date of the first session)`. A later receipt updates the oldest live row and does not write a second `activity_booking_recorded` audit. It also rewrites a waitlist, a "registration opens" notice, or a reminder-only subject to `reminder_only` after extraction, so those do not become "you're in".

When that key exists, a Gmail receipt and a later forward of the same class must hash to the same key. The forward uses the original sender domain from the banner, the same title fold, and the UTC date of the first session. The inbox path calls the same post-extraction guard before `bookingDraft`. A forward must not invent a second `message_id` identity that bypasses the class key.

Until #723 is merged, those names (`dedupe_key`, `guardBookingConfirmation`) are not in this tree. The inbox does not ship a private dedupe beside them.

## Resend inbound

The webhook is the one in `apps/web/lib/channel/email/inbound.ts`. Resend `email.received` carries metadata only. The body and headers are fetched with `RESEND_API_KEY` (`apps/web/lib/channel/email/content.ts`). Signature is Svix (`svix-id`, `svix-timestamp`, `svix-signature`) checked in `apps/web/lib/channel/email/signature.ts` against `RESEND_INBOUND_WEBHOOK_SECRET` before parse or fetch.

The leg is all-or-nothing. Missing any of `RESEND_API_KEY`, `RESEND_INBOUND_WEBHOOK_SECRET`, `HALE_INBOUND_EMAIL_DOMAIN`, or `HALE_INBOUND_AUTHSERV_ID` yields a 503 and the leg stays dark (`config.ts`). A transient content fetch returns 5xx so Svix retries. A permanent failure does not.

Idempotency for a forward is `(family, Message-ID)` via `forwardClaimKey`, because the school's Message-ID is shared across households. A Resend redelivery of one household's forward must not extract twice.

Outbound Resend (verification mail, health digest, calendar invite) uses `createResendTransport` and is a different key use. This design does not send from the inbound address except the existing sender-allowlist questions (`forward-copy.ts`).

## Spam and abuse

Already on the forward door:

- Signature failure costs no fetch and no write (`inbound.ts`).
- Unknown or revoked token: `forward_unknown_token`.
- Malformed `hale+` tag: stops at the forward door.
- Family not on F14: `forward_family_dark`.
- `self` and `bounce` machine mail: `forward_machine` (`forward.ts`). Bulk mail is kept for the document branch, because a camp receipt is bulk. The receipt inbox still requires the parent-`From` check above, so a school's bulk send does not enter it.
- Rate limit `email-forward`: 20 per hour (`apps/web/lib/rate-limit/config.ts`).
- Blocked sender domain: `forward_sender_blocked`, nothing stored.
- Pending raw bodies live in `email_forwards_pending` and are deleted after 72 hours (`PENDING_FORWARD_TTL_MS` in `apps/web/lib/channel/email/forward-purge.ts`), along with a pending question nobody answered. Allowed and blocked decisions are kept.
- Logs carry outcome names and ids. Bodies, subjects, and addresses are not logged (`forward.ts`).

Proposed, not built:

- Reject the receipt path when envelope `From` is not a verified parent of that family.
- Cap the fetched body. No byte cap was found under `apps/web/lib/channel/email/`. A cap of 100 KB, with outcome `forward_too_large` and no store, is the proposal.
- A parent who forwards mail that is not a booking gets the same handback as any other non-confirmation: `bookingDraft` returns `not_a_booking` and no row is written.

## Parent-facing line

Placeholder only. Not sent. Not wired to a template key.

TODO-Design for Sloane: the sentence that tells a parent they can forward a booking receipt to their Hale address, and that Hale will not read the rest of their mailbox.
