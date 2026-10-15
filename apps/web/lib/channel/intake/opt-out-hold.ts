import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';

/**
 * #868 · the hold after an opt-out read fails twice. No keyword list stands behind the
 * reader, so a text it could not read may be a stop. Until a later read of this
 * sender's text succeeds, nothing proactive or queued goes to them (the outbound gate
 * reads {@link isParentHeld}); replies to their own texts still go out.
 */
export async function holdSender(database: Database, phoneHash: string, now: Date): Promise<void> {
  await database
    .insert(schema.optOutReadHolds)
    .values({ phoneHash, heldAt: now })
    .onConflictDoNothing();
  console.error(
    { urgent: true, hold: 'opt_out_unread' },
    'URGENT: opt-out read failed twice - sender held from proactive sends, page #ops now',
  );
}

export async function releaseSender(database: Database, phoneHash: string): Promise<void> {
  await database
    .delete(schema.optOutReadHolds)
    .where(eq(schema.optOutReadHolds.phoneHash, phoneHash));
}

export async function isSenderHeld(database: Database, phoneHash: string): Promise<boolean> {
  const [row] = await database
    .select({ phoneHash: schema.optOutReadHolds.phoneHash })
    .from(schema.optOutReadHolds)
    .where(eq(schema.optOutReadHolds.phoneHash, phoneHash))
    .limit(1);
  return Boolean(row);
}

/** The parent's sendable number is on hold. No number: nothing to hold. */
export async function isParentHeld(database: Database, parentUserId: string): Promise<boolean> {
  const phone = await resolveSendablePhone(database, parentUserId);
  return phone ? isSenderHeld(database, phoneBlindIndex(phone)) : false;
}
