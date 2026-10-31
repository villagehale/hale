import { randomUUID } from 'node:crypto';
import { type Database, householdFamilyEvent, schema } from '@hale/db';
import { and, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { unapprovedCalendarAddIds } from '~/lib/channel/calendar-ask';
import { DEFAULT_TIMEZONE, formatDayHeading } from '~/lib/format/datetime';
import type { ExtractionKind } from '~/lib/sentinel';
import { stampBookingEvent } from './booking';
import type { OfferReceiptFacts } from './offer-receipt';

/**
 * Coach-originated offers have no Gmail connection. This id is the provenance, not a
 * row in `integrations`: the column is deliberately not a foreign key. One channel
 * message is one coach offer, via `messageId`.
 */
export const COACH_CALENDAR_INTEGRATION_ID = '00000000-0000-4000-8000-000000000410';

/**
 * THE YES AT THE END OF AN EMAIL ALERT — the row it lands in, and what it does.
 *
 * The alert asks "Want me to add it to your week?" The earlier wording, "Reply YES and
 * it goes on your week," was shipped once with nothing behind it and removed in #649,
 * because a parent doing exactly what the
 * text told them to do reached the coach with nothing drafted — or, with one unrelated
 * action pending, APPROVED THAT ONE (rule #4). This module is the thing that had to exist
 * before the sentence could come back: an offer written down at send time, listed as an
 * open question like every other one, and a resolution that puts the occasion on the
 * family's week where the reminders and the weekly plan can both see it.
 *
 * TWO DEPARTURES FROM THE PRODUCT'S NORMAL CALENDAR PATH, both deliberate and neither
 * slipped in:
 *
 *   1. IT WRITES `family_events` DIRECTLY. Every other calendar write in Hale is drafted,
 *      reviewer-verified (rule #3) and executed. Nothing is executed here: no provider is
 *      called, no money moves, nothing leaves the household. The parent's YES is itself
 *      the per-action consent rule #4 asks for — it answers a specific, written-down
 *      offer naming a specific occasion — and the receipt says how to take it off again.
 *      A reviewer pass would be a model asked to re-approve a sentence the parent already
 *      answered.
 *   2. IT WRITES `source = 'parent'`, which nothing in the product wrote before. That is
 *      not a coincidence to paper over: it is the ONLY source value that both the
 *      reminder scheduler (`loadHorizonEvents`, placement + parent) and the weekly-plan
 *      composer (`listFamilyEventsInWindow`, everything but placement) read. A
 *      `placement` row would be silently dropped from the week the sentence promised, and
 *      an `email` row would be silently dropped from the reminders. The parent asked for
 *      it, so `parent` is also the true answer to who put it there.
 *
 * WHAT IS NOT CARRIED OVER. `childId` is NULL: the extraction's `childRef` is documented
 * as suggestive and never a binding (sentinel/types.ts), and binding a child here would
 * hand the teen age gate a guess. `sensitive` keeps its default. Neither is a gap to fill
 * later without a parent saying so.
 */

/** How long an offer stands. ONE DAY, and it is the alert's own relevance window rather
 * than a new number: the outbound gate lets a household hear at most three of these in
 * 24 hours, so a day is exactly the span over which "the thing Hale just texted me about"
 * is still one identifiable thing. Applied at the READER, never by a sweep. */
export const EMAIL_ALERT_OFFER_TTL_MS = 24 * 60 * 60 * 1000;

/** How long the placed occasion lasts when the email never said. An hour is the shape of
 * nearly every thing a school or a pool puts in a parent's calendar, and a point event
 * (`ends_at` null) reads as a zero-length slot in the ICS feed. */
export const EMAIL_ALERT_EVENT_DURATION_MS = 60 * 60 * 1000;

/**
 * The occasion an email alert is offering to put on the week, already sanitised.
 *
 * Built by {@link emailAlertOfferDraft} in email-alert.ts, from the typed extraction and
 * nothing else — the same title the text itself says, through the same fold. Null there
 * means there is nothing to offer, and null is what keeps the sentence off the text.
 */
export interface EmailAlertOfferDraft {
  kind: ExtractionKind;
  title: string;
  startsAt: Date;
  location: string | null;
}

/**
 * Write the offer down, against the message that carried it.
 *
 * AFTER THE SEND, never before: an offer nobody was told about is not an offer, and a row
 * minted for a text the transport refused would make every bare affirmative in the
 * household ambiguous for a day, for a question nobody was ever asked (the MEM-10
 * send-time discipline, and `watched_spots.created_from`'s own rule).
 *
 * `onConflictDoNothing` on (connection, message): one email is one offer, forever, so a
 * re-fired sweep conflicts here instead of minting a second question.
 *
 * NEVER PAST THE OCCASION (VIL-410). The offer expires at the TTL or at `startsAt`,
 * whichever comes first, and an occasion that has already started gets no row at all
 * (`event_started`): once it has begun there is nothing left to put on the week, and a
 * bare YES answering a stale offer put a class that had already happened on a real
 * family's calendar.
 */
export async function recordEmailAlertOffer(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    integrationId: string;
    messageId: string;
    channelMessageId: string;
    draft: EmailAlertOfferDraft;
    now: Date;
  },
): Promise<'recorded' | 'event_started'> {
  const startsAt = input.draft.startsAt.getTime();
  if (startsAt <= input.now.getTime()) return 'event_started';
  await database
    .insert(schema.emailAlertOffers)
    .values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      integrationId: input.integrationId,
      messageId: input.messageId,
      kind: input.draft.kind,
      title: input.draft.title,
      startsAt: input.draft.startsAt,
      location: input.draft.location,
      channelMessageId: input.channelMessageId,
      expiresAt: new Date(Math.min(input.now.getTime() + EMAIL_ALERT_OFFER_TTL_MS, startsAt)),
    })
    .onConflictDoNothing();
  return 'recorded';
}

