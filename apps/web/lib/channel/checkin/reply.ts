import { type Database, schema } from '@hale/db';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { type ReplyLanguage, replyLanguage } from '~/lib/channel/language';
import { SENT_STATUSES } from '~/lib/channel/ledger';
import {
  type CheckInCadence,
  askStillStanding,
  localDateKey,
  readCheckInState,
  recordCheckInAnswer,
} from './cadence';
import {
  CHECK_IN_ACK_TEMPLATE_KEY,
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
 * EXPORTED, because the dial moves whether or not a question is standing. Every message
 * this lane sends prints "Reply NO to drop these" or "reply DAILY to switch back", and a
 * word that only worked until Hale's next sentence — its own thank-you included — would be
 * a word the parent was taught and then quietly denied. How far it does reach is
 * {@link checkInKeywordReach}.
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
 *
 * WHAT CLOSES HERE IS THE QUESTION, NOT THE KEYWORDS. A SENTENCE is only an answer while
 * this returns something; LESS, NO and DAILY reach further, because the messages that
 * teach them are still the last thing Hale said (checkInKeywordReach).
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

  const timeZone = await parentTimeZone(database, input.parentUserId);
  if (timeZone === null) return null;

  return askStillStanding(ask.createdAt, input.now, timeZone)
    ? { id: ask.id, askedAt: ask.createdAt }
    : null;
}

/** The clock the evening is read on — the PARENT's, since the question went to their
 * phone. Absent only when the user row is gone, which is not a state this lane acts in. */
async function parentTimeZone(database: Database, parentUserId: string): Promise<string | null> {
  const [row] = await database
    .select({ timezone: schema.users.timezone })
    .from(schema.users)
    .where(eq(schema.users.id, parentUserId))
    .limit(1);
  return row?.timezone ?? null;
}

/**
 * How long after this lane last spoke its taught words still mean what it taught them to.
 *
 * It bounds BOTH clauses below. The last-word clause is a statement about the shape of the
 * conversation, and a conversation nobody has added to in a month is not one — a household
 * Hale asked once and then never texted again would otherwise have 'no' claimed by this
 * lane for the rest of their life.
 */
export const CHECK_IN_REOFFER_DAYS = 30;

const REOFFER_MS = CHECK_IN_REOFFER_DAYS * 24 * 3_600_000;

/**
 * HOW FAR A TAUGHT WORD REACHES — the answer to "may this lane claim LESS, NO or DAILY
 * from this parent right now".
 *
 * `standing` is the lane holding the floor and the words meaning what they were taught to.
 * `reoffer` is the narrow afterwards in which DAILY alone still means something.
 */
export type CheckInKeywordReach =
  | { reach: 'standing'; askId: string }
  | { reach: 'reoffer'; askId: string }
  | { reach: 'none' };

