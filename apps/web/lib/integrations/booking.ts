import { type Database, schema } from '@hale/db';
import { and, asc, eq, gte, isNull, lte, ne, or } from 'drizzle-orm';
import type { CorrelatedEventRef, ExtractedEvent, ExtractionKind } from '~/lib/sentinel';

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
  | { ok: false; reason: 'not_a_booking' | 'teen_content' | 'no_first_session' | 'below_confidence' };

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
}

/**
 * Is this confirmation a booking, and what are its four facts?
 *
 * DECIDED FROM THE TYPED EXTRACTION AND NOTHING ELSE — the same shape and the same
 * discipline as `emailAlertOfferDraft`: one pure function, two readers, so what the text
 * said and what the row holds can never disagree.
 *
 * FOUR FLOORS, and they are subtractions rather than checks:
 *   · Not a `booking_confirmation` → there is no receipt here.
 *   · `teenContent` → NO ROW AT ALL. The pipeline has already genericised the title, so
 *     there is no activity left to record; recording the generic one would let a
 *     follow-up ask about a 13+ child's activity in four days' time on the strength of a
 *     title Hale deliberately erased (rule #1). The absence of the row IS the absence of
 *     the follow-up — the same construction `emailAlertOfferDraft` uses.
 *   · No concrete FUTURE first session → nothing to remind about and nothing to ask about.
 *   · Below {@link BOOKING_CONFIDENCE_FLOOR} → a wrong extraction here costs a strange
 *     question on a Tuesday, not a wrong sentence today.
 */
export function bookingDraft(input: {
  kind: ExtractionKind;
  event: ExtractedEvent;
  from: string;
  teenContent: boolean;
  sourceConfidence: number;
  matchedEventRef: CorrelatedEventRef | null;
  /** THE TITLE THE TEXT SAID — the renderer's own `title || GENERIC_TITLE[kind]`, passed
   * in rather than re-folded here. A second copy of that fold would be a booking titled
   * differently from the message that announced it, and it is also what makes this string
   * non-empty by construction: the renderer substitutes its own words when the vendor's
   * title survives sanitising as nothing at all. */
  title: string;
  now: Date;
}): BookingDraftResult {
  if (input.kind !== 'booking_confirmation') return { ok: false, reason: 'not_a_booking' };
  if (input.teenContent) return { ok: false, reason: 'teen_content' };
  if (input.sourceConfidence < BOOKING_CONFIDENCE_FLOOR) {
    return { ok: false, reason: 'below_confidence' };
  }
  const firstSessionAt = instant(input.event.newTime);
  if (firstSessionAt === null || firstSessionAt.getTime() <= input.now.getTime()) {
    return { ok: false, reason: 'no_first_session' };
  }
  return {
    ok: true,
    draft: {
      providerHost: senderHost(input.from),
      title: input.title,
      firstSessionAt,
      location: input.event.location,
      eventId:
        input.matchedEventRef?.table === 'family_events' ? input.matchedEventRef.id : null,
    },
  };
}

/**
 * Write the booking down, against the message that told the parent.
 *
 * AFTER THE SEND, never before — the MEM-10 send-time discipline the offer row keeps for
 * the same reason: a booking minted for a text the transport refused is a fact Hale acts
 * on a week later with nobody having been told.
 *
 * `onConflictDoNothing` on (connection, message): one email is one booking, forever, so a
 * re-fired sweep conflicts here instead of minting a second one.
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
): Promise<{ outcome: 'recorded' | 'already_recorded'; bookingId: string | null }> {
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
      eventId: input.draft.eventId,
      channelMessageId: input.channelMessageId,
    })
    .onConflictDoNothing()
    .returning({ id: schema.activityBookings.id });
  return row
    ? { outcome: 'recorded', bookingId: row.id }
    : { outcome: 'already_recorded', bookingId: null };
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
 * IT EXCLUDES A BOOKING WHOSE MATCHED EVENT IS A `placement`, and only that. Those are
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
      title: schema.activityBookings.title,
      firstSessionAt: schema.activityBookings.firstSessionAt,
    })
    .from(schema.activityBookings)
    .leftJoin(schema.familyEvents, eq(schema.familyEvents.id, schema.activityBookings.eventId))
    .where(
      and(
        eq(schema.activityBookings.familyId, familyId),
        gte(schema.activityBookings.firstSessionAt, window.floor),
        lte(schema.activityBookings.firstSessionAt, window.latest),
        // A NULL join (no event stamped, or a stamp pointing at nothing) is ours; a
        // matched event that is not a placement is ours too, because the placement reader
        // filters `source = 'placement'` and would never see it.
        or(isNull(schema.familyEvents.id), ne(schema.familyEvents.source, 'placement')),
      ),
    )
    .orderBy(asc(schema.activityBookings.firstSessionAt));
  return rows.map((row) => ({
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
