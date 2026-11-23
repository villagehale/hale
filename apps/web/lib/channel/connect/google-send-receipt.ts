import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { isParentHeld } from '~/lib/channel/intake/opt-out-hold';
import { acceptedStatus } from '~/lib/channel/ledger';
import { linqRefusedForCertain, readSendRefusal } from '~/lib/channel/outbound-transport';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { pageOps } from '~/lib/monitoring/failure-page';

/**
 * VIL-721 · how a text the one Google link adds leaves: the card, a fresh link, the
 * receipt and the ask that rides it.
 *
 * The row claims nothing until Linq takes the text. It is a `failed` row under
 * {@link GOOGLE_SEND_IN_FLIGHT}, which holds the dedupe key against a second run, and a
 * crash mid-send leaves a row that says nothing was sent.
 *
 * Linq's idempotency key is the row's id. A failure that does not prove the text stayed
 * home (a timeout, a 5xx, a 408) keeps the row and its key, so a retry reuses the key and
 * Linq drops the copy. A certain refusal frees the dedupe key, so the next try is a new
 * row with a new key, in case Linq remembers the refused one.
 *
 * Stop, erasure and line hold are read right before the send, after the model wrote it.
 */
export const GOOGLE_SEND_IN_FLIGHT = 'send_in_flight';
const MAY_HAVE_LANDED_PREFIX = 'unconfirmed:';
/** Longer than any compose plus send on one request: a claim this old was a crash. */
const IN_FLIGHT_STALE_MS = 5 * 60_000;

export type GoogleSendSurface = 'card' | 'fresh_link' | 'receipt' | 'ask';
export type GoogleSendGate = 'open' | 'stopped' | 'erasure_scheduled' | 'held';

export interface GoogleSendRow {
  familyId: string;
  parentUserId: string;
  channel: 'sms' | 'imessage';
  category: 'intake' | 'reply';
  templateKey: string;
  dedupeKey: string | null;
  providerChatId: string | null;
  now: Date;
}

export interface GoogleSendClaim {
  id: string;
  /** What this row said before this try. Set when a send that may have landed is retried. */
  prior: string | null;
}

export type GoogleClaimResult =
  | { kind: 'try'; claim: GoogleSendClaim }
  /** The row holds a provider id: Linq accepted this text. Nothing else proves a send. */
  | { kind: 'already_sent' }
  /** Another try holds the key and nothing proves its text went. */
  | { kind: 'in_flight' };

export type GoogleSendOutcome<R> =
  | { status: 'accepted'; sent: R }
  | { status: 'gated'; reason: Exclude<GoogleSendGate, 'open'> }
  | { status: 'refused'; code: string }
  | { status: 'unconfirmed'; code: string };

/** Whether this parent may still be texted, read at the moment of the send. */
export async function googleSendGate(
  database: Database,
  who: { familyId: string; parentUserId: string },
): Promise<GoogleSendGate> {
  const [family] = await database
    .select({ scheduledDeletionAt: schema.families.scheduledDeletionAt })
    .from(schema.families)
    .where(eq(schema.families.id, who.familyId))
    .limit(1);
  if (!family || family.scheduledDeletionAt !== null) return 'erasure_scheduled';
  if (!(await resolveSendablePhone(database, who.parentUserId))) return 'stopped';
  return (await isParentHeld(database, who.parentUserId)) ? 'held' : 'open';
}

export async function claimGoogleSend(
  database: Database,
  row: GoogleSendRow,
): Promise<GoogleClaimResult> {
  const [inserted] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: row.familyId,
      parentUserId: row.parentUserId,
      channel: row.channel,
      direction: 'out',
      category: row.category,
      templateKey: row.templateKey,
      dedupeKey: row.dedupeKey,
      providerChatId: row.providerChatId,
      status: 'failed',
      errorCode: GOOGLE_SEND_IN_FLIGHT,
      createdAt: row.now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.channelMessages.id });
  if (inserted) return { kind: 'try', claim: { id: inserted.id, prior: null } };
  if (row.dedupeKey === null) return { kind: 'in_flight' };

  const [held] = await database
    .select({
      id: schema.channelMessages.id,
      status: schema.channelMessages.status,
      errorCode: schema.channelMessages.errorCode,
      providerMessageId: schema.channelMessages.providerMessageId,
      createdAt: schema.channelMessages.createdAt,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, row.familyId),
        eq(schema.channelMessages.dedupeKey, row.dedupeKey),
      ),
    )
    .limit(1);
  if (!held) return { kind: 'in_flight' };
  if (held.providerMessageId !== null) return { kind: 'already_sent' };
  const code = held.errorCode;
  const running =
    code === GOOGLE_SEND_IN_FLIGHT &&
    row.now.getTime() - held.createdAt.getTime() <= IN_FLIGHT_STALE_MS;
  if (running) return { kind: 'in_flight' };
  if (code !== GOOGLE_SEND_IN_FLIGHT && !code?.startsWith(MAY_HAVE_LANDED_PREFIX)) {
    return { kind: 'in_flight' };
  }
  const [retaken] = await database
    .update(schema.channelMessages)
    .set({ errorCode: GOOGLE_SEND_IN_FLIGHT, createdAt: row.now })
    .where(and(eq(schema.channelMessages.id, held.id), eq(schema.channelMessages.errorCode, code)))
    .returning({ id: schema.channelMessages.id });
  if (!retaken) return { kind: 'in_flight' };
  // A crashed claim may have reached Linq too, so it is released as "may have landed".
  const prior = code === GOOGLE_SEND_IN_FLIGHT ? `${MAY_HAVE_LANDED_PREFIX}crashed` : code;
  return { kind: 'try', claim: { id: retaken.id, prior } };
}

