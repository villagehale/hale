import { type Database, schema } from '@hale/db';
import { and, asc, eq, gt, gte, inArray, isNull, lte, ne, or } from 'drizzle-orm';
import type { CorrelatedEventRef, ExtractedEvent, ExtractionKind } from '~/lib/sentinel';
import { sessionKey } from './going';

/**
 * THE BOOKING — a provider's receipt says this family holds a place, written down so Hale
 * can check back on it four days later.
 *
 * WRITER AND READER IN ONE MODULE, beside `email-alert-offer.ts` whose shape this copies:
 * the decision, the write and the query that reads it back are the same three facts, and
 * splitting them is how the row and the sentence drift apart.
 *
 * WHEN THE ROW IS WRITTEN: at DETECTION, after the send. Not on the parent's YES. The
 * evidence for a booking is the provider's receipt; the YES answers a different question
 * — do you want this on your calendar — and a parent who keeps their own calendar says NO
 * while still being booked. Folding the two would be consent read against a question
 * nobody asked, which is the exact defect #649 removed. So the write sits in the same
 * post-send stretch as `recordEmailAlertOffer`, under the same send-time rule.
 */

/** Stricter than the alert's own floor, and deliberately so: a text is a sentence that
 * goes out once, while a booking is a fact Hale will act on a week later. The NUMBER is
 * the sentinel's own "confident" (pipeline.ts's CONFIDENCE_FLOOR) rather than a second
 * one invented here — the alert may still go at 0.6 and be merely a text. */
export const BOOKING_CONFIDENCE_FLOOR = 0.7;

/**
 * Every way one confirmation can end as a booking (rule #11).
 *
 * A discriminated union rather than `| null`, so the four refusals are four counters and
 * not one reconstructed from context at the call site.
 */
export type BookingDraftResult =
  | { ok: true; draft: BookingDraft }
  | {
      ok: false;
      reason:
        | 'not_a_booking'
        | 'teen_content'
        | 'teen_attributed'
        | 'no_first_session'
        | 'below_confidence'
        | 'no_title';
    };

export interface BookingDraft {
  /** The sender's bare domain — never the display name, never the local part. */
  providerHost: string;
  title: string;
  firstSessionAt: Date;
  location: string | null;
  /**
   * The `family_events` row this booking duplicates, when the correlation found one AND
   * it is a family_events ref. A `week_plans_item` ref is NOT written here: the follow-up
   * reader joins `family_events`, a week-plan id would not resolve, and a week-plan item
   * is not a calendar row.
   */
  eventId: string | null;
  /**
   * THE SESSION, as one string, or NULL for a booking nothing may count (`going.ts`).
   *
   * Computed HERE, under the BOOKED flag rather than under the count's own one: the key is
   * part of the row, and a key that only started appearing after a third flag flipped
   * would need exactly the backfill this design exists to avoid.
   */
  sessionKey: string | null;
}

/**
 * Is this confirmation a booking, and what are its four facts?
 *
 * DECIDED FROM THE TYPED EXTRACTION AND NOTHING ELSE — the same shape and the same
 * discipline as `emailAlertOfferDraft`: one pure function, two readers, so what the text
 * said and what the row holds can never disagree.
 *
 * SIX FLOORS, and they are subtractions rather than checks:
 *   · Not a `booking_confirmation` → there is no receipt here.
 *   · `teenContent` → NO ROW AT ALL. The pipeline has already genericised the title, so
 *     there is no activity left to record; recording the generic one would let a
 *     follow-up ask about a 13+ child's activity in four days' time on the strength of a
 *     title Hale deliberately erased (rule #1). The absence of the row IS the absence of
 *     the follow-up — the same construction `emailAlertOfferDraft` uses.
 *   · `teenAttributed` → NO ROW EITHER, and this is the floor that actually holds. The
 *     flag above is the model's, and the pipeline only forces it from the child's age for
 *     an `unclear` kind or a sub-0.7 confidence — which is the exact complement of what
 *     reaches here, since a `booking_confirmation` is never `unclear` and the floor below
 *     is 0.7. So on the model's silence a 14-year-old's confident receipt was written down
 *     and asked about four days later. TWO reasons rather than one, because "the model
 *     called it teen content" and "the date of birth did" are two different things to be
 *     told about a household, and folding them would hide which gate is load-bearing.
 *   · Below {@link BOOKING_CONFIDENCE_FLOOR} → a wrong extraction here costs a strange
 *     question on a Tuesday, not a wrong sentence today.
 *   · NO NAME → no row. A vendor title that survives sanitising as nothing leaves the
 *     renderer printing Hale's own words ("a spot"), which are the object of a sentence
 *     and not the name of a class; booking them asks "how did a spot go?" four days
 *     later. `emailAlertOfferDraft` refuses the same email on the same emptiness, so this
 *     floor is also what keeps a row from outliving a CTA that was never printed.
 *   · No concrete FUTURE first session → nothing to remind about and nothing to ask about.
 */