/** A standing offer this parent may still answer. */
export interface OpenEmailAlertOffer {
  id: string;
  kind: ExtractionKind;
  title: string;
  startsAt: Date;
  location: string | null;
  /** WHICH EMAIL this offer came from — the pair that is also the identity of the
   * `activity_bookings` row born from the same message, which is how the placement stamps
   * the event onto the booking without a third id threaded through the router. The select
   * below was already a full-row `select()`; these two were simply dropped by the mapper. */
  integrationId: string;
  messageId: string;
  /** The event this offer already placed, or null — see the column's own note. */
  eventId: string | null;
  /** When the alert that carried the offer went out. The open-question reader's recency
   * fact, and it is the ledger row's own mint time because the row is written at send. */
  askedAt: Date;
}

/**
 * THE offer this parent may answer right now, or null.
 *
 * THE TTL IS APPLIED HERE, at the one reader, so an expired offer can never be listed as
 * an open question, never named in a clarifying sentence and never resolved — the same
 * discipline the plan, checkup and founder offers keep. So is THE OCCASION'S START: rows
 * written before expiry was capped at `startsAt` still carry a flat day (VIL-410).
 *
 * PER PARENT, not per family. The offer was put to one phone; a co-parent who never saw
 * the text must not be able to answer it, for the same reason the intro opt-in and the
 * co-parent scope question are per-parent.
 *
 * Newest first. The gate permits three alerts a day, and two standing offers are an
 * ambiguity the model has to name. This reader does not pick one.
 */
