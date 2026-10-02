# Per-family Hale inbox (VIL-390)

Proposal only. No route, no schema change, no migration, and no flag default change. A parent forwards a booking receipt to a Hale address. Hale reads that message and does not read the rest of the mailbox.

Booked detection today reads connected Gmail (`syncGmail` in `apps/web/lib/integrations/sync.ts`, then `alertParentForGmailSweep` in `apps/web/lib/integrations/email-alert.ts`) and decides with `bookingDraft` (`apps/web/lib/integrations/booking.ts`). `BOOKED_DETECTION_ENABLED` and `BOOKED_DETECTION_FAMILY_ALLOWLIST` stay as they are (`apps/web/lib/integrations/booked.ts`). Signup is a different door: `BOOKING_CONNECTORS` is empty (`apps/web/lib/signup/providers.ts`), `bookingConnectors()` adds the sandbox connector only when `BOOKING_REFERENCE_CONNECTOR_ENABLED` is exactly `on` (`apps/web/lib/signup/connectors/registry.ts`), and a failure is `connector_failed` with no browser (`apps/web/lib/signup/run.ts`). A forwarded receipt does not call a connector.

## Address scheme

`forwardAddress` (`apps/web/lib/channel/email/forward-address.ts`) builds `hale+<token>@<inbound domain>`. The token is 15 bytes, 30 lowercase hex characters, 120 bits, on `families.inbound_forward_token` (unique; `packages/db/src/schema/families.ts`). The domain is `HALE_INBOUND_EMAIL_DOMAIN` (`apps/web/lib/channel/email/config.ts`), a second secret beside `ics_share_token`.

`mintForwardToken` returns an existing token unchanged, so rotation is not built. `revokeForwardToken` nulls the column; `familyForForwardToken` then resolves nothing. A later ticket writes a new 120-bit value over the same column. Lookup is equality on the current value, so the previous address no longer resolves (`forward_unknown_token`) and the old token is not kept. `forwardRecipient` reads `hale+<token>` (the document; the token is the family) and `hale+<token>.<ref>` (an answer; `<ref>` is 8 hex). A malformed tag is refused at the forward door and does not fall through to the reply door. This proposal uses the document form only.

## Sender verification

Two sends already arrive (`apps/web/lib/channel/email/forward.ts`, `apps/web/lib/channel/email/forward-parse.ts`). A filter auto-forward has no banner: envelope `From` is the school, the family is the token, and the school domain is `pending`, `allowed`, or `blocked` on `family_forward_senders` (`packages/db/src/schema/email-forwards.ts`). Allowed ends at `forward_ready` and stores nothing. DKIM (`assessSenderTrust` in `apps/web/lib/channel/email/trust.ts`) runs on the answer branch only. A manual forward has a banner; `parseForwardedMessage` reads the original `From` and subject, and the envelope `From` is the parent. The receipt inbox is this second case only.

Before any extraction:

1. Resolve the token. Unknown or revoked stays `forward_unknown_token`, with no row and no fallthrough to the reply door.
2. Envelope `From` must pass `assessSenderTrust`: our MTA's `Authentication-Results` (`HALE_INBOUND_AUTHSERV_ID`) and DKIM aligned with the `From` domain. SPF is parsed and does not decide.
3. That address must match `users.email` for a `primary_parent` or `co_parent` of that family (`resolveEmailSender` in `apps/web/lib/channel/email/identity.ts`; `PARENT_ROLES` in `apps/web/lib/channel/email/forward.ts`). Any other `From` is refused, stored nowhere, and not answered. A school auto-forward fails here on purpose and stays on the allowlist door.
4. `parseForwardedMessage` must return `originalFrom`. Today's document branch fills a missing banner from the envelope (`parsed.originalFrom ?? input.sender.address` in `apps/web/lib/channel/email/forward.ts`). The receipt path must not. A missing banner is `original_sender_unread`. The parent address verifies the sender. The provider domain is the document.

## Parsing and dedupe

`classifyChildEventEmail` (`apps/web/lib/sentinel/pipeline.ts`) classifies the Gmail envelope. The body is `fetchGmailMessageBody` (`apps/web/lib/sentinel/fetch-body.ts`), passed in from `apps/web/lib/cron/connector-sync.ts`. `guardBookingConfirmation` (`apps/web/lib/sentinel/booking-guard.ts`) rewrites a waitlist, a registration-opens notice, or a reminder-only subject to `reminder_only`. `bookingDraft` then requires kind `booking_confirmation`, confidence at least `BOOKING_CONFIDENCE_FLOOR` (0.7), a title, a future first session, and neither teen-content nor teen-attributed. The inbox calls that same pair on the parsed original subject and body, the original sender, and the family id. The parent id is the verified user.