/**
 * WHEN LESS, NO AND DAILY BELONG TO THIS LANE.
 *
 * These six words ('less', 'weekly', 'no', 'non', 'daily', 'nightly') are the broadest
 * claim in the product and they are ordinary English, so the question is not whether Hale
 * ever taught them but whether THIS is still the conversation it taught them in. The rule
 * is the floor, and it is two clauses:
 *
 *   · THE LANE HAS THE LAST WORD — its ask, its step-down notice or ONE OF ITS OWN ACKS is
 *     the most recent outbound of any kind to this parent, and it spoke inside
 *     {@link CHECK_IN_REOFFER_DAYS}. Hale's last sentence to them was "How did today go?"
 *     or "Noted - thanks", so 'no' is an answer to that and to nothing else, whether it
 *     comes back in a minute or the following afternoon.
 *
 *     THE ACKS ARE IN THAT LIST BECAUSE THE FLOOR IS NOT A QUESTION. A parent who answers
 *     the evening question gets a thank-you, and a thank-you is an outbound — so without
 *     it, every ANSWERED evening ended this lane's claim on its own words the moment it
 *     said thank you, and the NO that came the next afternoon went to the coach while the
 *     nightly message kept arriving. Hale hearing a parent out must not cost the parent
 *     the way to stop being asked.
 *   · OR THE EVENING IS STILL OPEN — `askStillStanding`, this local evening through 08:00
 *     the next morning. The narrow clause the one above cannot cover: a household Hale
 *     texts about something else at 21:00 still gets to say NO to tonight's question.
 *
 * OUTSIDE BOTH, LESS AND NO GO WHERE THEY WENT BEFORE THIS LANE EXISTED — to the coach.
 * A bare 'no' three weeks after an ask, with another lane's message in between and nothing
 * open, is a parent declining something else; claiming it filed a cadence change and
 * swallowed the turn. The lane loses a keyword it had no business holding; it does not
 * lose an opt-out, because the opt-out is STOP and that never came near here.
 *
 * DAILY IS THE ONE EXCEPTION, and only as a way BACK IN: a household Hale has stepped down
 * or gone quiet on hears from this lane weekly or never, so the two clauses above can only
 * be false for them — and a dormant family with no route back is a feature that cannot be
 * un-quit. So DAILY is honoured while the cadence is not already daily (there is something
 * to return from) and this lane spoke inside {@link CHECK_IN_REOFFER_DAYS}. Past that the
 * word is stale and the coach takes it, which is also where a family who said NO last
 * spring gets their answer.
 */
export async function checkInKeywordReach(
  database: Database,
  input: { familyId: string; parentUserId: string; now: Date },
): Promise<CheckInKeywordReach> {
  const last = await lastCheckInMessageToParent(database, input);
  if (last === null) return { reach: 'none' };
  const spokeRecently = input.now.getTime() - last.createdAt.getTime() <= REOFFER_MS;

  const [newer] = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.parentUserId, input.parentUserId),
        eq(schema.channelMessages.direction, 'out'),
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
        gt(schema.channelMessages.createdAt, last.createdAt),
      ),
    )
    .limit(1);
  if (!newer && spokeRecently) return { reach: 'standing', askId: last.id };

  const timeZone = await parentTimeZone(database, input.parentUserId);
  if (timeZone !== null && askStillStanding(last.createdAt, input.now, timeZone)) {
    return { reach: 'standing', askId: last.id };
  }

  const { cadence } = await readCheckInState(database, input.familyId);
  return cadence !== 'daily' && spokeRecently
    ? { reach: 'reoffer', askId: last.id }
    : { reach: 'none' };
}

/**
 * The last thing this lane said to this parent, standing question or not.
 *
 * THE LEDGER IS THE RECORD OF WHAT HALE ACTUALLY SAID, which is why this reads it rather
 * than the prefs row: a prefs write that never landed would leave a family that was asked
 * looking like one that never was, and it is exactly that family whose NO must work.
 *
 * ALL THREE OF THIS LANE'S TEMPLATE KEYS, and the set is what "this lane" MEANS here — the
 * question, the step-down notice that teaches DAILY, and the acks, which is how the lane
 * keeps the floor after thanking a parent for answering. The keys are namespaced, so they
 * identify the sender on their own; the category is not asked for, because an ack is a
 * `reply` row written by the router and matching on `evening_check_in` would find only the
 * proactive half.
 */
async function lastCheckInMessageToParent(
  database: Database,
  input: { familyId: string; parentUserId: string },
): Promise<{ id: string; createdAt: Date } | null> {
  const [row] = await database
    .select({ id: schema.channelMessages.id, createdAt: schema.channelMessages.createdAt })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, input.familyId),
        eq(schema.channelMessages.parentUserId, input.parentUserId),
        eq(schema.channelMessages.direction, 'out'),
        inArray(schema.channelMessages.templateKey, [
          CHECK_IN_ASK_TEMPLATE_KEY,
          CHECK_IN_STEP_DOWN_TEMPLATE_KEY,
          CHECK_IN_ACK_TEMPLATE_KEY,
        ]),
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
      ),
    )
    .orderBy(desc(schema.channelMessages.createdAt))
    .limit(1);
  return row ?? null;
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
