import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';

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
): Promise<'held' | 'already_held'> {
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
  console.error(
    { urgent: true, hold: 'opt_out_unread' },
    'URGENT: opt-out read failed twice - sender held from proactive sends until the text is re-read; the failure-page cron pages #ops',
  );
  return inserted.length > 0 ? 'held' : 'already_held';
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

/**
 * Erasure (rights/delete.ts, after the family cascade): hold rows are keyed by the number
 * alone, so an erased family's numbers take theirs here. A number someone still holds
 * keeps its rows, since one may be that holder's own unread stop; recovery settles the
 * rest (a text no store holds any more is paged as not in the ledger).
 */
export async function releaseErasedNumbers(
  database: Database,
  phoneHashes: readonly string[],
): Promise<void> {
  if (phoneHashes.length === 0) return;
  const channels = await database
    .select({ phoneHash: schema.parentChannels.phoneE164Hash })
    .from(schema.parentChannels)
    .where(
      and(
        inArray(schema.parentChannels.phoneE164Hash, [...phoneHashes]),
        isNull(schema.parentChannels.revokedAt),
      ),
    );
  const sessions = await database
    .select({ phoneHash: schema.smsIntakeSessions.phoneHash })
    .from(schema.smsIntakeSessions)
    .where(
      and(
        inArray(schema.smsIntakeSessions.phoneHash, [...phoneHashes]),
        isNull(schema.smsIntakeSessions.closedAt),
      ),
    );
  const stillHeld = new Set([...channels, ...sessions].map((row) => row.phoneHash));
  const released = phoneHashes.filter((hash) => !stillHeld.has(hash));
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
