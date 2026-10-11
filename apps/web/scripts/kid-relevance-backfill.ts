#!/usr/bin/env tsx
// One-off kid-relevance backfill (VIL-226 item 5). Judges the connector rows Hale already
// holds and, with --apply, drops the parent's own ones. Prints counts only.
//
//   pnpm --filter @hale/web exec tsx scripts/kid-relevance-backfill.ts            # dry run
//   pnpm --filter @hale/web exec tsx scripts/kid-relevance-backfill.ts --apply    # write
//   pnpm --filter @hale/web exec tsx scripts/kid-relevance-backfill.ts --revert=<runId>
//
// Needs DATABASE_URL, APP_ENCRYPTION_KEY and ANTHROPIC_API_KEY (a revert needs only the
// first). A dry run changes no tracking state; it does store the verdicts, so the apply
// acts on exactly what the dry run counted. Run the dry run first and read the counts.
// Every run prints its run id first; an apply's audit rows carry it, and --revert=<runId>
// undoes that apply.

import { randomUUID } from 'node:crypto';
import { createDb } from '@hale/db';
import {
  revertKidRelevanceBackfill,
  runKidRelevanceBackfill,
} from '../lib/integrations/kid-relevance/backfill';
import { CRON_SWEEP_CLIENT_OPTIONS, budgetedAnthropic } from '../lib/pipeline/client';

/** A script has no route ceiling to stop at; it runs until every item is judged or held. */
const NO_DEADLINE = new Date(8.64e15);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
const revertRunId = process.argv
  .find((arg) => arg.startsWith('--revert='))
  ?.slice('--revert='.length);
if (revertRunId === undefined && !process.env.APP_ENCRYPTION_KEY) {
  console.error('APP_ENCRYPTION_KEY is not set. The verdict cache is keyed on it.');
  process.exit(1);
}
if (revertRunId === undefined && !process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. The backfill asks the kid-relevance judge.');
  process.exit(1);
}

const apply = process.argv.includes('--apply');
const database = createDb({ connectionString: url });

try {
  if (revertRunId !== undefined) {
    const counts = await revertKidRelevanceBackfill(database, {
      runId: revertRunId,
      now: new Date(),
    });
    console.info(JSON.stringify(counts, null, 2));
    console.info(
      counts.found
        ? 'Reverted. Titles and places are not restored: a calendar copy gets them back on the mirror’s next pass, a Gmail copy stays without one. Parent calendar blocks are not restored; the next sweep rebuilds them.'
        : 'No apply carries that run id; nothing changed.',
    );
    process.exit(0);
  }

  const runId = randomUUID();
  console.info(`runId: ${runId}`);
  const counts = await runKidRelevanceBackfill(
    database,
    { apply, now: new Date(), deadline: NO_DEADLINE, runId },
    { client: budgetedAnthropic(CRON_SWEEP_CLIENT_OPTIONS) },
  );
  console.info(JSON.stringify(counts, null, 2));
  if (!apply) {
    console.info(
      `Dry run: ${counts.kid + counts.adult + counts.unsure} verdicts are stored (the judge's cache, which an apply reuses at no model cost); nothing else changed.`,
    );
  }
  process.exit(0);
} catch (err) {
  const name = err instanceof Error ? err.constructor.name : 'unknown';
  console.error(`kid-relevance backfill failed: ${name}`);
  process.exit(1);
}
