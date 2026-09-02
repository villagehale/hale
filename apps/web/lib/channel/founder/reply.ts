import { type Database, schema } from '@hale/db';
import { and, eq, inArray } from 'drizzle-orm';
import { readAffirmative } from '~/lib/channel/affirmative';
import { CONSUMED_SEND_STATUSES, acceptedStatus } from '~/lib/channel/ledger';
import { posterLocation } from '~/lib/channel/intake/copy';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { createTwilioTransport } from '~/lib/channel/twilio/transport';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { cancelCommitment, fulfillCommitment, loadOpenCommitment } from '~/lib/commitments/ledger';
import {
  FOUNDER_NOTE_DECLINED_ACK,
  FOUNDER_NOTE_FAILED_ACK,
  FOUNDER_NOTE_SENT_ACK,
  FOUNDER_NOTE_TEMPLATE_KEY,
  FOUNDER_NOTE_UNREACHABLE_ACK,
  founderNote,
} from './copy';

/**
 * THE YES — the second half of the founder-welcome arc, and the only handler in the
 * chain whose work lands in a DIFFERENT family's thread than the one that spoke.
 *
 * The founder was pinged in his own thread ("a new family just joined from the Georgetown
 * poster"), and one word sends a note he wrote himself into theirs. Everything that makes
 * that safe is a read, in this order:
 *
 *   1. THE OFFER IS A ROW, and it is HIS family's row (lib/channel/founder/ping.ts). A
 *      bare "yes" with nothing standing claims nothing, so this handler cannot text a
 *      stranger off a stray affirmative.
 *   2. THE OFFER IS FRESH. Past its TTL (ping.ts) it stops being
 *      answerable — a welcome that lands on the fourth day is not a welcome — and the turn
 *      falls through to the coach, which will read what he actually said.
 *   3. THE FAMILY IS STILL REACHABLE, read LIVE off `parent_channels` and never off the
 *      CASL ledger. `consent_records` is append-only: a family who pressed STOP an hour
 *      after joining still has a granted=true row forever, so a consent query would text
 *      somebody who unsubscribed. `resolveSendablePhone` is the live state, and a null
 *      from it closes the offer rather than sending.
 *
 * CASL: the family originated contact minutes earlier (`sms_intake_origination`), which
 * is the strongest basis this product has — and check 3 is what keeps that true at the
 * moment of the send rather than at the moment of the offer.
 *
 * NO OUTBOUND GATE, and it is a decision rather than an omission. `assertProactiveSendAllowed`
 * governs Hale texting a family FIRST; this is a person answering a conversation the family
 * themselves started, in the same window the `intake` category is deliberately exempt for —
 * and the gate would refuse it outright, because a family this new has not answered the
 * watch offer yet. The residual is quiet hours: the offer stands for two days, so a YES on
 * the second evening can put the note in front of a household at 22:00. It is one message,
 * a human chooses when to send it, and holding it would need a queue this lane does not
 * have — but it is the one thing here a product decision could still change.
 *
 * CONVERGENT, NOT TRANSACTIONAL, like the plan lane: the note carries its own dedupe key,
 * so a turn that sent the note and then failed to answer the founder is re-drivable — the
 * re-drive finds the note already gone, skips it, and closes the offer against the row
 * that carried it. The closure happens LAST for the same reason every MEM-10 writer closes
 * late.
 */

/** The at-most-once key for the note, per receiving family. What makes the re-drive above
 * cost nothing and stops a second YES sending a second note. */
export function founderNoteDedupeKey(familyId: string): string {
  return `founder-welcome-note:${familyId}`;
}

export type FounderReplyOutcome =
  | { status: 'declined_to_claim' }
  /** The note is in their thread. `noteChannelMessageId` is what the offer is closed
   * against — the message that made good, not the ack the founder gets. */
  | { status: 'note_sent'; reply: string; noteChannelMessageId: string }
  /** He said no. The offer is voided with a reason, because the note was never sent and a
   * ledger that recorded it as kept would be the one lie this table must not tell. */
  | { status: 'offer_declined'; reply: string }
  /**
   * Claimed, and nothing reached the family. Named rather than folded in with either of
   * the above (rule #11): `unreachable` closed the offer because there is nothing left to
   * reach, `send_failed` left it OPEN because there is — and the founder is told which.
   */
  | { status: 'not_sent'; reason: 'unreachable' | 'send_failed'; reply: string };

