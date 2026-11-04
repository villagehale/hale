import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { pageOps } from '~/lib/monitoring/failure-page';

/**
 * #868 · the hold after an opt-out read fails twice. No keyword list stands behind the
 * reader, so a text it could not read may be a stop. VIL-553: the hold names that text by
 * its provider message id, and the number stays held until THAT text has been read
 * (opt-out-recovery.ts re-reads it once the model is back). Nothing proactive or queued
 * goes to a held number (the outbound gate reads {@link isParentHeld}); replies to their
 * own texts still go out.
 */
export async function holdSender(
  database: Database,
  input: { phoneHash: string; providerMessageId: string; now: Date },
): Promise<'held' | 'already_held' | 'held_id_collision'> {
  const inserted = await database
    .insert(schema.optOutHeldMessages)
    .values({
      providerMessageId: input.providerMessageId,
      phoneHash: input.phoneHash,
      heldAt: input.now,
      nextReadAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.optOutHeldMessages.providerMessageId });
  console.warn(
    { hold: 'opt_out_unread' },
    'opt-out read failed twice - sender held from proactive sends until the text is re-read; the opt-out hold sweep pages it',
  );
  if (inserted.length > 0) return 'held';
  const [existing] = await database
    .select({ phoneHash: schema.optOutHeldMessages.phoneHash })
    .from(schema.optOutHeldMessages)
    .where(eq(schema.optOutHeldMessages.providerMessageId, input.providerMessageId))
    .limit(1);
  if (existing?.phoneHash === input.phoneHash) return 'already_held';
  // The id is the key across every transport, so another number's text already holds it.
  // Fail closed: this number's row gets a key no store can place, so recovery keeps it as
  // unrecorded (paged) while the number can be texted, until a human resolves it.
  const collision = await database
    .insert(schema.optOutHeldMessages)
    .values({
      providerMessageId: `${input.providerMessageId}#collision:${input.phoneHash}`,
      phoneHash: input.phoneHash,
      heldAt: input.now,
      nextReadAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.optOutHeldMessages.providerMessageId });
  if (collision.length === 0) return 'already_held';
  await pageOps(database, {
    site: 'opt_out_hold_unwritten',
    facts: { outcome: 'held_id_collision', numbers: 2 },
  });
  return 'held_id_collision';
}

/** This exact text has been read. Releases its own row and no other. */
export async function releaseHeldMessage(
  database: Database,
  providerMessageId: string,
): Promise<'released' | 'not_held'> {
  const deleted = await database
    .delete(schema.optOutHeldMessages)
    .where(eq(schema.optOutHeldMessages.providerMessageId, providerMessageId))
    .returning({ id: schema.optOutHeldMessages.providerMessageId });
  return deleted.length > 0 ? 'released' : 'not_held';
}

/** What an erasure takes from the two hold tables, read before the family cascade. */
export interface ErasedHolds {
  /** The erased families' numbers. */
  phoneHashes: string[];
  /** Held texts the erased families sent, whichever number holds them now. */
  providerMessageIds: string[];
}

/** Read BEFORE the family cascade: it deletes the channels and texts that say what to take. */
export async function erasedFamilyHolds(
  database: Database,
  familyIds: readonly string[],
): Promise<ErasedHolds> {
  if (familyIds.length === 0) return { phoneHashes: [], providerMessageIds: [] };
  const channels = await database
    .select({ phoneHash: schema.parentChannels.phoneE164Hash })
    .from(schema.parentChannels)
    .where(inArray(schema.parentChannels.familyId, [...familyIds]));
  // The held set is small (one row per unread text); a family's ledger is not.
  const held = await database
    .select({ id: schema.optOutHeldMessages.providerMessageId })
    .from(schema.optOutHeldMessages);
  const texts =
    held.length === 0
      ? []
      : await database
          .select({ id: schema.channelMessages.providerMessageId })
          .from(schema.channelMessages)
          .where(
            and(
              inArray(schema.channelMessages.familyId, [...familyIds]),
              eq(schema.channelMessages.direction, 'in'),
              inArray(
                schema.channelMessages.providerMessageId,
                held.map((row) => row.id),
              ),
            ),
          );
  return {
    phoneHashes: [...new Set(channels.map((row) => row.phoneHash))],
    providerMessageIds: [...new Set(texts.flatMap((row) => (row.id === null ? [] : [row.id])))],
  };
}

