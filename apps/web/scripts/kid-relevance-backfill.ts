#!/usr/bin/env tsx
// One-off kid-relevance backfill (VIL-226 item 5). Judges the connector rows Hale already
// holds and, with --apply, drops the parent's own ones. Prints counts only.
//
// --apply is refused (mirror_not_wired, exit 1) while CALENDAR_MIRROR_HONOURS_KID_VERDICTS
// is false: the mirror's next sync would put every dropped calendar copy back. The dry run
// and --revert run as before.
//
//   pnpm --filter @hale/web exec tsx scripts/kid-relevance-backfill.ts            # dry run
//   pnpm --filter @hale/web exec tsx scripts/kid-relevance-backfill.ts --apply    # write
//   pnpm --filter @hale/web exec tsx scripts/kid-relevance-backfill.ts --revert=<runId>
//
// Needs DATABASE_URL. A dry run and an apply also need APP_ENCRYPTION_KEY, and only a dry
// run needs ANTHROPIC_API_KEY. A dry run changes no tracking state; it does store the
// verdicts. An apply asks no model: it acts only on those stored verdicts, and counts an
// item added or changed since - every item, once a child's age in months has rolled
// over - as notInDryRun and leaves it alone. Run the dry run first and read the counts.
// Every run prints its run id first; an apply's audit rows carry it, and --revert=<runId>
// undoes that apply.

import { randomUUID } from 'node:crypto';
import { createDb } from '@hale/db';
import {
  CALENDAR_MIRROR_HONOURS_KID_VERDICTS,
  backfillApplyDecision,
  revertKidRelevanceBackfill,
  runKidRelevanceBackfill,
} from '../lib/integrations/kid-relevance/backfill';
import { CRON_SWEEP_CLIENT_OPTIONS, budgetedAnthropic } from '../lib/pipeline/client';

/** A script has no route ceiling to stop at; it runs until every item is judged or held. */
const NO_DEADLINE = new Date(8.64e15);

const apply = process.argv.includes('--apply');
const revertRunId = process.argv
  .find((arg) => arg.startsWith('--revert='))
  ?.slice('--revert='.length);
const decision = backfillApplyDecision(
  { apply, revert: revertRunId !== undefined },
  CALENDAR_MIRROR_HONOURS_KID_VERDICTS,
);
if (decision.outcome !== 'allowed') {
  console.error(`${decision.outcome}: ${decision.reason}. Nothing was read or written.`);
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
if (revertRunId === undefined && !process.env.APP_ENCRYPTION_KEY) {
  console.error('APP_ENCRYPTION_KEY is not set. The verdict cache is keyed on it.');
  process.exit(1);
}
if (!apply && revertRunId === undefined && !process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. A dry run asks the kid-relevance judge.');
  process.exit(1);
}

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
        ? 'Reverted. A Gmail copy has its title and place back from its offer; a calendar copy gets them back on the mirror’s next pass. Parent calendar blocks are not restored; the next sweep rebuilds them.'
        : 'No apply carries that run id; nothing changed.',
    );
    process.exit(0);
  }

  const runId = randomUUID();
  console.info(`runId: ${runId}`);
  const counts = await runKidRelevanceBackfill(
    database,
    { now: new Date(), deadline: NO_DEADLINE, runId },
    apply
      ? { apply: true }
      : { apply: false, client: budgetedAnthropic(CRON_SWEEP_CLIENT_OPTIONS) },
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
