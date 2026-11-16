#!/usr/bin/env tsx
// Idempotent Stripe bootstrap for the 2026 holiday promo yearly prices
// (Plus CAD 5900 / USD 3900, Max CAD 9900 / USD 7900, metadata
// promo=holiday-2026, lookup_key hale_promo_{plus|max}_annual_{cad|usd}),
// the Plus USD list (monthly 1400 / yearly 11900, metadata list=plus-usd),
// and Max list annual after the cutoff (CAD 32900 / USD 25900, product Hale Max,
// lookup_key hale_list_max_annual_{cad|usd}, metadata list=max-cad / max-usd).
//
// Dry-run by default. Pass --apply to create missing products/prices.
// Prints only newly created price ids as ENV=price_… lines. Existing tagged
// prices are left alone. Does not print the secret key.
//
//   pnpm stripe:create-founding-prices
//   pnpm stripe:create-founding-prices -- --apply
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

const apply = process.argv.includes('--apply');
const result = await ensurePromoPrices(stripeCatalogApiFromSecret(secret), { apply });
if (!apply) {
  process.stderr.write(
    `dry-run: ${result.wouldCreate.length} price(s) would be created. Pass --apply to create.\n`,
  );
  if (result.wouldCreate.length > 0) {
    process.stderr.write(`${result.wouldCreate.join('\n')}\n`);
  }
}
const printed = formatCreatedPriceIds(result);
if (printed) process.stdout.write(`${printed}\n`);
process.exit(0);