export function bookingDraft(input: {
  kind: ExtractionKind;
  event: ExtractedEvent;
  from: string;
  teenContent: boolean;
  /** The pipeline's DETERMINISTIC read — `event.childRef` resolved against this family's
   * children and their ages, with no model flag in it. */
  teenAttributed: boolean;
  sourceConfidence: number;
  matchedEventRef: CorrelatedEventRef | null;
  /** THE VENDOR'S OWN NAME FOR THE CLASS, through the renderer's `sanitizedTitle` and
   * NOT through its `|| GENERIC_TITLE[kind]` fallback — folded by the caller rather than
   * re-folded here, because a second copy of that fold is a booking titled differently
   * from the message that announced it. Empty is a refusal, not a substitution. */
  title: string;
  /** The renderer fell back to HALE'S OWN WORDS for this kind, because the vendor's title
   * survived sanitising as nothing. Handed in beside the title rather than re-derived,
   * because it is the same `renderedTitle` answer the sentence was built from — and it is
   * two refusals at once: no row at all, and (were one ever written) no session key, since
   * every nameless receipt from one host at one instant would key into one "session". */
  titleIsFallback: boolean;
  /** The place, through the SAME fold the offer row keeps (`gsm7`, clamped), for the same
   * reason: this string reaches a parent later, in a reminder. */
  location: string | null;
  now: Date;
}): BookingDraftResult {
  if (input.kind !== 'booking_confirmation') return { ok: false, reason: 'not_a_booking' };
  if (input.teenContent) return { ok: false, reason: 'teen_content' };
  if (input.teenAttributed) return { ok: false, reason: 'teen_attributed' };
  if (input.sourceConfidence < BOOKING_CONFIDENCE_FLOOR) {
    return { ok: false, reason: 'below_confidence' };
  }
  if (input.title === '' || input.titleIsFallback) return { ok: false, reason: 'no_title' };
  const firstSessionAt = instant(input.event.newTime);
  if (firstSessionAt === null || firstSessionAt.getTime() <= input.now.getTime()) {
    return { ok: false, reason: 'no_first_session' };
  }
  const providerHost = senderHost(input.from);
  return {
    ok: true,
    draft: {
      providerHost,
      title: input.title,
      firstSessionAt,
      location: input.location,
      eventId: input.matchedEventRef?.table === 'family_events' ? input.matchedEventRef.id : null,
      // One decision, two readers - the row the count is read from and the row it is
      // written on carry the SAME string, because there is one function and one call.
      sessionKey: sessionKey({
        providerHost,
        title: input.title,
        titleIsFallback: input.titleIsFallback,
        firstSessionAt,
      }),
    },
  };
}

interface LiveClassBooking {
  id: string;
  providerHost: string;
  title: string;
  firstSessionAt: Date;
  location: string | null;
  eventId: string | null;
  createdAt: Date;
}

/**
 * The live booking this receipt is a second copy of, if this family already holds the
 * class. Compared in TypeScript on {@link bookingDedupeKey} so the weekday fold stays in
 * one language — a SQL `lower(regexp_replace(...))` beside it is how the two drift.
 *
 * The OLDEST row wins. A household that already has two copies (written before this
 * key existed) keeps the original; the follow-up reader collapses the rest.
 */
