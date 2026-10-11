#!/usr/bin/env tsx
// One-off kid-relevance backfill (VIL-226 item 5). Judges the connector rows Hale already
// holds and, with --apply, drops the parent's own ones. Prints counts only.
//
//   pnpm --filter @hale/web exec tsx scripts/kid-relevance-backfill.ts            # dry run
//   pnpm --filter @hale/web exec tsx scripts/kid-relevance-backfill.ts --apply    # write
//
// Needs DATABASE_URL and ANTHROPIC_API_KEY. A dry run changes no tracking state; it does
// store the verdicts, so the apply acts on exactly what the dry run counted. Run the dry
// run first and read the counts.

import { createDb } from '@hale/db';
import { runKidRelevanceBackfill } from '../lib/integrations/kid-relevance/backfill';
import { CRON_SWEEP_CLIENT_OPTIONS, budgetedAnthropic } from '../lib/pipeline/client';

/** A script has no route ceiling to stop at; it runs until every item is judged or held. */
const NO_DEADLINE = new Date(8.64e15);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. The backfill asks the kid-relevance judge.');
  process.exit(1);
}

const apply = process.argv.includes('--apply');
const database = createDb({ connectionString: url });

try {
  const counts = await runKidRelevanceBackfill(
    database,
    { apply, now: new Date(), deadline: NO_DEADLINE },
    { client: budgetedAnthropic(CRON_SWEEP_CLIENT_OPTIONS) },
  );
  console.info(JSON.stringify(counts, null, 2));
  process.exit(0);
} catch (err) {
  const name = err instanceof Error ? err.constructor.name : 'unknown';
  console.error(`kid-relevance backfill failed: ${name}`);
  process.exit(1);
}
