#!/usr/bin/env tsx
// The CLI shell around seedCanaryHousehold (lib/channel/canary/seed.ts): the
// guard, and nothing else. The writes live in lib/ because they are a consent +
// audit obligation on the production roster and have to be testable — a script
// under scripts/ is outside the vitest include.
//
// Unlike seed-e2e-smoke.ts this one is MEANT for prod, so the guard is inverted:
// a non-local DATABASE_URL needs an explicit --i-mean-prod.

import { createDb } from '@hale/db';
import { seedCanaryHousehold } from '../lib/channel/canary/seed';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('seed-inbound-canary: DATABASE_URL is not set.');
  process.exit(1);
}
const host = new URL(url).hostname;
const isLocal = host === 'localhost' || host === '127.0.0.1';
if (!isLocal && !process.argv.includes('--i-mean-prod')) {
  console.error(
    `seed-inbound-canary: refusing non-local database host "${host}" without --i-mean-prod — this writes a real household to the roster.`,
  );
  process.exit(1);
}

const result = await seedCanaryHousehold(createDb({ connectionString: url }));

if (result.status === 'inactive') {
  console.error(
    `seed-inbound-canary: the canary channel exists on family ${result.familyId} but is not active (never verified, or revoked). Re-activate it deliberately; the canary claims nothing while it is in this state.`,
  );
  process.exit(1);
}

// Printed for the run log only: nothing reads a canary family id from an env
// var — both halves resolve the household through the blind index.
console.log(`seed-inbound-canary: ${result.status}. family=${result.familyId}`);
process.exit(0);