/**
 * After the family cascade (rights/delete.ts). Hold rows are keyed by the number and the
 * text alone, so an erasure takes its own here: held texts the family sent, and every row
 * on its numbers, but only where nobody holds that number now. A number someone still
 * holds keeps every row on it, since any may be their own unread stop (a parent seated in
 * a second family, or the number's next holder). Such a row keeps no family content (a
 * phone hash, a provider id, a time): what a text the family sent was read as when it was
 * read as a crisis is cleared from it. Once its text is gone it reads as unrecorded, so
 * the hold stays fail closed and is paged.
 */
export async function releaseErasedHolds(database: Database, erased: ErasedHolds): Promise<void> {
  if (erased.providerMessageIds.length > 0) {
    await database
      .update(schema.optOutHeldMessages)
      .set({ crisisLanguage: null, crisisSituation: null, crisisWho: null })
      .where(inArray(schema.optOutHeldMessages.providerMessageId, erased.providerMessageIds));
  }
  const texts =
    erased.providerMessageIds.length === 0
      ? []
      : await database
          .select({
            id: schema.optOutHeldMessages.providerMessageId,
            phoneHash: schema.optOutHeldMessages.phoneHash,
          })
          .from(schema.optOutHeldMessages)
          .where(inArray(schema.optOutHeldMessages.providerMessageId, erased.providerMessageIds));
  const numbers = [...new Set([...erased.phoneHashes, ...texts.map((row) => row.phoneHash)])];
  if (numbers.length === 0) return;
  const channels = await database
    .select({ phoneHash: schema.parentChannels.phoneE164Hash })
    .from(schema.parentChannels)
    .where(
      and(
        inArray(schema.parentChannels.phoneE164Hash, numbers),
        isNull(schema.parentChannels.revokedAt),
      ),
    );
  const sessions = await database
    .select({ phoneHash: schema.smsIntakeSessions.phoneHash })
    .from(schema.smsIntakeSessions)
    .where(
      and(
        inArray(schema.smsIntakeSessions.phoneHash, numbers),
        isNull(schema.smsIntakeSessions.closedAt),
      ),
    );
  const stillHeld = new Set([...channels, ...sessions].map((row) => row.phoneHash));
  const releasedTexts = texts.filter((row) => !stillHeld.has(row.phoneHash)).map((row) => row.id);
  if (releasedTexts.length > 0) {
    await database
      .delete(schema.optOutHeldMessages)
      .where(inArray(schema.optOutHeldMessages.providerMessageId, releasedTexts));
  }
  const released = erased.phoneHashes.filter((hash) => !stillHeld.has(hash));
  if (released.length === 0) return;
  await database
    .delete(schema.optOutHeldMessages)
    .where(inArray(schema.optOutHeldMessages.phoneHash, released));
  await database
    .delete(schema.optOutReadHolds)
    .where(inArray(schema.optOutReadHolds.phoneHash, released));
}

/** Held while any unread text of this number stands, or a pre-VIL-553 row does. */
export async function isSenderHeld(database: Database, phoneHash: string): Promise<boolean> {
  const [message] = await database
    .select({ id: schema.optOutHeldMessages.providerMessageId })
    .from(schema.optOutHeldMessages)
    .where(eq(schema.optOutHeldMessages.phoneHash, phoneHash))
    .limit(1);
  if (message) return true;
  const [legacy] = await database
    .select({ phoneHash: schema.optOutReadHolds.phoneHash })
    .from(schema.optOutReadHolds)
    .where(eq(schema.optOutReadHolds.phoneHash, phoneHash))
    .limit(1);
  return Boolean(legacy);
}

/** The parent's sendable number is on hold. No number: nothing to hold. */
export async function isParentHeld(database: Database, parentUserId: string): Promise<boolean> {
  const phone = await resolveSendablePhone(database, parentUserId);
  return phone ? isSenderHeld(database, phoneBlindIndex(phone)) : false;
}
