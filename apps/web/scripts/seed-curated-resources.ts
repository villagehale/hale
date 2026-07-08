#!/usr/bin/env tsx
// Idempotent seed of the curated_resources table (the Village "Resources" rail).
// Upserts the hand-VERIFIED list in curated-resources-data.ts on the (name, area)
// unique index, so a re-run updates a changed row in place and never duplicates.
// Safe to run repeatedly.
//
// Run against prod:
//   DATABASE_URL=... pnpm --filter @hale/web seed:curated-resources

import { createDb } from '@hale/db';
import { seedCuratedResources } from '../lib/village/curated-resources';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const database = createDb({ connectionString: url });
const result = await seedCuratedResources(database);
console.log(`curated_resources seed: upserted ${result.count} resource(s).`);
process.exit(0);
