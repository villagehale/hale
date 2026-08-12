import { type Database, schema } from '@hale/db';
import { and, eq, inArray, like } from 'drizzle-orm';
import { CONSUMED_SEND_STATUSES } from '~/lib/channel/ledger';
import { parseCheckpointRef } from './checkpoints';

/**
 * VIL-243 · M8 — TOLD BY ANY SURFACE.
 *
 * THE INVARIANT: every surface that TELLS a family about a checkpoint writes here;
 * every surface that ASKS whether they have been told reads here.
 *
 * It is written down because the alternative already shipped. The 48h nudge minted its
 * own key, wrote it on its own ledger row, and read that row back with its own
 * `category = 'nudge'` filter — so "has this family been told?" was really "did I tell
 * them?". When VIL-238's radar gained the power to tell a family the same checkpoint in
 * their very first message, the nudge could not see it, and the geo-empty cohort the
 * cascade exists for heard one sentence twice inside two days.
 *
 * THE MARKER is the checkpoint's identity ({@link checkpointToldKey}) carried on the
 * outbound `channel_messages` row that told it. One shape, one column, one reader:
 *
 *   - a surface whose row is written WITH the key (the 48h nudge, whose send-idempotency
 *     key IS the marker — see nudge/run.ts dedupeKeyFor) writes it at insert;
 *   - every other surface stamps the row it already wrote, through
 *     {@link recordCheckpointTold}, once the message has actually been SENT.
 *
 * The key's literal shape is legacy data, not a name: rows in production carry
 * `nudge:<family>:health:<ref>` and the prefix is what reads them back, so the string
 * stays exactly as the nudge first wrote it even though the marker belongs to every
 * surface now.
 */

/** The `channel_messages.dedupe_key` namespace a family's told-markers live in. */
export function checkpointToldKeyPrefix(familyId: string): string {
  return `nudge:${familyId}:health:`;
}

/** This checkpoint's told-marker for this family. `ref` is the matcher's own identity
 * (checkpointRef): per child for a one-time visit, per household per school year for
 * the annual records check. Rebuilt nowhere else, so the scope cannot drift. */
export function checkpointToldKey(familyId: string, ref: string): string {
  return `${checkpointToldKeyPrefix(familyId)}${ref}`;
}

/**
 * What became of a told-marker. `not_recorded` is a first-class outcome, never a silent
 * one (rule #11): a lost marker means this family can be told the same checkpoint again
 * by another surface, and the caller has to be able to say so.
 */
export type CheckpointToldOutcome =
  | { status: 'recorded' }
  | { status: 'not_recorded'; reason: 'no_ledger_row' | 'write_failed' };

/**
 * Record that a message which HAS BEEN SENT told this family about a checkpoint.
 *
 * Called with the id of the ledger row that carried it, so a compose that never reached
 * a transport — and therefore has no row — cannot suppress anything.
 *
 * A failure here does not throw, and the reason is specific rather than squeamish: the
 * SMS is already gone by the time this runs, and an intake webhook that throws after
 * the send is retried by the carrier into a second provisioning of the same family.
 * Losing the marker costs one repeated sentence; failing the request costs a duplicate
 * household. So it is logged, named, and handed back.
 */
export async function recordCheckpointTold(
  database: Database,
  input: { familyId: string; ref: string; channelMessageId: string | null },
): Promise<CheckpointToldOutcome> {
  if (input.channelMessageId === null) {
    console.error(
      { familyId: input.familyId, ref: input.ref },
      'health: checkpoint told with no ledger row - marker lost, this checkpoint may be raised again',
    );
    return { status: 'not_recorded', reason: 'no_ledger_row' };
  }
  try {
    await database
      .update(schema.channelMessages)
      .set({ dedupeKey: checkpointToldKey(input.familyId, input.ref) })
      .where(eq(schema.channelMessages.id, input.channelMessageId));
    return { status: 'recorded' };
  } catch (err) {
    console.error(
      { err, familyId: input.familyId, ref: input.ref },
      'health: told-marker write failed - this checkpoint may be raised again',
    );
    return { status: 'not_recorded', reason: 'write_failed' };
  }
}

/**
 * Every checkpoint this family has been TOLD about, by any surface.
 *
 * The category is deliberately NOT a filter. The marker is the question — a row that
 * carries one told this family this checkpoint, whether it was the 48h nudge, the
 * intake radar, or a surface written after this comment. Narrowing by the surface that
 * happened to write it is the bug this module was extracted to end.
 *
 * The status set is the send-side dedupe guard's (channel/ledger.ts dedupeActive), so
 * selection and idempotency cannot disagree about what counts as sent.
 */
export async function loadToldCheckpointRefs(
  database: Database,
  familyId: string,
): Promise<Set<string>> {
  const prefix = checkpointToldKeyPrefix(familyId);
  const rows = await database
    .select({ dedupeKey: schema.channelMessages.dedupeKey })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, familyId),
        eq(schema.channelMessages.direction, 'out'),
        like(schema.channelMessages.dedupeKey, `${prefix}%`),
        // CONSUMED_SEND_STATUSES: a failed delivery still counts as told-attempted.
        // The alternative — 'failed' un-consuming the marker — re-tells the same
        // checkpoint on the next sweep and crashes on the dedupe unique index
        // (launch-day review P0, 2026-08-11). Quiet beats duplicate; deliberate
        // re-tells will be their own decision with their own key.
        inArray(schema.channelMessages.status, [...CONSUMED_SEND_STATUSES]),
      ),
    );
  const refs = new Set<string>();
  for (const row of rows) {
    const ref = row.dedupeKey?.slice(prefix.length);
    if (ref && parseCheckpointRef(ref)) refs.add(ref);
  }
  return refs;
}
