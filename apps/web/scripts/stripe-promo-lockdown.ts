#!/usr/bin/env tsx
// Lists every active Stripe Payment Link and every open Checkout Session whose
// price is not one of the four holiday promo yearly ids. Dry-run unless
// --apply is passed: then it deactivates those links and expires those
// sessions. Prints ids and counts only — never the secret key, never customer
// PII.
//
//   pnpm stripe:promo-lockdown
//   pnpm stripe:promo-lockdown -- --apply
//
// Needs STRIPE_SECRET_KEY. Promo ids come from
// STRIPE_PRICE_PROMO_{PLUS,MAX}_ANNUAL_{CAD,USD} (Plus also reads leftover
// STRIPE_PRICE_FOUNDING_ANNUAL_*).

import { promoPriceIdsFromEnv } from '../lib/billing/prices';
import { runPromoLockdown, stripePromoLockdownApiFromSecret } from '../lib/billing/promo-lockdown';

const secret = process.env.STRIPE_SECRET_KEY?.trim();
if (!secret) {
  console.error('STRIPE_SECRET_KEY is not set.');
  process.exit(1);
}

const result = await runPromoLockdown({
  api: stripePromoLockdownApiFromSecret(secret),
  foundingPriceIds: new Set(promoPriceIdsFromEnv()),
  apply: process.argv.includes('--apply'),
});
console.info(JSON.stringify(result));
process.exit(0);
