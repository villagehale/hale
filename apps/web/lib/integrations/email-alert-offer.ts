import { randomUUID } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { and, desc, eq, gt, inArray, isNull, ne } from 'drizzle-orm';
import { normalizeReply } from '~/lib/channel/affirmative';
import type { ReplyLanguage } from '~/lib/channel/language';
import { SENT_STATUSES } from '~/lib/channel/ledger';
import { DEFAULT_TIMEZONE, formatDayHeading } from '~/lib/format/datetime';
import { dayKeyIn, zonedLocalInstant } from '~/lib/plan/spine';
import type { ExtractionKind } from '~/lib/sentinel';
import { stampBookingEvent } from './booking';
import { occasionAlreadyHeld } from './calendar-mirror';
import {
  type OfferReceiptFacts,
  type OfferReceiptPorts,
  productionOfferReceiptPorts,
  writeOfferReceipt,
} from './offer-receipt';

/**
 * THE YES AT THE END OF AN EMAIL ALERT — the row it lands in, and what it does.
 *
 * The alert asks, in the model's own words, whether to put the occasion on the week.
 * The earlier wording, "Reply YES and it goes on your week," was shipped once with
 * nothing behind it and removed in #649,
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
 * is still one identifiable thing. Capped at the occasion's own start by
 * {@link offerExpiresAt} — an offer must not outlive the event it names (VIL-410).
 * Applied at the READER, never by a sweep. */
export const EMAIL_ALERT_OFFER_TTL_MS = 24 * 60 * 60 * 1000;

/** The earlier of a day from now and the occasion's start. A start already in the
 * past expires immediately, so the row is not answerable. */
export function offerExpiresAt(now: Date, startsAt: Date): Date {
  const ttl = new Date(now.getTime() + EMAIL_ALERT_OFFER_TTL_MS);
  return startsAt.getTime() < ttl.getTime() ? new Date(startsAt.getTime()) : ttl;
}

/** What writing an offer did. `event_started` is a past occasion: no row, because a
 * question about a time that has already passed is not a question (VIL-410). */
export type RecordEmailAlertOfferOutcome = 'recorded' | 'already_recorded' | 'event_started';

/** How long the placed occasion lasts when the email never said. An hour is the shape of
 * nearly every thing a school or a pool puts in a parent's calendar, and a point event
 * (`ends_at` null) reads as a zero-length slot in the ICS feed. */
export const EMAIL_ALERT_EVENT_DURATION_MS = 60 * 60 * 1000;

/**
 * How long a SECOND yes is still about the offer the first one took.
 *
 * Minutes, because that is the span a repeated tap lives in — a double send, a "yes"
 * followed by "yes please". Past it the word belongs to whatever has been said since, and
 * the coach, which can see the acknowledgement in the thread, is the honest reader of it.
 * The bound matters: once an offer is resolved it stops being listed, so an unbounded
 * repeat branch would be a handler claiming a bare affirmative with NO open question to
 * make it unambiguous, which is precisely what `soleOpenKind` cannot protect against
 * (an empty question list is vacuously unambiguous).
 */
export const EMAIL_ALERT_REPEAT_WINDOW_MS = 10 * 60 * 1000;

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
): Promise<RecordEmailAlertOfferOutcome> {
  // A start that has already passed is not an offer. The draft path refuses
  // these too; this is the backstop for a row that would otherwise stand for a
  // day after the occasion (VIL-410).
  if (input.draft.startsAt.getTime() <= input.now.getTime()) return 'event_started';
  const inserted = await database
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
      expiresAt: offerExpiresAt(input.now, input.draft.startsAt),
    })
    .onConflictDoNothing()
    .returning({ id: schema.emailAlertOffers.id });
  return inserted[0] ? 'recorded' : 'already_recorded';
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
 * discipline the plan, checkup and founder offers keep.
 *
 * PER PARENT, not per family. The offer was put to one phone; a co-parent who never saw
 * the text must not be able to answer it, for the same reason the intro opt-in and the
 * co-parent scope question are per-parent.
 *
 * Newest first, because the gate permits three alerts a day and the newest is the one a
 * bare affirmative is answering. The older ones stay listed as the ambiguity they are.
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
        // A start that has passed is not an open question, even when a flat
        // 24h stamp was written before the occasion arrived (VIL-410).
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
  return `An offer to put ${offer.title} on your week`;
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
 * handler declining to claim, not a silent skip. */