export async function loadOpenEmailAlertOffers(
  database: Database,
  input: { familyId: string; parentUserId: string; now: Date },
): Promise<OpenEmailAlertOffer[]> {
  const rows = await database
    .select()
    .from(schema.emailAlertOffers)
    .where(
      and(
        eq(schema.emailAlertOffers.familyId, input.familyId),
        eq(schema.emailAlertOffers.parentUserId, input.parentUserId),
        isNull(schema.emailAlertOffers.resolvedAt),
        gt(schema.emailAlertOffers.expiresAt, input.now),
        gt(schema.emailAlertOffers.startsAt, input.now),
      ),
    )
    .orderBy(desc(schema.emailAlertOffers.createdAt));
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as ExtractionKind,
    title: row.title,
    startsAt: row.startsAt,
    location: row.location,
    integrationId: row.integrationId,
    messageId: row.messageId,
    eventId: row.eventId,
    askedAt: row.createdAt,
  }));
}

/**
 * The offer in one parent-safe sentence — what the RESOLVER is shown as the question.
 *
 * The title and nothing else. It is admissible under rule #1's strictest reading for the
 * one reason the module header gives: Hale already texted this parent exactly this
 * string. The subject line, the snippet and the quote evidence are not here and are not
 * in the row either.
 */
export function emailAlertOfferSummary(offer: OpenEmailAlertOffer): string {
  // The instant is part of the question the model reads. Two offers can share a title
  // (Thursday gymnastics, Sunday gymnastics) and a summary without it cannot tell them
  // apart. ISO, not a rendered sentence: the receipt renderer owns the words.
  return `An offer to put ${offer.title} on your week, starting ${offer.startsAt.toISOString()}`;
}

/**
 * The offer as a phrase Hale can PRINT BACK in a clarifying sentence — "Which one - …?"
 *
 * IT HAS TO CARRY THE TITLE, and that is a correction rather than a preference. Every
 * other kind on the open list has one fixed phrase because a family can only ever have
 * one of them open; the outbound gate permits three of these a day, so two offers sharing
 * a constant would print "Which one - putting the one from your email on your week, or
 * putting the one from your email on your week?" — a question with no answer, and a word
 * pick that cannot land because the two subjects share every word (router/disambiguation
 * drops anything both options say).
 *
 * Admissible under rule #1's strictest reading for the reason {@link
 * emailAlertOfferSummary} gives: Hale already texted THIS parent this exact string, the
 * offer list is per-parent, and the subject line, the snippet and the quote evidence are
 * neither here nor on the row. A 13+ child's mail never writes an offer at all.
 */
export function emailAlertOfferSubject(offer: OpenEmailAlertOffer): string {
  return `putting ${offer.title} on your week`;
}

/** What answering an offer did. Every ending is named (rule #11) — `no_open_offer` is the
 * handler declining to claim, not a silent skip. The words the parent reads are not
 * here: `facts` is what a receipt writer is given, and a missing line is `receipt_unsent`
 * at the handler, never a template. */
export type EmailAlertOfferReplyOutcome =
  | { status: 'added'; offerId: string; facts: OfferReceiptFacts }
  | { status: 'declined'; offerId: string; facts: OfferReceiptFacts }
  | { status: 'no_open_offer' };

/**
 * A yes or a no, against the offer the answer is FOR.
 *
 * WHICH OFFER IS `offerId`'S QUESTION AND NOT THIS FUNCTION'S. A resolver reading, a
 * disambiguation pick and a menu ordinal all arrive carrying the row's own id
 * (`ResolvedAnswer.questionId` — "never a position"), and taking the newest instead would
 * apply a parent's consent to a question they did not answer: with two alerts standing, a
 * YES the resolver placed on this morning's swim class would have put this afternoon's
 * picture day on the week and left the swim class open. So a named id is honoured or
 * NOTHING is: an id that is no longer among this parent's open offers declines the turn
 * (the question closed between the two reads) rather than falling back to a neighbour.
 * There is no bare-word path. A reply the model did not name does not reach this function.
 *
 * THE ADD IS CLAIMED BEFORE IT IS WRITTEN. `event_id` is stamped on the offer by a guarded
 * update and the `family_events` row is inserted carrying that id, so the redrive of a
 * turn that placed the event and then failed to answer finds the claim, conflicts on the
 * primary key, and places nothing twice. The offer itself is closed by the CALLER, from
 * `afterSend`, against the message that told the parent — a turn that acted and never
 * spoke must leave the question standing (the MEM-10 discipline every other offer keeps).
 */
