import type { Database } from '@hale/db';
import {
  type CommitmentCloseOutcome,
  type CommitmentRecordOutcome,
  fulfillCommitment,
  recordCommitment,
} from '~/lib/commitments/ledger';
import type { RegistrationWatchMint } from '~/lib/channel/reconcile/reconcile';

/**
 * VIL-293 · "I'M WATCHING THAT MORNING" IS A ROW — the registration watch on the MEM-10
 * open-loops ledger.
 *
 * WHAT IT COST WHEN IT WAS PROSE ONLY. 2026-08-21: a parent asked whether Hale could
 * watch the fall registration morning. Hale said "I'm watching that morning and I'll
 * text you before it goes live." Nothing was watching. The ladder (registration/sequence)
 * is a five-minute sweep that claims a window ten days out and mints its own promise at
 * the heads-up leg; a coach turn cannot arm it, cannot claim a window, and left no trace
 * that a household had been told otherwise. The sentence was true of the PRODUCT and
 * false of the FAMILY, and nothing in the system could tell the difference.
 *
 * THE ROW IS WHAT CLOSES THAT GAP. It does not arm the sweep — the sweep is armed by
 * `f14EnabledFor` and by the window match, both of which are checked BEFORE this is ever
 * called (reconcile/view.ts `loadMintableWindow`). What the row adds is the debt: a
 * household that was promised a text before the doors open is now a query, an overdue
 * count in the founder digest, and a line in the coach's own open-loops recitation.
 *
 * SEND-TIME ONLY, like every other writer on this ledger: minted against the outbound
 * `channel_messages` row that carried the sentence, so a compose that never reached a
 * transport promises nobody anything. Nothing here throws — every caller runs AFTER a
 * parent already has the text, where an exception buys a carrier retry and a duplicate
 * send (rule #11).
 */
export async function recordRegistrationWatch(
  database: Database,
  input: {
    familyId: string;
    mint: RegistrationWatchMint;
    /** The outbound row that carried the sentence. Null means it never reached a
     * transport, and a promise nobody received is not a promise. */
    channelMessageId: string | null;
    now: Date;
  },
): Promise<CommitmentRecordOutcome> {
  return recordCommitment(database, {
    familyId: input.familyId,
    kind: 'registration_watch',
    summary: input.mint.summary,
    dueAt: input.mint.dueAt,
    channelMessageId: input.channelMessageId,
  });
}

/**
 * The watch was KEPT — closed against the message that kept it.
 *
 * The `go` leg and nothing else. The heads-up warns a week out and the battle plan hands
 * over a plan the evening before, but the promise was a text BEFORE THE DOORS OPEN, and
 * the go leg is the one that lands fifteen minutes ahead of them. Closing on an earlier
 * leg would file the promise as kept while the parent is still waiting for the thing
 * they were actually promised.
 */
export async function fulfillRegistrationWatch(
  database: Database,
  input: { familyId: string; channelMessageId: string | null; now: Date },
): Promise<CommitmentCloseOutcome> {
  return fulfillCommitment(database, {
    familyId: input.familyId,
    kind: 'registration_watch',
    channelMessageId: input.channelMessageId,
    now: input.now,
  });
}
