import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import type { ProactiveSendKind } from '~/lib/channel/outbound-gate';
import { proactiveCadence } from './flag';

/**
 * VIL-226 · the hand-off from a sweep to the family's queue.
 *
 * `off` writes nothing and the sweep sends, exactly as before. `shadow` writes the
 * candidate and the sweep still sends. `live` writes the candidate and the sweep does
 * not send: the hourly decider does. An `immediate` item — a parent-requested or
 * time-critical send — never queues.
 *
 * A store failure throws. A candidate the decider cannot see must not turn into a text
 * nobody decided, and it must not vanish quietly either.
 */

export type CadenceLane = 'immediate' | 'candidate';

export type ChannelCategory = (typeof schema.channelMessages.$inferInsert)['category'];

export interface CandidateDraft {
  familyId: string;
  parentUserId: string;
  kind: ProactiveSendKind;
  category: ChannelCategory;
  templateKey: string;
  what: string;
  why: string;
  sourceUrl: string | null;
  worthlessAfter: Date | null;
  parentRequested: boolean;
  /** The ledger dedupe key the sweep would have written. */
  dedupeKey: string;
}

export async function handOffProactive(
  database: Database,
  drafts: readonly CandidateDraft[],
  lane: CadenceLane,
): Promise<'send' | 'queued'> {
  const mode = proactiveCadence();
  if (mode === 'off' || lane === 'immediate' || drafts.length === 0) return 'send';
  await database
    .insert(schema.proactiveCandidates)
    .values(drafts.map((draft) => ({ ...draft, status: 'queued' as const })))
    .onConflictDoNothing({
      target: [schema.proactiveCandidates.familyId, schema.proactiveCandidates.dedupeKey],
    });
  if (mode === 'shadow') {
    console.info(
      { familyId: drafts[0]?.familyId, kind: drafts[0]?.kind, count: drafts.length },
      'proactive cadence: shadow queued; the old path still sends',
    );
    return 'send';
  }
  return 'queued';
}

/**
 * True when live cadence already holds this item for the decider, in any status. Lets a
 * sweep skip the compose for an item it handed off on an earlier tick. Always false when
 * not live, so the off and shadow paths read nothing new.
 */
export async function isQueuedForDecider(
  database: Database,
  familyId: string,
  dedupeKey: string,
): Promise<boolean> {
  if (proactiveCadence() !== 'live') return false;
  const [row] = await database
    .select({ id: schema.proactiveCandidates.id })
    .from(schema.proactiveCandidates)
    .where(
      and(
        eq(schema.proactiveCandidates.familyId, familyId),
        eq(schema.proactiveCandidates.dedupeKey, dedupeKey),
      ),
    )
    .limit(1);
  return row !== undefined;
}