export async function handleEmailAlertOfferReply(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    /** The offer the model named. There is no bare-word path. */
    offerId: string;
    polarity: 'yes' | 'no';
    /** What the parent wrote, handed to the receipt writer so it can answer in kind. */
    parentReply: string;
    now: Date;
  },
): Promise<EmailAlertOfferReplyOutcome> {
  const open = await loadOpenEmailAlertOffers(database, input);
  const offer = open.find((row) => row.id === input.offerId);
  // A named id that is not open is a closed question, never an invitation to pick another
  // one. A start that has already passed is not open: the reader filters `startsAt > now`.
  if (!offer) return { status: 'no_open_offer' };

  const timeZone = await parentTimeZone(database, input.parentUserId);
  const facts: OfferReceiptFacts = {
    happened: input.polarity === 'yes' ? 'added' : 'declined',
    title: offer.title,
    when: when(offer.startsAt, timeZone, input.now),
    parentReply: input.parentReply,
  };

  if (input.polarity === 'no') {
    return { status: 'declined', offerId: offer.id, facts };
  }

  await placeOfferedEvent(database, offer, input);
  // The coach also drafted this add. The parent's YES just placed it, so the draft
  // must leave the queue or the next YES is not answerable and the coach drafts it again.
  await supersedeUnapprovedCalendarAdds(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    title: offer.title,
    startsAt: offer.startsAt,
    now: input.now,
  });
  return { status: 'added', offerId: offer.id, facts };
}

/**
 * Stop a coach calendar offer standing once the drafted action it asked about was
 * approved. Expiry, not a resolution: a resolution requires the outbound that told
 * the parent, and an approved draft sends none (VIL-504).
 */
export async function expireEmailAlertOffer(
  database: Database,
  input: { offerId: string; now: Date },
): Promise<'expired' | 'already_closed'> {
  const expired = await database
    .update(schema.emailAlertOffers)
    .set({ expiresAt: input.now })
    .where(
      and(
        eq(schema.emailAlertOffers.id, input.offerId),
        isNull(schema.emailAlertOffers.resolvedAt),
        gt(schema.emailAlertOffers.expiresAt, input.now),
      ),
    )
    .returning({ id: schema.emailAlertOffers.id });
  return expired.length > 0 ? 'expired' : 'already_closed';
}

async function supersedeUnapprovedCalendarAdds(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    title: string;
    startsAt: Date;
    now: Date;
  },
): Promise<void> {
  const rows = await database
    .select({
      id: schema.actions.id,
      actionType: schema.actions.actionType,
      reviewerVerdict: schema.actions.reviewerVerdict,
      payload: schema.actions.payload,
    })
    .from(schema.actions)
    .where(
      and(
        eq(schema.actions.familyId, input.familyId),
        eq(schema.actions.userVisibleState, 'drafted_for_approval'),
        eq(schema.actions.actionType, 'calendar_add'),
      ),
    )
    .limit(20);
  const ids = unapprovedCalendarAddIds(
    rows.map((row) => ({
      id: row.id,
      actionType: row.actionType,
      reviewerApproved: row.reviewerVerdict === 'approved',
      occasion: occasionFromPayload(row.payload),
    })),
    { title: input.title, startsAt: input.startsAt.toISOString() },
  );
  for (const id of ids) {
    await database.transaction(async (tx) => {
      const retired = await tx
        .update(schema.actions)
        .set({
          userVisibleState: 'reverted',
          revertedAt: input.now,
          revertedReason: 'superseded_by_calendar_offer',
        })
        .where(
          and(
            eq(schema.actions.id, id),
            eq(schema.actions.userVisibleState, 'drafted_for_approval'),
          ),
        )
        .returning({ id: schema.actions.id });
      if (!retired[0]) return;
      await tx.insert(schema.auditLog).values({
        familyId: input.familyId,
        actor: input.parentUserId,
        actionTaken: 'action.superseded_by_calendar_offer',
        targetTable: 'actions',
        targetId: id,
      });
    });
  }
}

