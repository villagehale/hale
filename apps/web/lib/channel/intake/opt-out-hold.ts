import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
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
