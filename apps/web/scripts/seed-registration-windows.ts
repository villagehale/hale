#!/usr/bin/env tsx
// Idempotent sync of the registration_windows table (the registration radar's dataset).
// Upserts the hand-VERIFIED list in lib/registration/registration-windows-data.ts on the
// (municipality, program_domain, cycle_label) natural key, so a re-run corrects a moved
// date in place and never duplicates a cycle. Safe to run repeatedly.
//
// Run against prod:
//   DATABASE_URL=... pnpm --filter @hale/web seed:registration-windows

import { createDb } from '@hale/db';
import { syncRegistrationWindows } from '../lib/registration/registration-windows';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const database = createDb({ connectionString: url });
const result = await syncRegistrationWindows(database);
console.log(`registration_windows sync: upserted ${result.count} window(s).`);
process.exit(0);