function occasionFromPayload(payload: unknown): { title: string; startsAt: string } | null {
  if (!payload || typeof payload !== 'object') return null;
  const title = 'title' in payload && typeof payload.title === 'string' ? payload.title : '';
  const startsAt =
    'startsAt' in payload && typeof payload.startsAt === 'string' ? payload.startsAt : '';
  if (title.trim() === '' || startsAt.trim() === '') return null;
  return { title, startsAt };
}

/**
 * The claim, then the row.
 *
 * The guarded update is the arbiter: exactly one caller stamps `event_id`, every other
 * one reads the winner's id back and inserts nothing new. The insert carries that id as
 * its primary key and conflicts away, so the pair is idempotent under a redrive even
 * though it is two statements.
 */
async function placeOfferedEvent(
  database: Database,
  offer: OpenEmailAlertOffer,
  input: { familyId: string; parentUserId: string },
): Promise<void> {
  const claimed = await database
    .update(schema.emailAlertOffers)
    .set({ eventId: randomUUID() })
    .where(and(eq(schema.emailAlertOffers.id, offer.id), isNull(schema.emailAlertOffers.eventId)))
    .returning({ eventId: schema.emailAlertOffers.eventId });
  const eventId = claimed[0]?.eventId ?? offer.eventId;
  if (!eventId) {
    // The update matched nothing and the row this turn read carried no stamp either —
    // only reachable if the winner's transaction rolled back after we read it. Throw so
    // the drain redrives and the next pass settles it, rather than placing an unclaimed
    // second copy (rule #11: never a silent half-outcome).
    throw new Error(`email alert offer: lost the event claim for offer ${offer.id}`);
  }

  const placed = await database
    .insert(schema.familyEvents)
    .values({
      id: eventId,
      familyId: input.familyId,
      // The extraction's childRef is suggestive and never a binding — see the module
      // header. A family-wide occasion is the honest reading of an email.
      childId: null,
      title: offer.title,
      startsAt: offer.startsAt,
      endsAt: new Date(offer.startsAt.getTime() + EMAIL_ALERT_EVENT_DURATION_MS),
      location: offer.location,
      // The one source both the reminder scheduler and the weekly-plan composer read.
      source: 'parent',
      createdBy: input.parentUserId,
    })
    .onConflictDoNothing({ target: schema.familyEvents.id })
    .returning({ id: schema.familyEvents.id });

  // Rule #6, and only for the pass that actually placed it: a redrive that conflicted away
  // changed nothing, and audit_log is append-only, so a second row there would be a second
  // claim that a calendar entry was created.
  if (placed[0]) {
    await database.insert(schema.auditLog).values({
      familyId: input.familyId,
      // The PARENT, by their own id: they asked for this row, and the column's contract
      // is 'system' or a user uuid (audit.ts). 'system' here would attribute a parent's
      // decision to Hale.
      actor: input.parentUserId,
      actionTaken: 'email_alert_event_added',
      targetTable: 'family_events',
      targetId: eventId,
      // The extraction KIND and nothing else. Not the title, not the place, not the time:
      // an audit row a support agent can read is a copy of the email in a table that is
      // never redacted (the alert's own audit row keeps the same rule).
      after: { kind: offer.kind },
    });
  }

  // THE BOOKING THIS EMAIL ALSO WROTE, now on the calendar. Two rows from one email, so
  // the (connection, message) pair addresses both and no third id crosses the router.
  //
  // `no_booking` is the ORDINARY answer for the other five kinds and for a booking the
  // flag was dark for — nothing to stamp. For a `booking_confirmation` offer it is an
  // inconsistency: the same post-send stretch wrote both rows, so the booking should be
  // there. Logged rather than swallowed, and never thrown: the parent's event is already
  // placed and the receipt is already owed (rule #11).
  const stamped = await stampBookingEvent(database, {
    integrationId: offer.integrationId,
    messageId: offer.messageId,
    eventId,
  });
  if (stamped === 'no_booking' && offer.kind === 'booking_confirmation') {
    console.error(
      { familyId: input.familyId, offerId: offer.id },
      'email alert offer: a booking offer was placed with no booking row to stamp - the follow-up ask will not happen',
    );
  }
}