/**
 * This try sends nothing. A first try records why and frees the key. A retry of a send that
 * may have landed goes back to saying so, and keeps its key for the next try.
 */
export async function releaseGoogleClaim(
  database: Database,
  claim: GoogleSendClaim,
  reason: string,
): Promise<void> {
  await database
    .update(schema.channelMessages)
    .set(
      claim.prior === null
        ? { status: 'failed', errorCode: reason, dedupeKey: null }
        : { status: 'failed', errorCode: claim.prior },
    )
    .where(eq(schema.channelMessages.id, claim.id));
}

/** Clears the one offer's key from a text that went without its link, so the link can follow. */
export async function freeGoogleSendKey(database: Database, claimId: string): Promise<void> {
  await database
    .update(schema.channelMessages)
    .set({ dedupeKey: null })
    .where(eq(schema.channelMessages.id, claimId));
}

export async function sendClaimedGoogleText<
  R extends {
    providerMessageId: string;
    transport?: 'sms' | 'whatsapp' | 'imessage';
    chatId?: string | null;
  },
>(
  database: Database,
  claim: GoogleSendClaim,
  who: {
    familyId: string;
    parentUserId: string;
    now: Date;
    channel: 'sms' | 'imessage';
    chatId: string | null;
    surface: GoogleSendSurface;
  },
  send: (sendKey: string) => Promise<R>,
): Promise<GoogleSendOutcome<R>> {
  const gate = await googleSendGate(database, who);
  if (gate !== 'open') {
    await releaseGoogleClaim(database, claim, gate);
    console.info(
      { familyId: who.familyId, surface: who.surface, gate },
      'google connect text: not sent - the parent cannot be texted now',
    );
    return { status: 'gated', reason: gate };
  }

  let sent: R;
  try {
    sent = await send(claim.id);
  } catch (err) {
    return settleFailure(database, claim, who, err);
  }

  const carried = sent.transport === 'imessage' ? 'imessage' : who.channel;
  await database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    await tx
      .update(schema.channelMessages)
      .set({
        status: acceptedStatus(carried),
        errorCode: null,
        sentAt: who.now,
        providerMessageId: sent.providerMessageId,
        channel: carried,
        providerChatId: carried === 'imessage' ? (sent.chatId ?? who.chatId) : null,
      })
      .where(eq(schema.channelMessages.id, claim.id));
    await tx.insert(schema.auditLog).values({
      familyId: who.familyId,
      actor: who.parentUserId,
      actionTaken: 'sms_reply_sent',
      targetTable: 'channel_messages',
      targetId: claim.id,
      audience: who.parentUserId,
    });
  });
  return { status: 'accepted', sent };
}

async function settleFailure(
  database: Database,
  claim: GoogleSendClaim,
  who: { familyId: string; parentUserId: string; surface: GoogleSendSurface },
  err: unknown,
): Promise<{ status: 'refused' | 'unconfirmed'; code: string }> {
  const code = readSendRefusal(err)?.code ?? 'unknown';
  const refused = linqRefusedForCertain(err);
  const failure = refused ? 'refused' : 'unconfirmed';
  await database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    await tx
      .update(schema.channelMessages)
      .set(
        refused
          ? { status: 'failed', errorCode: code, dedupeKey: null }
          : { status: 'failed', errorCode: `${MAY_HAVE_LANDED_PREFIX}${code}` },
      )
      .where(eq(schema.channelMessages.id, claim.id));
    await tx.insert(schema.auditLog).values({
      familyId: who.familyId,
      actor: 'system',
      actionTaken: 'google_connect_text_unsent',
      targetTable: 'channel_messages',
      targetId: claim.id,
      audience: who.parentUserId,
      after: { surface: who.surface, failure },
    });
  });
  await pageOps(database, {
    site: 'google_connect_text_unsent',
    facts: { surface: who.surface, failure },
  });
  return { status: failure, code };
}
