# Review guide

Read by Devin Review and by every agent that reviews a pull request here.

**What is severe: the hard rules in `CLAUDE.md`.** Read them before reviewing:
- privacy and teen data;
- consent before any autonomous action;
- two-parent consent;
- the immutable audit row;
- spending caps;
- additive migrations;
- prompts loaded by name;
- named outcomes for an absent dependency.

Treat as severe any change that weakens one of them, and any new path that bypasses the code enforcing one. The code's own comments say how each rule is enforced. **This repository is public:** flag any real name, phone number, email or id in code, fixtures, PR text or commit messages.

## Intended: don't flag these as bugs

- **No fixed parent-facing copy.** A model writes replies from facts the code supplies. A missing fallback sentence is intended: when the model fails, the turn holds and the failure is a named, logged outcome.
- **No keyword or regex reading of parent messages, STOP included.** Intent comes from model readings. Pattern checks on Hale's own outgoing text (a link gate, a number check) are fine.
- **No numeric send caps.** The model and the decider choose timing and volume. The code rails are intended: opt-out, quiet hours, same-item dedupe, provider rate limits and line health.
- **Absence is a first-class outcome.** A dependency that may be missing is logged and named in the return value (for example `skipped: 'not_configured'`). **Do** flag a silent no-op, or an absence folded into an outcome that means something else.
- **Fail closed.** When identity, audience, time zone, place or consent is unknown, Hale holds or asks instead of guessing.
- **Tests and models.** Model behaviour is tested with cached real recordings through the eval harness, never with mocked model output. The repo's convention allows a fake at a client port that tests request mechanics only and says so (for example `apps/web/lib/testing/kid-judge-client.ts`). **Do** flag a stub that stands in for the model's judgement.
- **Recorded decisions.** A limit that the PR body, a ticket or a comment records as a decision ("Known limitation", "Stated limit", a design ruling) is not a new bug. Flag it only when the stated limit is wrong or the code exceeds it. A recorded decision never exempts a hard rule.
- **Migrations** are hand-written, additive SQL in `packages/db/drizzle`. A missing *generated* migration is intended. A schema change without its hand-written SQL is a bug.
- **Dark features.** Code behind a flag that is off is still reviewed; say in the finding that it is behind a flag.
- **Holiday 2026 founding checkout.** Founding is a Stripe yearly price (CAD 7900 / USD 5900), locked for life — not a first-year coupon. Hale-web and leftover marketing list copy use a plain `$` with a CAD/USD note from the same geo-IP currency. During the window (including `PROMO_PREVIEW_FAMILY_IDS` testers and `/founding?preview=`), Plan and `/founding` show only Free and founding annual — never monthly, regular annual, or a disabled/greyed list option. After `2027-01-01 00:00` America/Toronto, Plan list checkout offers monthly and yearly again. Refunds are a full refund of the latest paid charge anytime (`stripe:refund-family` omits `amount`). The cutoff only stops NEW founding checkouts; existing founding subscriptions keep that price. No referral program and no gift-a-year in this promo. Checkout 404s until `HOLIDAY_PROMO_ENABLED` is exactly `true`, except listed preview families / matching `PROMO_PREVIEW_TOKEN`. Ads new-visitor join (`/founding`, OTP, pending family, Stripe) is a second default-off flag, `PROMO_NEW_VISITOR_CHECKOUT_ENABLED`; Hale does not text first after payment — the success page and already-paid state show a Linq `sms:` link. Duplicate **live** subscriptions are refused (`already_paid` on plus/family). A leftover `stripeSubscriptionId` after cancel/delete is not live; that family can check out again on the reused Stripe Customer. Stripe Idempotency-Key is not a lifetime lock (Checkout bodies include ads IP/UA). Two overlapping unpaid Checkout Sessions before the first webhook is a recorded limit. During the window every new checkout is the founding yearly price for that currency — `resolveCheckoutPrice` ignores `period: 'monthly'` and list annual even when `STRIPE_PRICE_PLUS_MONTHLY` / `STRIPE_PRICE_PLUS_MONTHLY_USD` are set; a crafted `POST /api/billing/checkout` is rewritten to founding by geo or refused; a missing founding id is unavailable, never a silent list charge. `STRIPE_PAYMENT_LINK_ID` / `STRIPE_PAYMENT_LINK_TIER` are never served or redirected to during the window. A paid Checkout Session whose line-item / `metadata.priceId` is not founding (or a Payment Link with no visible founding price) does not grant Plus: the webhook claims the event, writes `billing_refund_ready` with the Stripe subscription id (ids only), names the #ops outcome on `refund_ready` (`sent` / `failed` / `skipped_not_configured`) so a skipped page is not counted as delivered, and does not auto-refund. Later `subscription.updated` / `invoice.paid` for that subscription id do not grant Plus (`blocked`, no second alert). The grant clock is Stripe `event.created`, not webhook receipt time. Preview testers keep `/founding` after Stripe cancel via an HttpOnly `hale_promo_preview` cookie; the cancel URL never carries `?preview=`. PostHog does not load on `/founding?preview=` and `before_send` redacts `preview=` the same way it redacts `/l/<code>`. `pnpm stripe:promo-lockdown` lists active Payment Links and open non-founding Checkout Sessions; `--apply` deactivates/expires them (ids and counts only). Stdout is the record: Payment Links and open Checkout Sessions are not family-scoped, so there is no `audit_log` row (same class as `stripe:create-founding-prices`). `/checkout/success` claims “You’re in.” only after the server verifies a paid Checkout Session. Ads click cookies, client IP, and user agent live on Stripe session metadata only, never on Attribution and never in PostHog. Meta Pixel PageView on villagehale.com needs `NEXT_PUBLIC_CONVERSIONS_API_ENABLED` at site build time (static layout); the product app still accepts `CONVERSIONS_API_ENABLED`. Google Ads stays off the product app. CAPI is dormant without `META_CAPI_ACCESS_TOKEN`. Preview-family CAPI is skipped unless `META_CAPI_TEST_EVENT_CODE` is set (then it may send even if `META_CAPI_ENABLED` is off). Optional `META_CAPI_TEST_EVENT_CODE` on CAPI payloads and `pnpm meta:test-purchase` (prints only status and events_received) are intended for Events Manager Test Events.

## Ignore

- `apps/worker/evals/cache/**` and `apps/web/lib/__journey__/__recordings__/**`: recorded model output.
- `apps/web/lib/channel/off-domain/postal-cities/ca.json`, `postal-cities/us.json`, `apps/web/lib/channel/off-domain/public-suffix/suffixes.json` and `public-suffix/public_suffix_list.dat`: generated or vendored tables.
- `pnpm-lock.yaml`.

Not ignored, even though it looks like data:
- `apps/web/lib/channel/off-domain/postal-cities/coarsen.json` is the privacy allowlist of place names that may go to third-party search on a sensitive question. A small town moved onto it would reveal where a family lives.
- `apps/web/lib/channel/intake/postal-zone.ts` is hand-written logic.