export type EmailAlertOfferReplyOutcome =
  | { status: 'added'; offerId: string; reply: string | null }
  | { status: 'declined'; offerId: string; reply: string | null }
  | { status: 'already_added'; reply: string | null }
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
 *
 * NULL is the bare-word path — "yes" with no reading behind it — and only then is newest
 * the answer, because the caller has already established there is exactly one.
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
    /** The offer this answer NAMES, or null when the parent sent a bare word. */
    offerId: string | null;
    polarity: 'yes' | 'no';
    language: ReplyLanguage;
    now: Date;
    /** The voice that writes the receipt. Absent in production wiring, which
     * uses the offer-receipt skill. A test hands a port so the suite never
     * calls a model. */
    receipt?: OfferReceiptPorts;
  },
): Promise<EmailAlertOfferReplyOutcome> {
  const receipt = input.receipt ?? productionOfferReceiptPorts(database, input.familyId);
  const say = async (
    kind: OfferReceiptFacts['kind'],
    title: string,
    startsAt: Date,
  ): Promise<string | null> => {
    const timeZone = await parentTimeZone(database, input.parentUserId);
    return writeOfferReceipt(
      {
        kind,
        title,
        whenLabel: when(startsAt, timeZone, input.now),
        language: input.language,
      },
      receipt,
    );
  };
  const open = await loadOpenEmailAlertOffers(database, input);
  const offer = input.offerId === null ? open[0] : open.find((row) => row.id === input.offerId);
  // A named id that is not open is a closed question, never an invitation to pick another
  // one — and the repeat branch below is for the bare word only, for the same reason.
  if (!offer && input.offerId !== null) return { status: 'no_open_offer' };
  if (!offer) {
    if (input.polarity === 'no') return { status: 'no_open_offer' };
    const repeat = await loadRecentlyAddedOffer(database, input);
    if (!repeat) return { status: 'no_open_offer' };
    return {
      status: 'already_added',
      reply: await say('already_added', repeat.title, repeat.startsAt),
    };
  }

  if (input.polarity === 'no') {
    return {
      status: 'declined',
      offerId: offer.id,
      reply: await say('declined', offer.title, offer.startsAt),
    };
  }

  // The open-list filter is the ordinary refusal. This is the one that still
  // runs if the start passed between the read and the write.
  if (offer.startsAt.getTime() <= input.now.getTime()) {
    await expireEmailAlertOffer(database, offer.id, input.now);
    return { status: 'no_open_offer' };
  }

  // Already on the calendar (Google or family_events). Do not write a second
  // copy, and stop the offer standing so the next yes is not about it.
  // A redrive of a placement this offer already claimed is not that case:
  // the row it wrote is the event, and the receipt is still the add.
  if (
    offer.eventId === null &&
    (await occasionAlreadyHeld(database, {
      familyId: input.familyId,
      title: offer.title,
      startsAt: offer.startsAt,
    }))
  ) {
    await expireEmailAlertOffer(database, offer.id, input.now);
    return {
      status: 'already_added',
      reply: await say('already_added', offer.title, offer.startsAt),
    };
  }

  await placeOfferedEvent(database, offer, input);
  return {
    status: 'added',
    offerId: offer.id,
    reply: await say('added', offer.title, offer.startsAt),
  };
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

/** Stop one offer being answerable. A start that has passed, or an occasion
 * the calendar already holds. Not a resolution: the parent was not told a
 * decline, and the table's CHECK will not write one without that message. */
async function expireEmailAlertOffer(
  database: Database,
  offerId: string,
  now: Date,
): Promise<void> {
  await database
    .update(schema.emailAlertOffers)
    .set({ expiresAt: now })
    .where(
      and(
        eq(schema.emailAlertOffers.id, offerId),
        isNull(schema.emailAlertOffers.resolvedAt),
        gt(schema.emailAlertOffers.expiresAt, now),
      ),
    );
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

/**
 * The offer this parent's last yes already took, and only while it is STILL THE SUBJECT.
 *
 * TWO BOUNDS, and the window alone is not enough. Once an offer resolves it stops being
 * listed, so this branch claims a bare affirmative with no open question behind it — the
 * one case `soleOpenKind` cannot protect (an empty list is vacuously unambiguous). The
 * window says the word is recent; the LAST-WORD rule says it is still about this, by
 * requiring the receipt to be the last thing Hale said to this parent. Without it a coach
 * question asked two minutes after the receipt would lose its answer to a second copy of
 * a text the parent is already holding — the registration ladder solved exactly this with
 * exactly this rule (`readinessAskedLastAt`), off the same ledger.
 */
async function loadRecentlyAddedOffer(
  database: Database,
  input: { familyId: string; parentUserId: string; now: Date },
): Promise<{ title: string; startsAt: Date } | null> {
  const [row] = await database
    .select({
      title: schema.emailAlertOffers.title,
      startsAt: schema.emailAlertOffers.startsAt,
      receiptAt: schema.channelMessages.createdAt,
    })
    .from(schema.emailAlertOffers)
    .innerJoin(
      schema.channelMessages,
      eq(schema.channelMessages.id, schema.emailAlertOffers.resolvedChannelMessageId),
    )
    .where(
      and(
        eq(schema.emailAlertOffers.familyId, input.familyId),
        eq(schema.emailAlertOffers.parentUserId, input.parentUserId),
        eq(schema.emailAlertOffers.resolution, 'added'),
        gt(
          schema.emailAlertOffers.resolvedAt,
          new Date(input.now.getTime() - EMAIL_ALERT_REPEAT_WINDOW_MS),
        ),
      ),
    )
    .orderBy(desc(schema.emailAlertOffers.resolvedAt))
    .limit(1);
  if (!row) return null;

  // SENT_STATUSES rather than every row: a send that failed never reached the phone, so it
  // did not take the word away from the receipt.
  const [newer] = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.parentUserId, input.parentUserId),
        eq(schema.channelMessages.direction, 'out'),
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
        gt(schema.channelMessages.createdAt, row.receiptAt),
      ),
    )
    .limit(1);
  return newer ? null : { title: row.title, startsAt: row.startsAt };
}