async function findLiveClassBooking(
  database: Database,
  input: { familyId: string; providerHost: string; title: string; firstSessionAt: Date },
): Promise<LiveClassBooking | null> {
  const wanted = bookingDedupeKey(input);
  if (wanted === null) return null;
  const host = input.providerHost.trim().toLowerCase();
  const rows = await database
    .select({
      id: schema.activityBookings.id,
      providerHost: schema.activityBookings.providerHost,
      title: schema.activityBookings.title,
      firstSessionAt: schema.activityBookings.firstSessionAt,
      location: schema.activityBookings.location,
      eventId: schema.activityBookings.eventId,
      createdAt: schema.activityBookings.createdAt,
    })
    .from(schema.activityBookings)
    .where(
      and(
        eq(schema.activityBookings.familyId, input.familyId),
        eq(schema.activityBookings.providerHost, host),
        isNull(schema.activityBookings.cancelledAt),
      ),
    );
  const matches = rows.filter(
    (row) =>
      bookingDedupeKey({
        providerHost: row.providerHost,
        title: row.title,
        firstSessionAt: row.firstSessionAt,
      }) === wanted,
  );
  matches.sort((a, b) => {
    const created = a.createdAt.getTime() - b.createdAt.getTime();
    if (created !== 0) return created;
    return a.id.localeCompare(b.id);
  });
  return matches[0] ?? null;
}

/** Whether this family already holds the class, so a second receipt is not counted as
 * another household. The session key is the full instant; this is the date. */
export async function familyHoldsLiveBooking(
  database: Database,
  input: { familyId: string; providerHost: string; title: string; firstSessionAt: Date },
): Promise<boolean> {
  const row = await findLiveClassBooking(database, input);
  return row !== null;
}

