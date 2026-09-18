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
  CHECK_IN_WEEKLY_ACK,
} from './copy';
import { isNotKept, storeCheckInNote } from './notes';

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
 * A BODY WITH A QUESTION MARK IS NEVER CLAIMED. "Fine, and can you find a swim class on
 * Saturdays?" is a parent asking Hale for something, and filing it as a diary entry would
 * answer the wrong half of their message — badly, since the coach never sees it. The
 * evening note is the cheap half of this exchange and the request is the expensive one,
 * so the ambiguity resolves toward the coach every time, and the standing question simply
 * lapses at 08:00.
 */
export async function handleEveningCheckInReply(
  database: Database,
  input: CheckInReplyInput,
): Promise<CheckInReplyOutcome> {
  const body = input.body.trim();
  if (body === '' || body.includes('?')) return { status: 'declined_to_claim' };

  const language = replyLanguage(input.body);
  const cadence = CADENCE_WORDS[body.toLowerCase().replace(/[.!]+$/, '')];
  if (cadence !== undefined) return moveCadence(database, input, cadence, language);

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

/** The parent moved the dial. Nothing about their day is written — the word IS the whole
 * message, and inventing a note out of it would be Hale remembering something nobody
 * said. */
async function moveCadence(
  database: Database,
  input: CheckInReplyInput,
  cadence: CheckInCadence,
  language: ReplyLanguage,
): Promise<CheckInReplyOutcome> {
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
