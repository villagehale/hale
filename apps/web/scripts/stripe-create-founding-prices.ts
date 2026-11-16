#!/usr/bin/env tsx
// Idempotent Stripe bootstrap for the 2026 founding-family yearly prices
// (CAD 7900 / USD 5900, metadata promo=founding-2026) and the Plus USD list
// (monthly 1400 / yearly 11900, metadata list=plus-usd).
//
// Prints only newly created price ids as ENV=price_… lines. Existing tagged
// prices are left alone. Does not print the secret key.
//
//   pnpm stripe:create-founding-prices
//
// Needs STRIPE_SECRET_KEY. Do not commit the output.

import {
  ensurePromoPrices,
  formatCreatedPriceIds,
  stripeCatalogApiFromSecret,
} from '../lib/billing/create-prices';

const secret = process.env.STRIPE_SECRET_KEY;
if (!secret) {
  console.error('STRIPE_SECRET_KEY is not set.');
  process.exit(1);
}

const result = await ensurePromoPrices(stripeCatalogApiFromSecret(secret));
const printed = formatCreatedPriceIds(result);
if (printed) process.stdout.write(`${printed}\n`);
process.exit(0);