/** Who the note goes to, resolved live. */
export interface FounderNoteRecipient {
  parentUserId: string;
  phoneE164: string;
}

export interface FounderReplyDeps {
  loadOpenOffer: typeof loadOpenCommitment;
  /**
   * The arriving family's primary parent and their LIVE sendable number, or null when
   * there is no longer one to send to.
   */
  resolveRecipient(
    database: Database,
    familyId: string,
  ): Promise<FounderNoteRecipient | null>;
  /** REQUIRED (rule #11). A lane that can decide to send a personal note and then hold no
   * way to send it would close the offer, tell the founder it went, and text nobody. */
  transport: ChannelTransport;
  /**
   * Put the note in the RECEIVING family's own text thread — REQUIRED, same reason as
   * the transport (rule #11). It is Hale's first personal words to that household and
   * it invites an answer ("just say so right here"); `channel_messages` carries no body
   * (rule #1), so a note that skips this is one the coach cannot see when they take it
   * up. Their thread, never the founder's: one household's transcript never carries
   * another's (lib/channel/thread.ts).
   */
  threadMessage: typeof threadProactiveMessage;
  fulfillCommitment: typeof fulfillCommitment;
  cancelCommitment: typeof cancelCommitment;
}

export async function handleFounderWelcomeReply(
  database: Database,
  input: {
    /** The FOUNDER's family — the thread this reply arrived on, and the family the offer
     * is recorded against. */
    familyId: string;
    parentUserId: string;
    body: string;
    now: Date;
    /** The router's natural-reply stage already read this message as an answer to the open
     * welcome offer (lib/channel/router/resolve.ts). It NAMES the question, so it is
     * trusted over the word match. */
    resolved?: 'yes' | 'no' | null;
  },
  deps: FounderReplyDeps,
): Promise<FounderReplyOutcome> {
  // Checked before any query: this handler runs on every inbound text in the product, and
  // an ordinary message must not cost it a round trip.
  const word = readAffirmative(input.body);
  const answer = input.resolved ?? (word === 'unclear' ? null : word);
  if (answer === null) return { status: 'declined_to_claim' };

  const offer = await deps.loadOpenOffer(database, input.familyId, 'founder_welcome_offer');
  if (!offer || offer.dueAt.getTime() < input.now.getTime()) {
    return { status: 'declined_to_claim' };
  }

  if (answer === 'no') {
    await deps.cancelCommitment(database, {
      familyId: input.familyId,
      kind: 'founder_welcome_offer',
      reason: 'founder_welcome_declined',
      now: input.now,
    });
    return { status: 'offer_declined', reply: FOUNDER_NOTE_DECLINED_ACK };
  }

  // The poster this family walked in from, read back off the offer's own `topic`. A code
  // this build no longer knows cannot name a place, and a note with a blank where the
  // town should be is worse than no note — so the offer is closed rather than guessed at.
  const location = posterLocation(offer.topic);
  const targetFamilyId = offer.subjectFamilyId;
  if (targetFamilyId === null || location === null) {
    console.error(
      { founderFamilyId: input.familyId, topic: offer.topic, hasTarget: targetFamilyId !== null },
      'founder welcome: the offer no longer names a family or a poster - closed, no note sent',
    );
    return closeUnreachable(database, input, deps);
  }

  const recipient = await deps.resolveRecipient(database, targetFamilyId);
  if (!recipient) {
    console.error(
      { founderFamilyId: input.familyId },
      'founder welcome: the family has no live channel - closed, no note sent',
    );
    return closeUnreachable(database, input, deps);
  }

  const dedupeKey = founderNoteDedupeKey(targetFamilyId);
  const already = await sentNoteId(database, dedupeKey);
  if (already !== null) {
    return { status: 'note_sent', reply: FOUNDER_NOTE_SENT_ACK, noteChannelMessageId: already };
  }

  const body = founderNote(location);
  let providerMessageId: string;
  try {
    ({ providerMessageId } = await deps.transport.send({
      to: recipient.phoneE164,
      body,
    }));
  } catch (err) {
    console.error(
      { err, founderFamilyId: input.familyId },
      'founder welcome: the note did not reach the provider - offer left open, a second YES retries',
    );
    return { status: 'not_sent', reason: 'send_failed', reply: FOUNDER_NOTE_FAILED_ACK };
  }

  const noteChannelMessageId = await recordNote(database, {
    familyId: targetFamilyId,
    parentUserId: recipient.parentUserId,
    dedupeKey,
    providerMessageId,
    now: input.now,
  });
  // THE THREAD, on the receiving side. AFTER the send and unconditional: a note that
  // never reached a transport is not something Hale said to anyone.
  await deps.threadMessage(database, {
    familyId: targetFamilyId,
    parentUserId: recipient.parentUserId,
    body,
  });
  return { status: 'note_sent', reply: FOUNDER_NOTE_SENT_ACK, noteChannelMessageId };
}

