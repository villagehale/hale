#!/usr/bin/env tsx
// Lists every active Stripe Payment Link and every open Checkout Session whose
// price is not a founding yearly id. Dry-run unless --apply is passed: then it
// deactivates those links and expires those sessions. Prints ids and counts
// only — never the secret key, never customer PII.
//
//   pnpm stripe:promo-lockdown
//   pnpm stripe:promo-lockdown -- --apply
//
// Needs STRIPE_SECRET_KEY. Founding ids come from STRIPE_PRICE_FOUNDING_ANNUAL_*.

import { foundingPriceIdsFromEnv } from '../lib/billing/prices';
import { runPromoLockdown, stripePromoLockdownApiFromSecret } from '../lib/billing/promo-lockdown';

const secret = process.env.STRIPE_SECRET_KEY?.trim();
if (!secret) {
  console.error('STRIPE_SECRET_KEY is not set.');
  process.exit(1);
}

const result = await runPromoLockdown({
  api: stripePromoLockdownApiFromSecret(secret),
  foundingPriceIds: new Set(foundingPriceIdsFromEnv()),
  apply: process.argv.includes('--apply'),
});
console.info(JSON.stringify(result));
process.exit(0);
