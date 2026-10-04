import type { Database } from '@hale/db';
import { kickGmailBackfillDeps } from '~/lib/cron/connector-sync';
import { BOOKED_BACKFILL_KICK_BUDGET_MS } from './booked';
import { type BookedBackfillRun, backfillBookedMail } from './sync';

/**
 * A short, silent pass over booking-shaped mail the moment Gmail connects.
 * The 15-minute cron continues whatever this kick does not finish. A failure
 * here is named and does not undo the connect.
 */
export type GmailBackfillKickOutcome = 'off' | 'completed' | 'partial' | 'quota' | 'failed';

export async function kickGmailBookedBackfill(
  database: Database,
  input: {
    id: string;
    familyId: string;
    userId: string | null;
    accessToken: string;
    providerMetadata: Record<string, unknown>;
  },
): Promise<{ outcome: GmailBackfillKickOutcome }> {
  try {
    const run = await backfillBookedMail(
      {
        id: input.id,
        familyId: input.familyId,
        userId: input.userId,
        provider: 'gmail',
        providerMetadata: input.providerMetadata,
        tokens: { accessToken: input.accessToken },
      },
      input.accessToken,
      kickGmailBackfillDeps(database),
      input.providerMetadata,
      { budgetMs: BOOKED_BACKFILL_KICK_BUDGET_MS },
    );
    return { outcome: kickOutcome(run) };
  } catch (err) {
    console.info(
      { familyId: input.familyId, code: err instanceof Error ? err.name : 'unknown' },
      'gmail backfill: connect kick failed',
    );
    return { outcome: 'failed' };
  }
}

function kickOutcome(run: BookedBackfillRun): GmailBackfillKickOutcome {
  if (run.status === 'off') return 'off';
  if (run.status === 'quota') return 'quota';
  return run.complete ? 'completed' : 'partial';
}
