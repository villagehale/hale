import { type Database, schema } from '@hale/db';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { type ReplyLanguage, replyLanguage } from '~/lib/channel/language';
import { SENT_STATUSES } from '~/lib/channel/ledger';
import {
  type CheckInCadence,
  askStillStanding,
  localDateKey,
  recordCheckInAnswer,
} from './cadence';
import {
  CHECK_IN_ASK_TEMPLATE_KEY,
  CHECK_IN_DAILY_ACK,
  CHECK_IN_NOTED_ACK,
  CHECK_IN_NOT_KEPT_ACK,
  CHECK_IN_OFF_ACK,
  CHECK_IN_STEP_DOWN_TEMPLATE_KEY,
  CHECK_IN_WEEKLY_ACK,
} from './copy';
import { isNotKept, storeCheckInNote } from './notes';
import { asksHaleForSomething } from './request';

/**
 * VIL-353 · WHAT THE PARENT SAYS BACK.
 *
 * Three words move the cadence and everything else is the answer itself. The two halves
 * are deliberately not symmetrical: a keyword is a decision about the product, and a
 * sentence is a fact about a family's evening, so only one of them is written down and
 * only one of them can be refused.
 */

/** The three words the ask itself teaches, plus the French a francophone parent would
 * reach for. Whole-string, never a substring: "no swimming tonight" is an answer. */
const CADENCE_WORDS: Record<string, CheckInCadence> = {
  less: 'weekly',
  weekly: 'weekly',
  no: 'off',
  non: 'off',
  daily: 'daily',
  nightly: 'daily',
};

/** The cadence this message asks for, or null if it is not one of the words. */
export function readCadenceWord(body: string): CheckInCadence | null {
  return CADENCE_WORDS[body.trim().toLowerCase().replace(/[.!]+$/, '')] ?? null;
}

export type CheckInReplyStatus =
  | 'cadence_weekly'
  | 'cadence_off'
  | 'cadence_daily'
  | 'note_stored'
  | 'not_stored_sensitive';

export type CheckInReplyOutcome =
  | { status: CheckInReplyStatus; reply: string }
  /** Not an answer to this question — the coach takes the turn (see the '?' rule). */
  | { status: 'declined_to_claim' };

export interface CheckInReplyInput {
  familyId: string;
  parentUserId: string;
  body: string;
  /** When Hale asked, off the standing question — the note is filed under THAT local
   * day, so a parent answering at 00:20 is still telling Hale about yesterday. */
  askedAt: Date;
  timeZone: string;
  /** The inbound row that carried these words. The note's provenance, and the audit
   * row's target. */
  inboundChannelMessageId: string;
  now: Date;
}

/**
 * Read the parent's reply, move what it moves, and say one sentence back.
 *
 * A MESSAGE ADDRESSED TO HALE IS NEVER CLAIMED (request.ts). "Fine, and can you find a
 * swim class on Saturdays?" is a parent asking Hale for something, and filing it as a
 * diary entry would answer the wrong half of their message — badly, since the coach never
 * sees it. The evening note is the cheap half of this exchange and the request is the
 * expensive one, so the ambiguity resolves toward the coach every time, and the standing
 * question simply lapses at 08:00.
 */
export async function handleEveningCheckInReply(
  database: Database,
  input: CheckInReplyInput,
): Promise<CheckInReplyOutcome> {
  const body = input.body.trim();
  if (body === '') return { status: 'declined_to_claim' };

  const language = replyLanguage(input.body);
  // The taught word first, so a keyword is never mistaken for a request or a diary line.
  const cadence = readCadenceWord(body);
  if (cadence !== null) return applyCheckInCadence(database, { ...input, cadence, language });

  if (asksHaleForSomething(body)) return { status: 'declined_to_claim' };

  // A sentence about the day. Screened first, because the whole point of the screen is
  // that the words never land in a store at all.
  if (isNotKept(body)) {
    await database.transaction(async (tx) => {
      await recordCheckInAnswer(tx, { familyId: input.familyId, cadence: null, now: input.now });
      await auditAnswer(tx, input, { stored: false });
    });
    return { status: 'not_stored_sensitive', reply: CHECK_IN_NOT_KEPT_ACK[language] };
  }

  await database.transaction(async (tx) => {
    await storeCheckInNote(tx, {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      sourceMessageId: input.inboundChannelMessageId,
      notedOn: localDateKey(input.askedAt, input.timeZone),
      note: body,
      now: input.now,
    });
    await recordCheckInAnswer(tx, { familyId: input.familyId, cadence: null, now: input.now });
    await auditAnswer(tx, input, { stored: true });
  });
  return { status: 'note_stored', reply: CHECK_IN_NOTED_ACK[language] };
}

