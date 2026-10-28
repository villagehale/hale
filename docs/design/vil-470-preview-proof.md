# VIL-470 fake-family Preview proof

A dry plan. No real family, no SMS, no live Browser Use, no Link, no Anthropic
call. `BROWSER_USE_SIGNUP_PAYMENT_ENABLED` stays unset.

The production seams this run would exercise are already pinned by tests:

| Step | What happens | Code |
| --- | --- | --- |
| 1. Hale sees facts | An email, calendar, flyer, or chat excerpt — never a template | `offerSignupFromFacts` `apps/web/lib/signup/offer-from-facts.ts:55` |
| 2. Hale writes the offer | Skill `signup-offer`, no `offer-copy.ts` sentence | `createSignupOfferWriter` `apps/web/lib/signup/offer-writer.ts:96` |
| 3. The offer is recorded | `recordSignupOffer` + `audit_log` | `recordSignupOffer` `apps/web/lib/signup/store.ts:12`; called from `offer-from-facts.ts:104` |
| 4. Parent sign-in is captured | Encrypted cookies, password-named keys refused | `captureProviderSession` `apps/web/lib/signup/session-capture.ts:22`; POST `apps/web/app/api/signup/provider-session/route.ts:22` |
| 5. Parent yes | Consent model + `runAuthorizedSignup` | `runAuthorizedSignup` `apps/web/lib/signup/run.ts:150` |
| 6. Browser Use stops at checkout | Payment flag off → wallet is null | `signupPayment` `apps/web/lib/signup/run.ts:795`; Harbor Rec `/demo/signup-test` |

## Preview-only Harbor Rec form

Served at `/demo/signup-test` on Preview and local. Production 404s:

- Demo tree gate: `apps/web/app/demo/layout.tsx:33` (`portalDemoEnabled`, off when `VERCEL_ENV=production`)
- Form gate: `signupTestFormEnabled` `apps/web/lib/signup/test-form.ts:46`
- Login: `/demo/signup-test/login` → POST `/api/demo/signup-test/login` (any email + password)
- Register: `/demo/signup-test/register` — `child_first_name`, `parent_email`, `postal_code`, `session`
- Checkout: `/demo/signup-test/checkout` — card fields present; Pay posts to `/api/demo/signup-test/pay`, which never charges

Browser Use would open the Preview URL, sign in, pick **Tue 4:30**, fill the child and parent slots, and stop on checkout. It must not type a card.

## Fake-family run (Preview, operator-driven)

Do not point Preview `DATABASE_URL` at production. Do not set Linq, Anthropic,
AI Gateway, or Browser Use keys for a dry rehearsal. For a live Preview proof
later, Barton prices Browser Use first (VIL-453).

1. Seed one fake family, one parent, one toddler (not a real household).
2. Sign in on `/demo/signup-test/login`. Capture the `hale_signup_test_session` cookie as Playwright `storageState` (`signupTestStorageState` in `test-form.ts`).
3. POST that state to `/api/signup/provider-session` as the fake parent (`providerHost` = the Preview host). Password-named cookies are refused.
4. Open the fake parent's thread (Preview capture transport, not SMS: `apps/web/lib/channel/preview-capture-transport.ts`). Hand Hale facts that already contain the Preview register URL — an email excerpt, a calendar title, a flyer line, or the parent's own chat.
5. With `AUTHORIZED_SIGNUP_ENABLED=on`, the coach may call `offer_signup` (`apps/web/lib/signup/offer-tool.ts:67`). The writer returns the parent-facing text. `recordSignupOffer` stores the pending row.
6. The parent answers in their own words. `runAuthorizedSignup` reads consent (skill `signup-consent`, no word list).
7. With `BROWSER_USE_SIGNUP_ENABLED=true` and payment unset, the engine seeds the captured session, fills Harbor Rec, and returns `reached_checkout`. Audit names the outcome and the host, never the live-view token or the child.

A unit stand-in of steps 3–7 (no network) is `lets a parent yes run to reached_checkout with payment off` in `apps/web/lib/signup/offer-from-facts.pglite.test.ts` (the `reached_checkout` case).

## Meaning-based eval

`apps/worker/evals/signup-offer-fixtures.mjs` — four fixtures (email, calendar, flyer, chat). Each has `mustMean` lines a judge would score. No expected sentence.

Dry worst case (this PR):

```
cd apps/worker && node evals/signup-offer-eval.mjs --estimate
```

Prices the writer at `max_tokens`. Live API calls: 0. Nothing written.

Scoring those lines would be a paid Claude call. This branch does not make it.
