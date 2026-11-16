#!/usr/bin/env tsx
// Ops path: full refund of a family's latest paid Stripe charge (no amount,
// no window), then cancel the subscription. Dry-run unless --apply is passed.
// Prints ids and named outcomes only — no parent-facing copy, no secrets.
//
//   pnpm stripe:refund-family -- --family <family-uuid>
//   pnpm stripe:refund-family -- --family <family-uuid> --apply
//
// Needs DATABASE_URL and STRIPE_SECRET_KEY.

import { createDb } from '@hale/db';
import { refundFamilyLatestPayment, stripeRefundApiFromEnv } from '../lib/billing/refund-family';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const familyAt = process.argv.indexOf('--family');
const familyId = familyAt === -1 ? null : process.argv[familyAt + 1];
if (!familyId) {
  console.error('usage: pnpm stripe:refund-family -- --family <family-uuid> [--apply]');
  process.exit(1);
}

const database = createDb({ connectionString: url });
const result = await refundFamilyLatestPayment({
  familyId,
  apply: process.argv.includes('--apply'),
  database,
  stripe: stripeRefundApiFromEnv(),
  actor: 'ops',
});
console.info(JSON.stringify(result));
process.exit(result.status === 'failed' ? 1 : 0);