/** The one closure for "there is nobody to send to". Voided rather than kept, with the
 * reason that says a channel was the obstacle — the ledger's existing word for it. */
async function closeUnreachable(
  database: Database,
  input: { familyId: string; now: Date },
  deps: FounderReplyDeps,
): Promise<FounderReplyOutcome> {
  await deps.cancelCommitment(database, {
    familyId: input.familyId,
    kind: 'founder_welcome_offer',
    reason: 'channel_revoked',
    now: input.now,
  });
  return { status: 'not_sent', reason: 'unreachable', reply: FOUNDER_NOTE_UNREACHABLE_ACK };
}

/** The note already in this family's thread, if a previous attempt got it out. Read by
 * dedupe key over the statuses that CONSUME one, so a failed delivery does not invite a
 * second note (channel/ledger.ts). */
async function sentNoteId(database: Database, dedupeKey: string): Promise<string | null> {
  const [row] = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.dedupeKey, dedupeKey),
        inArray(schema.channelMessages.status, [...CONSUMED_SEND_STATUSES]),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/**
 * The note's ledger row and its audit row, on the RECEIVING family — the household the
 * message actually reached.
 *
 * Rule #6, and rule #1 in the same breath: this is the row a PIPEDA access request for
 * that family renders, so it lives on their trail and carries no identifier belonging to
 * anybody else. The founder's own trail already has its half (`founder_welcome_offered`,
 * written when the ping went out).
 */
async function recordNote(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    dedupeKey: string;
    providerMessageId: string;
    now: Date;
  },
): Promise<string> {
  const [row] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'founder',
      templateKey: FOUNDER_NOTE_TEMPLATE_KEY,
      dedupeKey: input.dedupeKey,
      providerMessageId: input.providerMessageId,
      status: acceptedStatus('sms'),
      sentAt: input.now,
    })
    .returning({ id: schema.channelMessages.id });
  if (!row) throw new Error('founder welcome: channel_messages insert returned no row');

  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.parentUserId,
    actionTaken: 'founder_welcome_sent',
    targetTable: 'channel_messages',
    targetId: row.id,
  });
  return row.id;
}

// ── prod wiring ──────────────────────────────────────────────────────────────

/**
 * The primary parent of the arriving family, and the number they can be reached on RIGHT
 * NOW. Two reads rather than a join because the second one is the live-state gate
 * (sms-consent-core.ts) and belongs to the module that owns it.
 */
export async function resolveFounderNoteRecipient(
  database: Database,
  familyId: string,
): Promise<FounderNoteRecipient | null> {
  const [member] = await database
    .select({ userId: schema.familyMembers.userId })
    .from(schema.familyMembers)
    .where(
      and(
        eq(schema.familyMembers.familyId, familyId),
        eq(schema.familyMembers.role, 'primary_parent'),
      ),
    )
    .limit(1);
  if (!member) return null;

  const phoneE164 = await resolveSendablePhone(database, member.userId);
  return phoneE164 === null ? null : { parentUserId: member.userId, phoneE164 };
}

export function defaultFounderReplyDeps(): FounderReplyDeps {
  return {
    loadOpenOffer: loadOpenCommitment,
    resolveRecipient: resolveFounderNoteRecipient,
    transport: createTwilioTransport(),
    threadMessage: threadProactiveMessage,
    fulfillCommitment,
    cancelCommitment,
  };
}