A forward cannot insert yet. `integration_id`, `message_id`, and `channel_message_id` are `NOT NULL`, and `(integration_id, message_id)` is unique (`packages/db/src/schema/activity-bookings.ts`). A forward has no `integrations` row, and `recordActivityBooking` runs after a send (`apps/web/lib/integrations/booking.ts`). Gmail ids and Resend Message-IDs differ, so that pair does not collapse them. Until a later migration names a source, compute a draft and do not insert. `forward_ready` stays the outcome for an allowed sender.

The class key from [PR #723](https://github.com/villagehale/hale/pull/723) is on main. `bookingDedupeKey` is `host|canonical title|UTC date`. `activity_bookings_dedupe_uniq` is one live row per `(family_id, dedupe_key)`. A match refreshes the oldest row; `recordBooking` writes `activity_booking_recorded` only on insert (`apps/web/lib/integrations/email-alert.ts`). `sessionKey` (`apps/web/lib/integrations/going.ts`) is the full instant, not that constraint. A Gmail receipt and a later forward match on the banner's domain, `canonicalBookingTitle`, and the UTC date. Refresh leaves `parent_user_id` with the first writer. `bookedDetectionEnabledFor` still gates the write; off is `booked_dark`.

The webhook is `apps/web/lib/channel/email/inbound.ts`. `email.received` is metadata; the body is fetched with `RESEND_API_KEY` (`apps/web/lib/channel/email/content.ts`) after the Svix check (`apps/web/lib/channel/email/signature.ts`). A missing inbound env var is a 503 (`apps/web/lib/channel/email/config.ts`). Idempotency is `(family, Message-ID)` via `forwardClaimKey` (`apps/web/lib/channel/email/forward-address.ts`).

## Spam, size, attachments, retention

Already enforced (`apps/web/lib/channel/email/inbound.ts`, `apps/web/lib/channel/email/forward.ts`): a bad signature is a 403 with no fetch; `forward_family_dark`; `self` and `bounce` are `forward_machine` (bulk stays on the document branch); `forward_sender_blocked` stores nothing. `email-forward` is 20/hour per family, on top of `email-inbound` at 30/hour per sender (`apps/web/lib/rate-limit/config.ts`). Pending bodies in `email_forwards_pending` drop after 72 hours (`PENDING_FORWARD_TTL_MS` in `apps/web/lib/channel/email/forward-purge.ts`, cron `/api/cron/attachment-sweep`). Allowed and blocked rows stay. Logs carry outcomes and ids, not bodies (`apps/web/lib/channel/email/forward.ts`).

`parseInboundEmailEvent` counts attachments and does not fetch them (`apps/web/lib/channel/email/payload.ts`). `createResendContentReader` fetches text, html, and headers (`apps/web/lib/channel/email/content.ts`). No byte cap exists under `apps/web/lib/channel/email/`. Proposed: cap plain text at 100 KB (`forward_too_large`, no store, no model call) and do not fetch attachment bytes. `revokeForwardToken` kills the address. `runDeletionSweep` (`apps/web/lib/rights/delete.ts`) deletes the family; `activity_bookings`, `email_forwards_pending`, and `family_forward_senders` cascade.

## Gmail and VIL-371

VIL-371 lights `BOOKED_DETECTION_ENABLED` after a live mailbox probe. That probe is Gmail: `CONNECTOR_SCOPES.gmail` is `https://www.googleapis.com/auth/gmail.readonly` (`apps/web/lib/integrations/google-oauth.ts`), and `syncGmail` lists `users/me/messages` and history. The inbox does not ask for that scope, so a family that only forwards never grants `gmail.readonly`. The connector stays for a parent who wants it. This note does not flip the flag.

## Copy for Sloane

Placeholder only. Not sent. Not a template key. `apps/web/lib/channel/email/forward-copy.ts` still sends the allowlist questions. These lines are not among them.

- TODO-Design: the line that gives a parent their Hale address and says a booking receipt can be forwarded there.
- TODO-Design: the line that says Hale reads that forwarded receipt and does not read the rest of the mailbox.
- TODO-Design: the line when a forward could not be read as a booking.
- TODO-Design: the line after the address is replaced, saying the previous address no longer accepts mail.

## Open questions and tickets

Nothing here changes a flag. Each ticket defaults off. Still open: the follow-up staying on the first writer's `parent_user_id`; a PDF-only receipt; whether 100 KB is the right cap; the receipt check as a branch beside `document()` in `apps/web/lib/channel/email/forward.ts`, so the school allowlist stays.

1. `FAMILY_INBOX_BOOKING_ENABLED`, exact `true`, unset means off (the same read as `bookedDetectionEnabled`). Parent check, banner required, `classifyChildEventEmail` and `bookingDraft`, no insert. Off leaves `forward_ready` and the allowlist unchanged.
2. An additive source key so a forward can call `recordActivityBooking`. The write still needs booked detection for that family and this flag.
3. The size cap and the attachment refusal, behind the same flag.
4. Token rotation: one update of `inbound_forward_token` and one audit row, only when a parent asks.
5. Sloane's lines, still unsent until a later ticket wires a template.