/**
 * THE PROVIDER CALLED THE CLASS OFF, so the question Hale asked about it is no longer
 * answerable — stop the offer standing.
 *
 * WHY THIS EXISTS. The offer stands for a day, and a cancellation that lands in hour three
 * leaves the last live path from a called-off class to the family's calendar wide open: a
 * parent reading their texts at bedtime says YES to the morning's "Want it on your
 * calendar?", and `placeOfferedEvent` writes the `family_events` row, the converger
 * schedules two reminders for it and the weekly plan prints it — a class Hale's own text
 * said was off.
 *
 * BY EXPIRY, NOT BY RESOLUTION, and that is the honest shape rather than a convenient one.
 * `expires_at` is documented as "when the offer stops being answerable", applied at the one
 * reader, which is exactly what happened here. A resolution would be a lie in the other
 * direction: the vocabulary is `added | declined`, the parent did neither, and the table's
 * own CHECK makes a resolution without the outbound message that carried it unwritable —
 * because a resolution is something Hale TOLD the parent, and nothing is told here.
 *
 * Guarded on still-open and still-standing so a redrive withdraws once and an offer the
 * parent already answered is left exactly as they left it.
 */
export async function withdrawEmailAlertOffer(
  database: Database,
  input: { integrationId: string; messageId: string; now: Date },
): Promise<'withdrawn' | 'nothing_standing'> {
  const withdrawn = await database
    .update(schema.emailAlertOffers)
    .set({ expiresAt: input.now })
    .where(
      and(
        eq(schema.emailAlertOffers.integrationId, input.integrationId),
        eq(schema.emailAlertOffers.messageId, input.messageId),
        isNull(schema.emailAlertOffers.resolvedAt),
        gt(schema.emailAlertOffers.expiresAt, input.now),
      ),
    )
    .returning({ id: schema.emailAlertOffers.id });
  return withdrawn.length > 0 ? 'withdrawn' : 'nothing_standing';
}

/**
 * Close the offer, against the message that told the parent.
 *
 * Guarded on `resolved_at IS NULL` so a redrive closes it once; the CHECK on the table
 * makes a resolution without its reason unwritable.
 */
export async function resolveEmailAlertOffer(
  database: Database,
  input: {
    offerId: string;
    resolution: 'added' | 'declined';
    /** The receipt — the outbound row that carried the answer. The table's CHECK makes a
     * resolution without one unwritable, because there is no other way to close one. */
    channelMessageId: string;
    now: Date;
  },
): Promise<void> {
  await database
    .update(schema.emailAlertOffers)
    .set({
      resolvedAt: input.now,
      resolution: input.resolution,
      resolvedChannelMessageId: input.channelMessageId,
    })
    .where(
      and(
        eq(schema.emailAlertOffers.id, input.offerId),
        isNull(schema.emailAlertOffers.resolvedAt),
      ),
    );
}

/** The parent's wall clock, off their own users row — post-filtered by id as every reader
 * of one row here is. */
export async function parentTimeZoneForOffer(
  database: Database,
  parentUserId: string,
): Promise<string> {
  const rows = await database
    .select({ id: schema.users.id, timezone: schema.users.timezone })
    .from(schema.users)
    .where(eq(schema.users.id, parentUserId));
  return rows.find((row) => row.id === parentUserId)?.timezone ?? DEFAULT_TIMEZONE;
}

