import { type Database, schema } from '@hale/db';
import { and, eq, gte, inArray } from 'drizzle-orm';
import type { LedgerWrite } from './dispatch';
import type { ChannelKind, LoopCategory } from './types';

/**
 * F11 · The Sunday Loop (VIL-213 · A2) — the channel_messages reads/writes the
 * dispatch's ledger port is wired to. A row is written for every outcome; the cap
 * count and the dedupe guard read it back. Outbound only here (direction 'out');
 * inbound rows are A3.
 */

/**
 * The status an outbound row starts at once the provider ACCEPTED it — the one place
 * that decides what a fresh send row claims.
 *
 * SMS starts at 'queued'. Twilio accepts a message and transmits it later, at roughly
 * one segment per second from a Canadian long code, so 'sent' written the moment the
 * API answered asserted a carrier handoff nobody had observed — and it hid the only
 * thing worth watching during a burst, because a pile of messages waiting for airtime
 * looked exactly like a pile already delivered. The delivery receipt is what advances
 * the row from here (channel/twilio/status.ts, which already treats 'queued' as
 * overwritable by sent/delivered/failed alike). The intake replay has recorded its
 * outbound rows this way since #413 for exactly these reasons; this is every other SMS
 * writer catching up.
 *
 * Every other channel is terminal on accept, because none of them has a receipt wired:
 * a row that could never leave 'queued' would be a permanent lie in the other direction.
 */
export function acceptedStatus(channel: ChannelKind): AcceptedStatus {
  return channel === 'sms' ? 'queued' : 'sent';
}

/** What {@link acceptedStatus} can answer — the type a send's own ledger write carries. */
export type AcceptedStatus = 'queued' | 'sent';

/** Insert one outbound ledger row; returns its id (the audit target). */
export async function recordChannelMessage(
  write: LedgerWrite,
  database: Database,
): Promise<string> {
  const [inserted] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: write.familyId,
      parentUserId: write.parentUserId,
      channel: write.channel,
      direction: 'out',
      category: write.category,
      templateKey: write.templateKey,
      dedupeKey: write.dedupeKey,
      providerMessageId: write.providerMessageId ?? null,
      status: write.status,
      errorCode: write.errorCode ?? null,
      relatedActionId: write.relatedActionId ?? null,
      relatedConversationId: write.relatedConversationId ?? null,
      sentAt: write.sentAt ?? null,
    })
    .returning({ id: schema.channelMessages.id });
  if (!inserted) {
    throw new Error('channel_messages insert returned no row');
  }
  return inserted.id;
}

/**
 * THE ONE LIST every "have we already sent this?" reader filters on: the send happened
 * and nothing has come back to say it did not arrive.
 *
 * 'queued' belongs here because that is where an SMS row now STARTS ({@link
 * acceptedStatus}). A reader still asking for ['sent','delivered'] would answer "no"
 * about a message already on its way to the phone and send a second one — a doubled
 * cap, a second identity ask, a re-asked question. The reporting readers are a
 * different question ("did it reach the parent?") and deliberately do not use this.
 */
export const SENT_STATUSES = ['queued', 'sent', 'delivered'] as const;

/** How many real sends (not suppressions/failures) of this category on THIS
 * channel went to the parent since `since` — the cap counts what actually left,
 * including a row still waiting for its receipt, per delivery leg so a mirror leg is
 * not capped by the other. */
export async function countRecentSends(
  userId: string,
  category: LoopCategory,
  channel: ChannelKind,
  since: Date,
  database: Database,
): Promise<number> {
  const rows = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.parentUserId, userId),
        eq(schema.channelMessages.category, category),
        eq(schema.channelMessages.channel, channel),
        gte(schema.channelMessages.createdAt, since),
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
      ),
    );
  return rows.length;
}

/**
 * The statuses that CONSUME a dedupe key: any attempt that reached the provider,
 * INCLUDING 'failed'. Launch-day review P0 (2026-08-11): once #396 made delivery
 * receipts real, an 'undelivered' receipt flipped a keyed row sent→failed in
 * place — and with 'failed' excluded here, the next cron slot re-composed and
 * RE-SENT the same message, then crashed on the dedupe unique index (which has
 * no status predicate), skipping the audit row. A failed delivery must never
 * un-consume idempotency: at-most-once per key is the quiet-operator contract,
 * and deliberate retries, when we build them, will mint their own keys.
 */
export const CONSUMED_SEND_STATUSES = [...SENT_STATUSES, 'failed'] as const;

/** Whether this dedupe key already carries an attempted send — the idempotency
 * guard that makes a re-drain a no-op. Suppressions never carry the key, so a
 * legitimate re-attempt (e.g. after quiet hours) is not blocked. */
export async function dedupeActive(dedupeKey: string, database: Database): Promise<boolean> {
  const rows = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.dedupeKey, dedupeKey),
        inArray(schema.channelMessages.status, [...CONSUMED_SEND_STATUSES]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
