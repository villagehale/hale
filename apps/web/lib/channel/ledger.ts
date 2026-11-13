import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { LedgerWrite } from './dispatch';
import { isUuid } from './mid-activity/claim';
import type { ChannelKind } from './types';

/**
 * F11 · The Sunday Loop (VIL-213 · A2) — the channel_messages reads/writes the
 * dispatch's ledger port is wired to. A row is written for every outcome; the
 * dedupe guard reads it back. Outbound only here (direction 'out');
 * inbound rows are A3.
 */

/**
 * The status an outbound row starts at once the provider ACCEPTED it — the one place
 * that decides what a fresh send row claims.
 *
 * SMS starts at 'queued'. The phone provider accepts a message and transmits it later, at roughly
 * one segment per second from a Canadian long code, so 'sent' written the moment the
 * API answered asserted a carrier handoff nobody had observed — and it hid the only
 * thing worth watching during a burst, because a pile of messages waiting for airtime
 * looked exactly like a pile already delivered. The delivery receipt is what advances
 * the row from here (delivery-status.ts, which already treats 'queued' as
 * overwritable by sent/delivered/failed alike). The intake replay has recorded its
 * outbound rows this way since #413 for exactly these reasons; this is every other SMS
 * writer catching up.
 *
 * Every other channel is terminal on accept, because none of them has a receipt wired:
 * a row that could never leave 'queued' would be a permanent lie in the other direction.
 *
 * iMessage (Linq, VIL-335) is terminal on accept. The partner API's 2xx is the
 * acceptance we have; delivery webhooks are not wired on this leg, and a row that
 * could never leave 'queued' would be a permanent lie.
 */
export function acceptedStatus(channel: ChannelKind | 'imessage'): AcceptedStatus {
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
      providerChatId: write.providerChatId ?? null,
      status: write.status,
      errorCode: write.errorCode ?? null,
      relatedActionId: write.relatedActionId ?? null,
      relatedConversationId: write.relatedConversationId ?? null,
      sentAt: write.sentAt ?? null,
      body: write.body ?? null,
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
 * about a message already on its way to the phone and send a second one — a second
 * identity ask, a re-asked question. The reporting readers are a
 * different question ("did it reach the parent?") and deliberately do not use this.
 */
export const SENT_STATUSES = ['queued', 'sent', 'delivered'] as const;

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

/**
 * The statuses that say a message got to the parent's phone: the provider handed it on
 * ('sent', terminal on accept for iMessage) or a receipt confirmed it ('delivered').
 * 'queued' is still waiting for airtime and 'failed' never arrived.
 */
const DELIVERED_STATUSES = ['sent', 'delivered'] as const;

/**
 * An ASK as the parent holds it: the message under this dedupe key, when it reached the
 * parent, and who it went to. Null while it is queued, after it failed, or if it never
 * went. A question Hale put to nobody is not open. `askedAt` is when its row recorded the
 * send ({@link sendRecordedAt}), null when not known.
 */
export async function deliveredAsk(
  database: Database,
  dedupeKey: string,
): Promise<{ parentUserId: string; askedAt: Date | null } | null> {
  const [row] = await database
    .select({
      parentUserId: schema.channelMessages.parentUserId,
      askedAt: schema.channelMessages.sendRecordedAt,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.dedupeKey, dedupeKey),
        inArray(schema.channelMessages.status, [...DELIVERED_STATUSES]),
        isNotNull(schema.channelMessages.sentAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * VIL-302 · WHEN AN ASK WENT, on the one clock every ask a parent may answer is ranked by:
 * the database clock when the outbound row that carried it first recorded its send
 * (`send_recorded_at`, stamped by a trigger, migration 0249). Not `sent_at`, which is each
 * caller's own start time, and not `created_at`, which is before the send on a row claimed
 * first. Null when the row recorded no send, recorded it before the column existed, or is
 * not this family's.
 */
export async function sendRecordedAt(
  database: Database,
  input: { familyId: string; channelMessageId: string },
): Promise<Date | null> {
  // A provenance column is text, and a value that is not a row id names no send.
  if (!isUuid(input.channelMessageId)) return null;
  const [row] = await database
    .select({ at: schema.channelMessages.sendRecordedAt })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.id, input.channelMessageId),
        eq(schema.channelMessages.familyId, input.familyId),
        eq(schema.channelMessages.direction, 'out'),
      ),
    )
    .limit(1);
  return row?.at ?? null;
}

/**
 * Historical marker on a channel_messages row whose dedupe key was claimed
 * because a combined notice already covered it. New sends do not write this:
 * a covered key is an audit row, not a second queued text. Counts of real
 * sends still exclude any row that already carries it.
 */
export const COVERED_BY_COMBINED_NOTICE = 'covered_by_combined_notice';

/** True for a ledger row that is a send the parent could read, not a covered claim. */
export function isRealSendRow() {
  return sql`coalesce(${schema.channelMessages.errorCode}, '') <> ${COVERED_BY_COMBINED_NOTICE}`;
}

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