/** The parent's wall clock, off their own users row — post-filtered by id as every reader
 * of one row here is. */
async function parentTimeZone(database: Database, parentUserId: string): Promise<string> {
  const rows = await database
    .select({ id: schema.users.id, timezone: schema.users.timezone })
    .from(schema.users)
    .where(eq(schema.users.id, parentUserId));
  return rows.find((row) => row.id === parentUserId)?.timezone ?? DEFAULT_TIMEZONE;
}

/** `Saturday, Sep 19 at 9:00 a.m.` — the exact instant the receipt must name.
 * One renderer, in the parent's zone. The model copies this string and writes
 * the rest of the line; a French month such as août is not GSM-7, so the
 * rendered form stays the one the alert already used. */
function when(startsAt: Date, timeZone: string, now: Date): string {
  const clock = new Intl.DateTimeFormat('en-CA', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(startsAt);
  return `${formatDayHeading(startsAt, timeZone, now)} at ${clock}`;
}

/**
 * A correction of the one offer Hale is holding. Not a bare "no" — that word
 * already belongs to every other handler. This set is the fast path only
 * (VIL-410): the reply resolver reads the same idea from any wording, and a
 * phrase that is not in this set still declines when the model says no.
 */
const OFFER_CORRECTIONS = new Set([
  'its yesterday',
  'it was yesterday',
  'that was yesterday',
  'thats yesterday',
  'yesterday',
  'not that one',
  'not this one',
  'not that',
  'wrong one',
  'wrong day',
  'it passed',
  'that passed',
  'already happened',
  'it already happened',
]);

export function isEmailAlertOfferCorrection(body: string): boolean {
  return OFFER_CORRECTIONS.has(normalizeReply(body));
}

const MOVE_OR_CANCEL = /\b(move|cancel|reschedule|deplace|déplace|annule)\b/i;
const EXPLICIT_ADD =
  /want me to add|want it on your (calendar|week)|i can add|\badd it\b|\bput it on\b|je l'ajoute|tu veux que je l'ajoute/i;

/** A coach sentence offering to put a specific occasion on the week, read only
 * when no calendar tool ran. A move or a cancel is not one — those already
 * have a draft. When a tool did run, {@link prepareCoachCalendarReply} follows
 * that signal and does not consult this. */
export function isCoachAddAsk(body: string): boolean {
  if (MOVE_OR_CANCEL.test(body) && !/\badd\b/i.test(body)) return false;
  return EXPLICIT_ADD.test(body);
}

const MONTH_INDEX: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const COACH_WHEN =
  /\b(?:(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday),?\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?(?:,?\s+|\s+)(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i;

const TITLE_NOISE =
  /\b(want me to add|i can add|add it|put it on|that one passed|it passed|already passed|want it on your calendar|want it on your week|the one|one passed)\b/gi;

/**
 * A specific occasion named in a coach reply, or null when the sentence does
 * not carry a month, a day and a clock. The coach's own words stay the thing
 * the parent reads; this only decides whether a later answer has a row.
 */
export function parseCoachEventOffer(
  body: string,
  now: Date,
  timeZone: string,
): EmailAlertOfferDraft | null {
  const match = COACH_WHEN.exec(body);
  if (!match || match.index === undefined) return null;
  const month = MONTH_INDEX[match[1]?.toLowerCase() ?? ''];
  const day = Number(match[2]);
  if (!month || day < 1 || day > 31) return null;
  const minute = Number(match[5] ?? '0');
  let hour = Number(match[4]);
  const ampm = match[6];
  if (ampm) {
    const pm = /^p/i.test(ampm);
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;
  }
  if (hour > 23 || minute > 59) return null;
  const explicitYear = match[3] ? Number(match[3]) : null;
  let year = explicitYear ?? Number(dayKeyIn(now, timeZone).slice(0, 4));
  const clock = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  let startsAt = zonedLocalInstant(coachDayKey(year, month, day), clock, timeZone);
  // A month named without a year that is long past is next year's. A start a
  // day or two ago stays in this year so a past offer is refused rather than
  // rolled forward.
  if (explicitYear === null && startsAt.getTime() < now.getTime() - 30 * 24 * 60 * 60 * 1000) {
    year += 1;
    startsAt = zonedLocalInstant(coachDayKey(year, month, day), clock, timeZone);
  }
  const title = coachOfferTitle(body, match.index, match[0].length);
  if (!title) return null;
  return { kind: 'new_event', title, startsAt, location: null };
}

function coachDayKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function coachOfferTitle(body: string, index: number, length: number): string | null {
  const before = cleanCoachTitle(body.slice(0, index));
  if (before) return before;
  return cleanCoachTitle(body.slice(index + length));
}

function cleanCoachTitle(chunk: string): string | null {
  const text = chunk
    .replace(TITLE_NOISE, ' ')
    .replace(/[.?!]/g, ' ')
    .replace(
      /\b(is|on|for|at|the|a|an|to|it|that|this|me|your|week|calendar|sunday|monday|tuesday|wednesday|thursday|friday|saturday|and|was|were)\b/gi,
      ' ',
    )
    .replace(/[^a-zA-Z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < 2 || text.length > 80) return null;
  return text
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/** What a propose_calendar_* tool already decided this turn. When any signal
 * is present it decides whether an offer row exists. The sentence regex is
 * only the fallback for a prose offer that called no calendar tool. */
export interface CoachCalendarToolSignal {
  verb: 'add' | 'move' | 'cancel';
  title: string;
  startsAt: Date;
}

export type CoachCalendarReply =
  | { outcome: 'not_an_offer'; body: string; offer: null }
  | { outcome: 'unparsed'; body: string; offer: null }
  | { outcome: 'already_on_calendar'; body: string; offer: null }
  | { outcome: 'past'; body: string; offer: null }
  | { outcome: 'offer'; body: string; offer: EmailAlertOfferDraft };

/**
 * Whether a later answer has a row, and which event it is.
 *
 * The parent's text stays the coach's own sentence. A past occasion and one
 * already on the calendar produce no offer row — a yes must not add either.
 * A future event that is not already held keeps the sentence and returns the
 * draft the caller writes after the send.
 *
 * A calendar tool that already ran is the decider. A move or a cancel, with
 * no add, writes no offer row even when the sentence also matches an add
 * phrase. An add carries the tool's title and start, not a parse of the
 * sentence. The regex runs only when no calendar tool spoke.
 */
export async function prepareCoachCalendarReply(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    body: string;
    now: Date;
    intents?: readonly CoachCalendarToolSignal[];
  },
): Promise<CoachCalendarReply> {
  const signals = input.intents ?? [];
  if (signals.length > 0) {
    const adds = signals.filter((signal) => signal.verb === 'add');
    if (adds.length === 0) return { outcome: 'not_an_offer', body: input.body, offer: null };
    const add = adds[adds.length - 1];
    if (!add) return { outcome: 'not_an_offer', body: input.body, offer: null };
    const drafted: EmailAlertOfferDraft = {
      kind: 'new_event',
      title: add.title,
      startsAt: add.startsAt,
      location: null,
    };
    if (drafted.startsAt.getTime() <= input.now.getTime()) {
      return { outcome: 'past', body: input.body, offer: null };
    }
    if (
      await occasionAlreadyHeld(database, {
        familyId: input.familyId,
        title: drafted.title,
        startsAt: drafted.startsAt,
      })
    ) {
      return { outcome: 'already_on_calendar', body: input.body, offer: null };
    }
    return { outcome: 'offer', body: input.body, offer: drafted };
  }

  const timeZone = await parentTimeZone(database, input.parentUserId);
  const parsed = parseCoachEventOffer(input.body, input.now, timeZone);
  const asking = isCoachAddAsk(input.body);
  if (!asking) return { outcome: 'not_an_offer', body: input.body, offer: null };
  if (!parsed) return { outcome: 'unparsed', body: input.body, offer: null };
  if (parsed.startsAt.getTime() <= input.now.getTime()) {
    return { outcome: 'past', body: input.body, offer: null };
  }
  if (
    await occasionAlreadyHeld(database, {
      familyId: input.familyId,
      title: parsed.title,
      startsAt: parsed.startsAt,
    })
  ) {
    return { outcome: 'already_on_calendar', body: input.body, offer: null };
  }
  return { outcome: 'offer', body: input.body, offer: parsed };
}

/**
 * The coach named a specific future event. Write that offer and expire every
 * older open offer for this parent, so a later yes is about this one and not
 * about an earlier alert (VIL-410).
 *
 * Keyed on the outbound message, so a redrive conflicts instead of minting a
 * second question. The supersede skips that same message, so the redrive does
 * not expire the offer it just wrote.
 */
export async function recordCoachEventOffer(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    channelMessageId: string;
    draft: EmailAlertOfferDraft;
    now: Date;
  },
): Promise<'recorded' | 'already_recorded' | 'event_started'> {
  if (input.draft.startsAt.getTime() <= input.now.getTime()) return 'event_started';
  await database
    .update(schema.emailAlertOffers)
    .set({ expiresAt: input.now })
    .where(
      and(
        eq(schema.emailAlertOffers.familyId, input.familyId),
        eq(schema.emailAlertOffers.parentUserId, input.parentUserId),
        isNull(schema.emailAlertOffers.resolvedAt),
        gt(schema.emailAlertOffers.expiresAt, input.now),
        ne(schema.emailAlertOffers.channelMessageId, input.channelMessageId),
      ),
    );
  const inserted = await database
    .insert(schema.emailAlertOffers)
    .values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      // No integration: a coach sentence is not an email. The outbound message
      // id is unique, and the column has no foreign key (see the schema note).
      integrationId: input.channelMessageId,
      messageId: 'coach-offer',
      kind: input.draft.kind,
      title: input.draft.title,
      startsAt: input.draft.startsAt,
      location: input.draft.location,
      channelMessageId: input.channelMessageId,
      expiresAt: offerExpiresAt(input.now, input.draft.startsAt),
    })
    .onConflictDoNothing()
    .returning({ id: schema.emailAlertOffers.id });
  return inserted[0] ? 'recorded' : 'already_recorded';
}
