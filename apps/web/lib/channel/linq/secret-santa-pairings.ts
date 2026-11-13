import { randomInt } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { and, eq, sql } from 'drizzle-orm';
import { decryptString, encryptString } from '~/lib/crypto/string-cipher';

/**
 * VIL-686 — the only module that knows who drew whom.
 *
 * A giver's receiver lives in one place: `secret_santa_participants.receiver_encrypted`,
 * the receiver's participant id, encrypted. Nothing else in the codebase names that
 * column or decrypts it (a repo-grep test holds this). The pointer exists only between the
 * draw and the moment that giver's draw is delivered, when it is nulled in the same
 * statement that marks the delivery.
 */

/** Fewer than this many people makes the pairing guessable from the group alone. */
export const SECRET_SANTA_MIN_PARTICIPANTS = 4;

/**
 * A uniformly random derangement of `ids` (no one draws themselves): Fisher–Yates over a
 * copy, redrawn until there is no fixed point (about e ≈ 2.7 tries on average). The result
 * is the receiver at each giver's index.
 */
export function drawDerangement(
  ids: readonly string[],
  rand: (max: number) => number = randomInt,
): string[] {
  if (ids.length < SECRET_SANTA_MIN_PARTICIPANTS) {
    throw new Error('secret santa: a draw needs at least four people');
  }
  for (;;) {
    const out = [...ids];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = rand(i + 1);
      const swap = out[i] as string;
      out[i] = out[j] as string;
      out[j] = swap;
    }
    if (out.every((id, index) => id !== ids[index])) return out;
  }
}

/**
 * Draws and writes every giver's pointer in ONE statement, givers in ascending id order,
 * so neither the write order nor the number of statements says anything about who drew
 * whom. Runs inside the draw's transaction.
 */
export async function writePairings(
  tx: Database,
  drawId: string,
  giverParticipantIds: readonly string[],
  rand?: (max: number) => number,
): Promise<void> {
  const givers = [...giverParticipantIds].sort();
  const receivers = drawDerangement(givers, rand);
  const rows = givers.map(
    (giver, index) => sql`(${giver}::uuid, ${encryptString(receivers[index] as string)})`,
  );
  const participants = schema.secretSantaParticipants;
  await tx.execute(sql`
    UPDATE ${participants}
       SET receiver_encrypted = pairs.pointer
      FROM (VALUES ${sql.join(rows, sql`, `)}) AS pairs(giver, pointer)
     WHERE ${participants.id} = pairs.giver
       AND ${participants.drawId} = ${drawId}
  `);
}

/**
 * The name the giver's receiver gave, or `unresolvable` when the pointer is gone or names a
 * participant row that no longer exists in this draw. Only the giver's own 1:1 send calls
 * this, after every send gate has passed.
 */
export async function receiverForGiver(
  database: Database,
  input: { drawId: string; giverParticipantId: string },
): Promise<{ called: string } | 'unresolvable'> {
  const participants = schema.secretSantaParticipants;
  const [giver] = await database
    .select({ pointer: participants.receiverEncrypted })
    .from(participants)
    .where(and(eq(participants.id, input.giverParticipantId), eq(participants.drawId, input.drawId)))
    .limit(1);
  if (!giver?.pointer) return 'unresolvable';
  const receiverId = decryptString(giver.pointer);
  const [receiver] = await database
    .select({ called: participants.called })
    .from(participants)
    .where(and(eq(participants.id, receiverId), eq(participants.drawId, input.drawId)))
    .limit(1);
  return receiver?.called ? { called: receiver.called } : 'unresolvable';
}

/** Marks the giver's draw delivered and forgets their pointer, in one statement. */
export async function clearPairing(
  database: Database,
  participantId: string,
  deliveredAt: Date,
): Promise<void> {
  const participants = schema.secretSantaParticipants;
  await database
    .update(participants)
    .set({ deliveredAt, receiverEncrypted: null, heldReason: null })
    .where(eq(participants.id, participantId));
}
