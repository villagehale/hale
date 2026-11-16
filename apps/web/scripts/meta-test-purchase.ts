#!/usr/bin/env tsx
// Ops probe: one Meta CAPI Purchase tagged for Events Manager Test Events.
// Prints only HTTP status and events_received. Never prints the token, the
// test code, or the hashed payload.
//
//   pnpm meta:test-purchase
//
// Needs NEXT_PUBLIC_META_PIXEL_ID, META_CAPI_ACCESS_TOKEN, and
// META_CAPI_TEST_EVENT_CODE.

import { sendMetaTestPurchase } from '../lib/billing/conversions';

const result = await sendMetaTestPurchase();
if (result.status === 'skipped') {
  console.error(JSON.stringify({ status: result.status, reason: result.reason }));
  process.exit(1);
}
console.info(
  JSON.stringify({ status: result.status, events_received: result.events_received }),
);
process.exit(0);
