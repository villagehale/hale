#!/usr/bin/env tsx
// One-shot correction of EXISTING village candidates' source_url. Rows discovered
// before the fix in discover.ts (commit 3fa5099) stored the model-guessed url
// instead of the verified Places website, so their "register / view details"
// links point at the wrong site. The forward fix only affects NEW rows; the
// already-persisted wrong rows need force:true to be replaced (the default path
// only fills NULL/empty urls, and these rows have non-null model guesses).
//
// Run once against prod:
//   DATABASE_URL=... GOOGLE_MAPS_API_KEY=... pnpm --filter @hale/web backfill:source-urls
//
// force:true re-checks EVERY candidate through Google Places, which multiplies
// Places call volume — so this is a hand-run one-shot, deliberately NOT wired
// into the recurring discovery cron. Each run is capped at MAX_BACKFILL_PER_RUN
// (50) candidates; re-run until `updated` reaches 0 to correct the full backlog.

import { createDb } from '@hale/db';
import { backfillCandidateSourceUrls } from '../lib/village/backfill-source-urls';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const database = createDb({ connectionString: url });
const result = await backfillCandidateSourceUrls(database, undefined, { force: true });
console.log(`source_url backfill: scanned ${result.scanned}, updated ${result.updated}.`);
process.exit(0);