async function parentTimeZone(database: Database, parentUserId: string): Promise<string> {
  return parentTimeZoneForOffer(database, parentUserId);
}

/**
 * The occasion is already on the week the household shares, or on this parent's
 * kid-related Google block. A mirror row (`google_event_id` set) is one parent's
 * calendar and is not a household event — the household predicate keeps it out.
 */
export async function occasionAlreadyHeld(
  database: Database,
  input: { familyId: string; parentUserId: string; title: string; startsAt: Date },
): Promise<boolean> {
  const title = input.title.trim().toLowerCase();
  const [event] = await database
    .select({ id: schema.familyEvents.id })
    .from(schema.familyEvents)
    .where(
      and(
        eq(schema.familyEvents.familyId, input.familyId),
        eq(schema.familyEvents.startsAt, input.startsAt),
        householdFamilyEvent(),
        sql`lower(trim(${schema.familyEvents.title})) = ${title}`,
      ),
    )
    .limit(1);
  if (event) return true;

  const [block] = await database
    .select({ eventId: schema.parentCalendarBlocks.eventId })
    .from(schema.parentCalendarBlocks)
    .where(
      and(
        eq(schema.parentCalendarBlocks.familyId, input.familyId),
        eq(schema.parentCalendarBlocks.userId, input.parentUserId),
        eq(schema.parentCalendarBlocks.kidRelated, true),
        eq(schema.parentCalendarBlocks.startAt, input.startsAt),
        ne(schema.parentCalendarBlocks.status, 'cancelled'),
        sql`lower(trim(${schema.parentCalendarBlocks.title})) = ${title}`,
      ),
    )
    .limit(1);
  return block !== undefined;
}

export type CoachCalendarOfferOutcome =
  | 'recorded'
  | 'event_started'
  | 'already_held'
  | 'unreadable';

/**
 * Write the offer a coach sentence named, after the send.
 *
 * The model supplied the title and the instant. This function does not read the
 * sentence. A start that has passed is not an offer. An occasion already on the
 * calendar is not an offer. Older open offers for this parent expire, because the
 * sentence the parent is holding is the question now.
 */
export async function recordCoachCalendarOffer(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    channelMessageId: string;
    title: string;
    startsAt: Date;
    location: string | null;
    now: Date;
  },
): Promise<CoachCalendarOfferOutcome> {
  const title = input.title.trim();
  if (title === '' || Number.isNaN(input.startsAt.getTime())) return 'unreadable';
  if (input.startsAt.getTime() <= input.now.getTime()) return 'event_started';
  if (
    await occasionAlreadyHeld(database, {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      title,
      startsAt: input.startsAt,
    })
  ) {
    return 'already_held';
  }

  await database
    .update(schema.emailAlertOffers)
    .set({ expiresAt: input.now })
    .where(
      and(
        eq(schema.emailAlertOffers.familyId, input.familyId),
        eq(schema.emailAlertOffers.parentUserId, input.parentUserId),
        isNull(schema.emailAlertOffers.resolvedAt),
        gt(schema.emailAlertOffers.expiresAt, input.now),
      ),
    );

  const recorded = await recordEmailAlertOffer(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    integrationId: COACH_CALENDAR_INTEGRATION_ID,
    messageId: `coach:${input.channelMessageId}`,
    channelMessageId: input.channelMessageId,
    draft: { kind: 'new_event', title, startsAt: input.startsAt, location: input.location },
    now: input.now,
  });
  return recorded === 'recorded' ? 'recorded' : 'event_started';
}

/** `Saturday, Sep 19 at 9:00 a.m.` — the SAME rendering the alert used for the same
 * instant, so the receipt names the occasion in the words the parent is holding. */
function when(startsAt: Date, timeZone: string, now: Date): string {
  const clock = new Intl.DateTimeFormat('en-CA', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(startsAt);
  return `${formatDayHeading(startsAt, timeZone, now)} at ${clock}`;
}
