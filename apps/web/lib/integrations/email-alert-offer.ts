import { randomUUID } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { and, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { SENT_STATUSES } from '~/lib/channel/ledger';
import type { ReplyLanguage } from '~/lib/channel/language';
import { DEFAULT_TIMEZONE, formatDayHeading } from '~/lib/format/datetime';
import type { ExtractionKind } from '~/lib/sentinel';
import { stampBookingEvent } from './booking';

/**
 * THE YES AT THE END OF AN EMAIL ALERT — the row it lands in, and what it does.
 *
 * The alert says "Reply YES and it goes on your week." That sentence was shipped once
 * with nothing behind it and removed in #649, because a parent doing exactly what the
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
): Promise<void> {
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
      expiresAt: new Date(input.now.getTime() + EMAIL_ALERT_OFFER_TTL_MS),
    })
    .onConflictDoNothing();
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
  | { status: 'added'; offerId: string; reply: string }
  | { status: 'declined'; offerId: string; reply: string }
  | { status: 'already_added'; reply: string }
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
  },
): Promise<EmailAlertOfferReplyOutcome> {
  const open = await loadOpenEmailAlertOffers(database, input);
  const offer = input.offerId === null ? open[0] : open.find((row) => row.id === input.offerId);
  // A named id that is not open is a closed question, never an invitation to pick another
  // one — and the repeat branch below is for the bare word only, for the same reason.
  if (!offer && input.offerId !== null) return { status: 'no_open_offer' };
  if (!offer) {
    if (input.polarity === 'no') return { status: 'no_open_offer' };
    const repeat = await loadRecentlyAddedOffer(database, input);
    if (!repeat) return { status: 'no_open_offer' };
    const timeZone = await parentTimeZone(database, input.parentUserId);
    return {
      status: 'already_added',
      reply: ALREADY_ADDED[input.language](repeat.title, when(repeat.startsAt, timeZone, input.now)),
    };
  }

  if (input.polarity === 'no') {
    return { status: 'declined', offerId: offer.id, reply: DECLINED[input.language]() };
  }

  const [timeZone] = await Promise.all([
    parentTimeZone(database, input.parentUserId),
    placeOfferedEvent(database, offer, input),
  ]);
  return {
    status: 'added',
    offerId: offer.id,
    reply: ADDED[input.language](offer.title, when(offer.startsAt, timeZone, input.now)),
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

/**
 * The three receipts, per language.
 *
 * "say remove it anytime" is a promise this product can keep: a `family_events` row with
 * `source = 'parent'` is visible to the coach's `lookup_week` and removable through
 * `propose_calendar_cancel`, which drafts the removal for the parent's approval.
 *
 * THE DATE IS RENDERED IN ENGLISH IN BOTH TWINS, and it is parenthesised in the French
 * one so no English preposition leaks into a French sentence. The product has exactly one
 * date renderer, the alert these answer is English-only (an outbound-first path has no
 * language signal to read), and the French month names that would need one are not all
 * spellable in GSM-7 — `août` alone would flip the whole reply to UCS-2. Quoting the
 * occasion back in the words the parent is holding is the honest version of that
 * constraint rather than a gap.
 */
const ADDED: Record<ReplyLanguage, (title: string, at: string) => string> = {
  en: (title, at) => `${end(`Added - ${title} on ${at}`)} It's on your week; say remove it anytime.`,
  fr: (title, at) =>
    `${end(`Ajouté - ${title}, ${at}`)} C'est sur votre semaine; dites-le-moi pour l'enlever.`,
};

const ALREADY_ADDED: Record<ReplyLanguage, (title: string, at: string) => string> = {
  en: (title, at) => end(`Already on your week - ${title} on ${at}`),
  fr: (title, at) => end(`Déjà sur votre semaine - ${title}, ${at}`),
};

/** `9:00 a.m.` already ends the clause; a second period is the kind of thing nobody
 * notices in review and everybody notices on a phone. The alert's renderer keeps the same
 * rule for the same reason, one file over. */
function end(sentence: string): string {
  return sentence.endsWith('.') ? sentence : `${sentence}.`;
}

const DECLINED: Record<ReplyLanguage, () => string> = {
  en: () => 'Okay - left it off.',
  fr: () => 'Entendu - je ne l\'ai pas ajouté.',
};

/** The three, exported for the encoding guard that holds every fixed line Hale sends to
 * GSM-7 (sms-copy-encoding.test.ts). */
export function emailAlertOfferReplies(language: ReplyLanguage): string[] {
  return [
    ADDED[language]('Swim class', 'Saturday, Sep 19 at 9:00 a.m.'),
    ALREADY_ADDED[language]('Swim class', 'Saturday, Sep 19 at 9:00 a.m.'),
    DECLINED[language](),
  ];
}