function isUniqueViolation(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: string }).code;
    if (code === '23505') return true;
    if (/duplicate key|unique constraint/i.test(current.message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Write the booking down, against the message that told the parent.
 *
 * AFTER THE SEND, never before — the MEM-10 send-time discipline the offer row keeps for
 * the same reason: a booking minted for a text the transport refused is a fact Hale acts
 * on a week later with nobody having been told.
 *
 * TWO IDENTITIES. (connection, message) is one email, forever: a re-fired sweep returns
 * `already_recorded` and does not touch the row, because that pair is how the calendar
 * YES finds it. (family, sender domain, canonical title, first-session date) is one
 * CLASS: an invoice and the receipt that follows it refresh the row instead of inserting
 * a second one. The message id stays the first receipt's, so the standing offer still
 * stamps; the first instant stays too, so the "N other Hale families" key does not move
 * onto a second clock time and count this household twice.
 */
export async function recordActivityBooking(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    integrationId: string;
    messageId: string;
    channelMessageId: string;
    draft: BookingDraft;
  },
): Promise<{ outcome: 'recorded' | 'already_recorded' | 'refreshed'; bookingId: string | null }> {
  const [sameEmail] = await database
    .select({ id: schema.activityBookings.id })
    .from(schema.activityBookings)
    .where(
      and(
        eq(schema.activityBookings.integrationId, input.integrationId),
        eq(schema.activityBookings.messageId, input.messageId),
      ),
    );
  if (sameEmail) return { outcome: 'already_recorded', bookingId: null };

  const existing = await findLiveClassBooking(database, {
    familyId: input.familyId,
    providerHost: input.draft.providerHost,
    title: input.draft.title,
    firstSessionAt: input.draft.firstSessionAt,
  });
  if (existing) {
    await database
      .update(schema.activityBookings)
      .set({
        dedupeKey: bookingDedupeKey({
          providerHost: input.draft.providerHost,
          title: input.draft.title,
          firstSessionAt: input.draft.firstSessionAt,
        }),
        location: input.draft.location ?? existing.location,
        eventId: existing.eventId ?? input.draft.eventId,
      })
      .where(eq(schema.activityBookings.id, existing.id));
    return { outcome: 'refreshed', bookingId: existing.id };
  }

  try {
    const [row] = await database
      .insert(schema.activityBookings)
      .values({
        familyId: input.familyId,
        parentUserId: input.parentUserId,
        integrationId: input.integrationId,
        messageId: input.messageId,
        providerHost: input.draft.providerHost,
        title: input.draft.title,
        firstSessionAt: input.draft.firstSessionAt,
        location: input.draft.location,
        sessionKey: input.draft.sessionKey,
        dedupeKey: bookingDedupeKey({
          providerHost: input.draft.providerHost,
          title: input.draft.title,
          firstSessionAt: input.draft.firstSessionAt,
        }),
        eventId: input.draft.eventId,
        channelMessageId: input.channelMessageId,
      })
      .returning({ id: schema.activityBookings.id });
    if (!row) return { outcome: 'already_recorded', bookingId: null };
    return { outcome: 'recorded', bookingId: row.id };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // The other writer won the class, or this email landed between the read and the
    // insert. Either way there is one row.
    const raced = await findLiveClassBooking(database, {
      familyId: input.familyId,
      providerHost: input.draft.providerHost,
      title: input.draft.title,
      firstSessionAt: input.draft.firstSessionAt,
    });
    if (raced) return { outcome: 'refreshed', bookingId: raced.id };
    return { outcome: 'already_recorded', bookingId: null };
  }
}

/**
 * Stamp the placed event onto the booking, when the parent's YES put the class on the
 * calendar after all.
 *
 * KEYED ON (connection, message) rather than on a booking id, because the offer row and
 * the booking row are two rows born from ONE email and that pair is the identity of both
 * — no third id to thread through the router and no join to get wrong.
 *
 * `no_booking` is the ordinary answer for every kind but a booking, and an INCONSISTENCY
 * for a `booking_confirmation` offer; the caller logs which it is (rule #11).
 */
export async function stampBookingEvent(
  database: Database,
  input: { integrationId: string; messageId: string; eventId: string },
): Promise<'stamped' | 'no_booking'> {
  const stamped = await database
    .update(schema.activityBookings)
    .set({ eventId: input.eventId })
    .where(
      and(
        eq(schema.activityBookings.integrationId, input.integrationId),
        eq(schema.activityBookings.messageId, input.messageId),
      ),
    )
    .returning({ id: schema.activityBookings.id });
  return stamped.length > 0 ? 'stamped' : 'no_booking';
}

/**
 * The fold shared by cancellation matching and receipt dedupe: casefold, collapse
 * whitespace, trim. Exported because a match is only as honest as both sides using the
 * same function — a second copy of this three-step normalisation is how "Swim Level 2"
 * stops closing "Swim  Level 2".
 */
export function normalisedBookingTitle(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Weekday abbreviations a provider swaps between the receipt and the cancellation.
 * Whole tokens only: "Tues" becomes "tuesday", and "Swim Level 2" does not become
 * "Swim Level 1". Not a fuzzy match — a near-miss here closes a class the family is
 * still going to. */
const WEEKDAY_TOKENS: Readonly<Record<string, string>> = {
  mon: 'monday',
  monday: 'monday',
  tue: 'tuesday',
  tues: 'tuesday',
  tuesday: 'tuesday',
  wed: 'wednesday',
  weds: 'wednesday',
  wednesday: 'wednesday',
  thu: 'thursday',
  thur: 'thursday',
  thurs: 'thursday',
  thursday: 'thursday',
  fri: 'friday',
  friday: 'friday',
  sat: 'saturday',
  saturday: 'saturday',
  sun: 'sunday',
  sunday: 'sunday',
};

/**
 * The title a cancellation is compared on, and the title half of a receipt's dedupe key.
 *
 * Case, whitespace, and a weekday abbreviation ("Tues" / "Tuesday"). Nothing else: no
 * instant equality, because a cancellation rarely repeats the session time and the ones
 * that do disagree about the timezone; no location, because the vendor writes the place
 * differently in the two emails; no edit distance, because "Swim Level 2" must not close
 * "Swim Level 1" and "Art Tues" must not close "Art Thursday".
 */
export function canonicalBookingTitle(raw: string): string {
  return normalisedBookingTitle(raw)
    .split(' ')
    .map((token) => {
      const bare = token.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
      return WEEKDAY_TOKENS[bare] ?? bare;
    })
    .filter((token) => token.length > 0)
    .join(' ');
}

/** True when two titles are the same class under {@link canonicalBookingTitle}. */
export function bookingTitlesMatch(a: string, b: string): boolean {
  const left = canonicalBookingTitle(a);
  const right = canonicalBookingTitle(b);
  return left !== '' && left === right;
}

/**
 * The class a re-sent receipt is the same booking BY — family is the caller's column,
 * and this string is sender domain, canonical title, and the UTC calendar date of the
 * first session.
 *
 * DATE, not the full instant. An invoice at 1:00 and a receipt at 1:05 are one class;
 * a second section on another day is not. NULL when there is no host or no title, and a
 * NULL key is not deduped — the same refusal a nameless cancellation makes.
 */
export function bookingDedupeKey(input: {
  providerHost: string;
  title: string;
  firstSessionAt: Date;
}): string | null {
  const host = input.providerHost.trim().toLowerCase();
  const title = canonicalBookingTitle(input.title);
  if (host === '' || title === '') return null;
  return `${host}|${title}|${input.firstSessionAt.toISOString().slice(0, 10)}`;
}

/**
 * The identity a cancellation and a receipt are the same class BY — the provider's domain
 * and the canonical title, the exact pair {@link closeCancelledBookings} matches a row on.
 *
 * It exists because one sweep reads a batch NEWEST FIRST, so a cancellation arrives at the
 * closer BEFORE the receipt it cancels has been written down, and the closer has nothing to
 * close. The sweep therefore has to carry the fact forward in memory, and the fact it
 * carries must be the same fact the table is matched on — a second hand-rolled key here is
 * how "recreation.brookfield.ca / swim level 2" stops meaning the same thing in the two
 * places that decide with it.
 *
 * NULL when the cancellation names no class. A nameless email closes nothing (the same
 * refusal the closer makes) and must suppress nothing either, or one unreadable subject
 * line would silence every receipt from that provider for the rest of the sweep.
 */
export function bookingCancellationKey(from: string, title: string): string | null {
  const folded = canonicalBookingTitle(title);
  return folded === '' ? null : `${senderHost(from)}\u0000${folded}`;
}

/** A booking the provider called off, and the email it was born from — the pair that also
 * addresses the standing calendar offer that email wrote. */
export interface ClosedBooking {
  id: string;
  integrationId: string;
  messageId: string;
}

/**
 * The provider cancelled it, so the family no longer holds it — stamp `cancelled_at` on
 * the live FUTURE bookings this cancellation names.
 *
 * WITHOUT THIS THE BRANCH SHIPPED A BOOKING NOTHING COULD CLOSE. `readDueBookings` asks
 * "how did it go?" four days after the first session, and a class the provider called off
 * two days earlier is exactly the case where that question is worst: the parent was told
 * about the cancellation, in a text from Hale, and Hale then asks how it went.
 *
 * BOUNDED BY THE PROVIDER AND THE TITLE, and by nothing else. Same family, same
 * `provider_host`, same canonical title, still live, still in the future. A cancellation
 * from a different provider that happens to name the same generic class ("Swim Level 2" is
 * not a rare string) closes nothing.
 *
 * It takes the RAW sender and folds it with `senderHost` — the same private function
 * `bookingDraft` wrote the row's host with, rather than a host handed in by a caller that
 * could fold it a second way.
 *
 * Returns THE ROWS IT CLOSED, rather than a count, so the caller can write the trail row
 * each one owes (rule #6) and take down the calendar offer born from the same email. The
 * (connection, message) pair travels with the id because it is the identity of BOTH rows
 * that email wrote, and carrying it here is what spares the caller a second query.
 * An empty array is the ordinary answer: most cancellations are about classes the family
 * never registered for through Hale.
 */
export async function closeCancelledBookings(
  database: Database,
  input: { familyId: string; from: string; title: string; now: Date },
): Promise<ClosedBooking[]> {
  const wanted = canonicalBookingTitle(input.title);
  // A cancellation that names no class closes nothing. Without this, every booking whose
  // own title folded to the same emptiness would be closed by one nameless email.
  if (wanted === '') return [];
  const live = await database
    .select({
      id: schema.activityBookings.id,
      title: schema.activityBookings.title,
      integrationId: schema.activityBookings.integrationId,
      messageId: schema.activityBookings.messageId,
    })
    .from(schema.activityBookings)
    .where(
      and(
        eq(schema.activityBookings.familyId, input.familyId),
        eq(schema.activityBookings.providerHost, senderHost(input.from)),
        isNull(schema.activityBookings.cancelledAt),
        // The FUTURE only. A session that already happened is a class the family went to,
        // and closing it would take its "how did it go?" down with it.
        gt(schema.activityBookings.firstSessionAt, input.now),
      ),
    );
  // Folded in TS rather than in SQL so there is ONE normaliser and not a hand-written
  // `lower(regexp_replace(...))` beside it that can drift from it.
  const closing = live
    .filter((row) => canonicalBookingTitle(row.title) === wanted)
    .map((row) => ({ id: row.id, integrationId: row.integrationId, messageId: row.messageId }));
  if (closing.length === 0) return [];
  await database
    .update(schema.activityBookings)
    .set({ cancelledAt: input.now })
    .where(
      inArray(
        schema.activityBookings.id,
        closing.map((row) => row.id),
      ),
    );
  return closing;
}

/** A booking whose first session has passed, ready for the follow-up ask. Shaped to the
 * sweep's `DueActivity` and built there rather than here, so this module owes the sweep
 * its rows and not its types. */
export interface DueBooking {
  bookingId: string;
  familyId: string;
  /** THE ITEM'S OWN PARENT — whose mailbox the receipt arrived in. Never the family's
   * primary parent (rule #5). */
  parentUserId: string;
  title: string;
  firstSessionAt: Date;
}

/**
 * The bookings whose first session has passed inside the follow-up window.
 *
 * IT EXCLUDES A CANCELLED BOOKING, and a booking whose matched event is a `placement`.
 * The first is the provider having called the class off; the second is because those are
 * `readDueActivities`' own rows and asking about both would be two texts for one
 * Saturday. It deliberately does NOT exclude on `event_id IS NOT NULL`: a booking whose
 * YES placed a `source='parent'` row is invisible to `readDueActivities` (which filters
 * `placement`), so a blanket exclusion would drop the ask entirely. Both branches have a
 * test, because the naive version passes the first and silently loses the second.
 *
 * The window is passed IN rather than computed here, so the booking reader and the
 * placement reader are bounded by one arithmetic (`activityFollowupWindow`) and cannot
 * drift into asking about different days.
 */
export async function readDueBookings(
  database: Database,
  familyId: string,
  window: { floor: Date; latest: Date },
): Promise<DueBooking[]> {
  const rows = await database
    .select({
      bookingId: schema.activityBookings.id,
      familyId: schema.activityBookings.familyId,
      parentUserId: schema.activityBookings.parentUserId,
      providerHost: schema.activityBookings.providerHost,
      title: schema.activityBookings.title,
      firstSessionAt: schema.activityBookings.firstSessionAt,
      createdAt: schema.activityBookings.createdAt,
    })
    .from(schema.activityBookings)
    .leftJoin(schema.familyEvents, eq(schema.familyEvents.id, schema.activityBookings.eventId))
    .where(
      and(
        eq(schema.activityBookings.familyId, familyId),
        // The provider called it off, so there is nothing to ask about — see
        // `closeCancelledBookings`.
        isNull(schema.activityBookings.cancelledAt),
        gte(schema.activityBookings.firstSessionAt, window.floor),
        lte(schema.activityBookings.firstSessionAt, window.latest),
        // A NULL join (no event stamped, or a stamp pointing at nothing) is ours; a
        // matched event that is not a placement is ours too, because the placement reader
        // filters `source = 'placement'` and would never see it.
        or(isNull(schema.familyEvents.id), ne(schema.familyEvents.source, 'placement')),
      ),
    )
    .orderBy(asc(schema.activityBookings.firstSessionAt), asc(schema.activityBookings.createdAt));
  // One ask per class. Two rows for one receipt-then-invoice pair (written before the
  // dedupe, or lost a race) would be two "how did it go?" texts. A row with no dedupe
  // key keeps its own id, so a nameless booking is not folded into another.
  const seen = new Set<string>();
  const collapsed = [];
  for (const row of rows) {
    const key =
      bookingDedupeKey({
        providerHost: row.providerHost,
        title: row.title,
        firstSessionAt: row.firstSessionAt,
      }) ?? row.bookingId;
    if (seen.has(key)) continue;
    seen.add(key);
    collapsed.push(row);
  }
  return collapsed.map((row) => ({
    bookingId: row.bookingId,
    familyId: row.familyId,
    parentUserId: row.parentUserId,
    title: row.title,
    firstSessionAt: row.firstSessionAt,
  }));
}

/**
 * The sender's bare domain — the same read `senderLabel` falls back to, and never the
 * display name (which can carry a child's program name) or the local part (which can be
 * `parent.name@`).
 */
function senderHost(from: string): string {
  const address = /<([^>]*)>/.exec(from)?.[1] ?? from;
  return (address.split('@')[1] ?? '').trim().toLowerCase();
}

function instant(iso: string | null): Date | null {
  if (iso === null) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at;
}