const CADENCE_ACK: Record<CheckInCadence, Record<ReplyLanguage, string>> = {
  weekly: CHECK_IN_WEEKLY_ACK,
  off: CHECK_IN_OFF_ACK,
  daily: CHECK_IN_DAILY_ACK,
};

const CADENCE_STATUS: Record<CheckInCadence, CheckInReplyStatus> = {
  weekly: 'cadence_weekly',
  off: 'cadence_off',
  daily: 'cadence_daily',
};

/**
 * The parent moved the dial. Nothing about their day is written — the word IS the whole
 * message, and inventing a note out of it would be Hale remembering something nobody
 * said.
 *
 * EXPORTED, because the dial moves whether or not a question is standing. Every ack this
 * lane sends prints "Reply NO anytime" or "Reply DAILY to switch back", and a promise
 * that only holds until Hale's next outbound message is not a promise (see
 * {@link lastCheckInAskToParent}).
 */
export async function applyCheckInCadence(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    inboundChannelMessageId: string;
    cadence: CheckInCadence;
    language: ReplyLanguage;
    now: Date;
  },
): Promise<{ status: CheckInReplyStatus; reply: string }> {
  const { cadence, language } = input;
  await database.transaction(async (tx) => {
    await recordCheckInAnswer(tx, { familyId: input.familyId, cadence, now: input.now });
    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: 'parent',
      actorUserId: input.parentUserId,
      actionTaken: 'evening_check_in_cadence_changed',
      targetTable: 'channel_messages',
      targetId: input.inboundChannelMessageId,
      after: { cadence },
    } as never);
  });
  return { status: CADENCE_STATUS[cadence], reply: CADENCE_ACK[cadence][language] };
}

/** Rule #6, and NOTHING the parent wrote: the row says an answer arrived and whether it
 * was kept. The words themselves are on the inbound message this row points at, which is
 * the one copy of them with a lifetime. */
async function auditAnswer(
  tx: Pick<Database, 'insert'>,
  input: CheckInReplyInput,
  after: { stored: boolean },
): Promise<void> {
  await tx.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: 'parent',
    actorUserId: input.parentUserId,
    actionTaken: 'evening_check_in_answered',
    targetTable: 'channel_messages',
    targetId: input.inboundChannelMessageId,
    after,
  } as never);
}

// ── the open question, derived from the ledger ───────────────────────────────

/**
 * The evening question, open ONLY while its ask is Hale's last word to this parent and
 * the morning has not come (`OpenQuestionSources.eveningCheckIn`).
 *
 * NO ROW AND NO COLUMN BEHIND IT — the registration ladder's readiness pattern, for the
 * same reason and with one addition. Both facts this needs are already in
 * `channel_messages`: when the ask went out, and whether anything has gone out since. A
 * stored `question_open` flag would be a second answer to a question the ledger already
 * answers, and it would have to be cleared by every other sender in the product.
 *
 * THE ADDITION IS THE MORNING. A last-word rule alone would leave the question standing
 * all of the next day for a household Hale happens not to text, and a parent's Tuesday
 * afternoon "sure, book it" would be filed as Monday's diary. So the ask also lapses at
 * 08:00 local (askStillStanding) — the hour the quiet window ends, and the hour after
 * which a text is a new conversation rather than the end of last night's.
 *
 * PER PARENT, not per family: the question was put to the primary parent's phone, and a
 * co-parent's evening is not the one Hale asked about.
 */
