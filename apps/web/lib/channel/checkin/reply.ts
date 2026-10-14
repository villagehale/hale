import { type Database, schema } from '@hale/db';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { SENT_STATUSES } from '~/lib/channel/ledger';
import { askStillStanding, localDateKey, recordCheckInAnswer } from './cadence';
import { CHECK_IN_ASK_TEMPLATE_KEY } from './copy';
import { isNotKept, storeCheckInNote } from './notes';
import { type EveningRequestReader, eveningReplyIsRequest } from './request';

/**
 * VIL-353 · WHAT THE PARENT SAYS BACK.
 *
 * A sentence about the day is the answer. How often to check in is not read here:
 * there is no keyword and no word list. The proactive decider reads that from the
 * parent's own wording, in whatever language they wrote, the next time it decides.
 */

export type CheckInReplyStatus = 'note_stored' | 'not_stored_sensitive';

export type CheckInReplyOutcome =
  | { status: CheckInReplyStatus; reply: null }
  /** Not an answer to this question — the coach takes the turn. */
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
 * A MESSAGE ADDRESSED TO HALE IS NEVER CLAIMED (request.ts). A model reads whether
 * the sentence asks Hale for something. Filing a request as a diary entry would
 * answer the wrong half of their message, since the coach never sees it. A failed
 * read is a request too. The standing question simply lapses at 08:00.
 *
 * No reader is named `not_configured` and handed to the coach. Production always
 * passes one.
 */
export async function handleEveningCheckInReply(
  database: Database,
  input: CheckInReplyInput,
  reader?: EveningRequestReader,
): Promise<CheckInReplyOutcome> {
  const body = input.body.trim();
  if (body === '') return { status: 'declined_to_claim' };

  if (!reader) {
    console.info({ reason: 'not_configured' }, 'evening request: unreadable');
    return { status: 'declined_to_claim' };
  }
  const reading = await reader.read({ text: body });
  if (eveningReplyIsRequest(reading)) return { status: 'declined_to_claim' };

  // A sentence about the day. Screened first, because the whole point of the screen is
  // that the words never land in a store at all.
  if (isNotKept(body)) {
    await database.transaction(async (tx) => {
      await recordCheckInAnswer(tx, { familyId: input.familyId, cadence: null, now: input.now });
      await auditAnswer(tx, input, { stored: false });
    });
    return { status: 'not_stored_sensitive', reply: null };
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
  return { status: 'note_stored', reply: null };
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
 * A sentence is an answer only while this returns something. Pace ("text me less",
 * "每天提醒我") is not read here.
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
        // Old step-down notices share the category and ask nothing. Without this the
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
