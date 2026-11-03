#!/usr/bin/env tsx
// VIL-581 · prove a deploy's claim reader before CLAIM_READER_MODE moves. Calls the
// deployed /api/cron/claim-read-warm?mode=probe: eight synthetic cases (a false booking
// and a true-row control in en, fr, zh and es), no family data, no send. The first
// case's latency is the cold grammar compile under that deploy's key.
//
//   CRON_SECRET=… pnpm --filter @hale/web exec tsx scripts/probe-claim-reader.mts \
//     --url <app base url> [--i-mean-prod]
//
// CRON_SECRET comes from the environment only and is never printed. Any host that is not
// localhost needs --i-mean-prod (8 model calls on that deploy's key, ~$0.004).
// Exit 0: every verdict right. 1: a wrong verdict or a failed read. 2: not run (a
// Preview skip, a non-200, a body with no cases, or no answer at all).

import { probeExitFor } from '../lib/channel/reconcile/claim-read-probe';

const urlAt = process.argv.indexOf('--url');
const base = urlAt >= 0 ? process.argv[urlAt + 1] : undefined;
if (!base) {
  console.error('usage: probe-claim-reader.mts --url <app base url> [--i-mean-prod]');
  process.exit(64);
}
const host = new URL(base).hostname;
if (host !== 'localhost' && host !== '127.0.0.1' && !process.argv.includes('--i-mean-prod')) {
  console.error(`probe-claim-reader: refusing non-local host "${host}" without --i-mean-prod`);
  process.exit(64);
}
const secret = process.env.CRON_SECRET;
if (!secret) {
  console.error('probe-claim-reader: CRON_SECRET is not set');
  process.exit(64);
}

let status: number;
let body: unknown;
try {
  const response = await fetch(new URL('/api/cron/claim-read-warm?mode=probe', base), {
    headers: { authorization: `Bearer ${secret}` },
  });
  status = response.status;
  body = await response.json().catch(() => null);
} catch (err) {
  console.error(`probe: not run (no_answer: ${err instanceof Error ? err.name : 'unknown'})`);
  process.exit(2);
}
const { code, lines } = probeExitFor(status, body);
for (const line of lines) console.log(line);
process.exit(code);