export async function eveningCheckInQuestion(
  database: Database,
  input: { familyId: string; parentUserId: string; now: Date },
): Promise<{ id: string; askedAt: Date } | null> {
  const [ask] = await database
    .select({ id: schema.channelMessages.id, createdAt: schema.channelMessages.createdAt })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, input.familyId),
        eq(schema.channelMessages.parentUserId, input.parentUserId),
        eq(schema.channelMessages.direction, 'out'),
        eq(schema.channelMessages.category, 'evening_check_in'),
        // The step-down notice shares the category and asks nothing. Without this the
        // parent's next text would be filed as a day note against an announcement.
        eq(schema.channelMessages.templateKey, CHECK_IN_ASK_TEMPLATE_KEY),
        // SENT_STATUSES rather than the dedupe key's CONSUMED set: a 'failed' send
        // consumed the key but never reached the phone, and a question nobody was asked
        // is not open.
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
      ),
    )
    .orderBy(desc(schema.channelMessages.createdAt))
    .limit(1);
  if (!ask) return null;

  const [newer] = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.parentUserId, input.parentUserId),
        eq(schema.channelMessages.direction, 'out'),
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
        gt(schema.channelMessages.createdAt, ask.createdAt),
      ),
    )
    .limit(1);
  if (newer) return null;

  const [row] = await database
    .select({ timezone: schema.users.timezone })
    .from(schema.users)
    .where(eq(schema.users.id, input.parentUserId))
    .limit(1);
  if (!row) return null;

  return askStillStanding(ask.createdAt, input.now, row.timezone)
    ? { id: ask.id, askedAt: ask.createdAt }
    : null;
}

/**
 * The last thing this lane said to this parent, standing question or not.
 *
 * THE WORDS OUTLIVE THE WINDOW. Every message this lane sends teaches a keyword and
 * promises it works later — "Reply NO anytime to drop these", "reply DAILY any evening to
 * switch back" — and the standing question does not: it closes the moment any other
 * outbound reaches the parent, and the ack that answered them is itself one. So a parent
 * who replied NO to a nightly message one minute after Hale's thank-you kept receiving
 * it, which is the shape of an ignored opt-out however small the feature.
 *
 * THE LEDGER IS THE RECORD OF WHAT HALE ACTUALLY SAID, which is why this reads it rather
 * than the prefs row: a prefs write that never landed would leave a family that was asked
 * looking like one that never was, and it is exactly that family whose NO must work. The
 * step-down notice counts too — it is the message that teaches DAILY.
 */
export async function lastCheckInAskToParent(
  database: Database,
  input: { familyId: string; parentUserId: string },
): Promise<string | null> {
  const [row] = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, input.familyId),
        eq(schema.channelMessages.parentUserId, input.parentUserId),
        eq(schema.channelMessages.direction, 'out'),
        eq(schema.channelMessages.category, 'evening_check_in'),
        inArray(schema.channelMessages.templateKey, [
          CHECK_IN_ASK_TEMPLATE_KEY,
          CHECK_IN_STEP_DOWN_TEMPLATE_KEY,
        ]),
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
      ),
    )
    .orderBy(desc(schema.channelMessages.createdAt))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Did this answer arrive through the same door the question went out of?
 *
 * A parent reaches Hale by text, by WhatsApp and by email, and the router hands every one
 * of them to the same chain. The evening question is a text; a forwarded school newsletter
 * arriving by email at 21:00 is not an answer to it, and filing it as one both loses the
 * email and writes a day note nobody dictated. The comparison is against the ASK's own
 * row rather than a hard-coded 'sms', so the day this lane learns another door the rule
 * still holds.
 */
export async function answeredOnTheSameChannel(
  database: Database,
  askMessageId: string,
  inboundMessageId: string,
): Promise<boolean> {
  const rows = await database
    .select({ id: schema.channelMessages.id, channel: schema.channelMessages.channel })
    .from(schema.channelMessages)
    .where(inArray(schema.channelMessages.id, [askMessageId, inboundMessageId]));
  const ask = rows.find((row) => row.id === askMessageId);
  const inbound = rows.find((row) => row.id === inboundMessageId);
  return ask !== undefined && inbound !== undefined && ask.channel === inbound.channel;
}
