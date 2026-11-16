#!/usr/bin/env tsx
// Ops probe: one Meta CAPI Purchase tagged for Events Manager Test Events.
// Prints only HTTP status and events_received. Never prints the token, the
// test code, or the hashed payload.
//
//   pnpm meta:test-purchase
//   pnpm meta:test-purchase -- --tier max --currency USD
//
// --tier plus|max|family (default plus). --currency CAD|USD (default CAD).
// Values match the holiday promo yearly amounts.
//
// Needs NEXT_PUBLIC_META_PIXEL_ID, META_CAPI_ACCESS_TOKEN, and
// META_CAPI_TEST_EVENT_CODE.

import { sendMetaTestPurchase } from '../lib/billing/conversions';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

const result = await sendMetaTestPurchase(process.env, fetch, {
  tier: flag('--tier'),
  currency: flag('--currency'),
});
if (result.status === 'skipped') {
  console.error(JSON.stringify({ status: result.status, reason: result.reason }));
  process.exit(1);
}
console.info(JSON.stringify({ status: result.status, events_received: result.events_received }));
process.exit(0);
