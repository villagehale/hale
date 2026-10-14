import { type Database, schema } from '@hale/db';
import { f14EnabledFor } from '~/lib/channel/f14';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { laneEnabled } from '~/lib/channel/lanes';
import type { ProactiveSendRequest, ProactiveSendVerdict } from '~/lib/channel/outbound-gate';
import { isPrintableGsm7Basic } from '~/lib/channel/sms-segments';
import type { threadProactiveMessage } from '~/lib/channel/thread';
import { attachPassportToEmailAlert } from '~/lib/passport/ingest';
import type { ExtractionKind, InboxEnvelope, SentinelClassification } from '~/lib/sentinel';
import { falseBookingSignal } from '~/lib/sentinel/booking-guard';
import { BOOKED_BACKFILL_MAX_PER_SWEEP, bookedDetectionEnabledFor } from './booked';
import {
  type BookingDraftResult,
  bookingCancellationKey,
  bookingDraft,
  closeCancelledBookings,
  recordActivityBooking,
} from './booking';
import { withdrawEmailAlertOffer } from './email-alert-offer';
import type { GoingOutcome } from './going';

/**
 * A parenting email in a connected Gmail is recorded as a booking. The parent is not texted.
 *
 * The two halves this joins have both existed for a while and never met: the connector
 * sweep reads envelopes and enqueues them as drafts on a web page nobody opens, and the
 * E2 sentinel can tell a cancelled swim class from a newsletter but had no production
 * caller at all. This module is the join, and it is deliberately the only thing between
 * them. The classifier's verdict decides WHETHER a receipt is a booking. The parent is
 * not texted about the mail, and no second model call writes a sentence (rule #2).
 *
 * WHAT IT MAY NOT DO:
 *   - No line of the email reaches a wire, a Slack post, or an audit row (rule #1).
 *   - A 13+ child's mail stays off the booking row. The pipeline has already genericized
 *     the title, and the booking draft refuses a teen attribution.
 *   - Every ending is a named outcome ({@link EmailAlertOutcome}) the cron summary counts
 *     (rule #11). A throw is the one ending this module cannot name for itself, so the
 *     sweep holds a boundary around the call and names it `alert_failed`.
 */

/** The Gmail metadata one sweep observed for one message. `receivedAt` is Gmail's own
 * `internalDate`, and it is optional because the API's contract permits its absence —
 * the extraction anchors relative dates on it, so a message without one is not alerted
 * rather than anchored on a guess. */
export interface GmailAlertEnvelope {
  messageId: string;
  subject: string;
  from: string;
  snippet: string;
  receivedAt?: string;
}

/**
 * Every way one envelope can end. A flat union rather than a discriminated object so the
 * cron summary can count it by name without a mapping step — an outcome that is awkward
 * to count is an outcome that stops being counted.
 *
 * `gate_refused:not_enrolled` is what the brief's "no SMS channel" really is: the live
 * `parent_channels` read lives inside the chokepoint, and a second enrolment check here
 * would be a copy of a rule that already has one home.
 *
 * `alert_failed` is the one this module cannot return itself: it is what the SWEEP records
 * for an envelope whose alert pass threw (lib/integrations/sync.ts). It exists so that a
 * bug in Hale's own alert path has a name of its own instead of arriving as a broken
 * Google connection.
 */
export const EMAIL_ALERT_OUTCOMES = [
  'sent',
  'not_parenting',
  // This sweep had ALREADY read the provider calling this exact class off, and a batch is
  // read newest first — so the receipt is the older email and there is nothing true left
  // to say about it. Its own name rather than silence, because "Hale chose not to speak"
  // is a fact about a mailbox and a counter is the only place it is recorded.
  'cancelled_in_sweep',
  'already_sent',
  'dark',
  'no_parent_user',
  'seeding_run',
  /** Historical mail recorded by the booked-detection backfill. No text was sent. */
  'backfill_suppressed',
  'over_sweep_cap',
  'no_received_at',
  'gate_refused:not_enrolled',
  'gate_refused:no_watch_consent',
  'gate_refused:frequency_cap',
  'gate_refused:quiet_hours',
  'classifier_failed',
  'no_send_target',
  'send_failed',
  'alert_failed',
  /** EMAIL_ALERT_ENABLED is not `true`: no classifier call, no text, no offer. */
  'lane_off',
] as const;

export type EmailAlertOutcome = (typeof EMAIL_ALERT_OUTCOMES)[number];

export type EmailAlertCounts = Record<EmailAlertOutcome, number>;

export function emptyEmailAlertCounts(): EmailAlertCounts {
  return Object.fromEntries(EMAIL_ALERT_OUTCOMES.map((o) => [o, 0])) as EmailAlertCounts;
}

/**
 * Every way one envelope can end as a BOOKING (rule #11) — a second, independent axis
 * beside the outcome above, because "the alert never got that far" and "the booking was
 * refused" are two facts about one envelope.
 *
 * `booked_dark` and not `dark`: `EmailAlertOutcome.dark` already means F14, and two
 * counters called `dark` in one cron summary is a number nobody can read.
 *
 * `record_failed` is a CAUGHT write failure — the text went out, the row did not. It is
 * NOT the same as an uncaught throw in the post-send stretch, which the sweep records as
 * `alert_failed` and which would skip the thread and the alert's own audit row, leaving a
 * parent's thread the coach reads a reply to with nothing above it.
 */
export const BOOKING_OUTCOMES = [
  'recorded',
  'already_recorded',
  // A later receipt for a class this family already holds refreshed that row. Not a
  // second booking: no second follow-up, and no second audit claim.
  'refreshed',
  'booked_dark',
  'not_a_booking',
  // The deterministic guard, named before a model call on the backfill pass. The live
  // path still folds these into `not_a_booking` after the classifier rewrites the kind.
  'waitlist',
  'registration_opens',
  'reminder_only',
  // The model's own flag, and the child's date of birth. Two counters, because which of
  // the two teen gates is actually holding the line is the thing worth being able to read.
  'teen_content',
  'teen_attributed',
  'no_first_session',
  'below_confidence',
  // The vendor named no class Hale can repeat. The text still went, in Hale's own words.
  'no_title',
  'record_failed',
] as const;

export type BookingOutcome = (typeof BOOKING_OUTCOMES)[number];

export type BookingCounts = Record<BookingOutcome, number>;

export function emptyBookingCounts(): BookingCounts {
  return Object.fromEntries(BOOKING_OUTCOMES.map((o) => [o, 0])) as BookingCounts;
}

/**
 * One envelope's two answers.
 *
 * `booking: null` for every envelope that never reached the booking decision — `dark`,
 * `already_sent`, `not_parenting`, the four holds, `no_send_target`, `send_failed`. NOT a
 * booking outcome meaning "n/a": a bucket that means two things is the counter rule #11
 * exists to prevent.
 */
export interface EmailAlertResult {
  alert: EmailAlertOutcome;
  booking: BookingOutcome | null;
  /**
   * What the WHO-ELSE-IS-GOING count did (lib/integrations/going.ts) — a third
   * independent axis, because "a text went", "a place was written down" and "a number
   * about other households was spoken" are three facts about one envelope.
   *
   * `null` for every envelope that never reached the going decision: booked dark, and
   * every booking refusal but the teen one, which keeps its own name here as well as on
   * the booking axis because how often a disclosure is withheld for a 13+ child is a rate
   * rule #1 wants readable in both flag states.
   */
  going: GoingOutcome | null;
}

/** At most this many messages per connection per sweep reach the classifier, newest
 * first. A 15-minute cron over a mailbox that just received a hundred messages is the
 * shape this bounds: the cap on what may be SENT is the outbound gate's, and this is the
 * cap on what may be SPENT — ten model calls, not a hundred. */
export const EMAIL_ALERT_TEMPLATE_KEY = 'connector:email_alert';

/** Keyed on the CONNECTION and the provider's message id, so re-connecting a mailbox
 * that re-seeds the same messages mints new keys while a re-run of the same sweep does
 * not. */
export function emailAlertDedupeKey(integrationId: string, messageId: string): string {
  return `email_alert:${integrationId}:${messageId}`;
}

export interface EmailAlertPorts {
  /** The E2 sentinel, injected rather than called: the model call and its on-demand body
   * fetch belong to the wiring, and a Fake here lets the send mechanics be tested without
   * a stand-in for Claude standing in for the classifier's judgment (rule #8 — quality is
   * the eval suite's job, and the pipeline has its own tests over a scripted client). */
  classify(envelope: InboxEnvelope, familyTimezone: string): Promise<SentinelClassification>;
  gate(request: ProactiveSendRequest): Promise<ProactiveSendVerdict>;
  resolvePhone(database: Database, parentUserId: string): Promise<string | null>;
  transport: ChannelTransport;
  threadMessage: typeof threadProactiveMessage;
  /** The parent's wall clock — the zone every time in the message is rendered in. */
  timeZone(parentUserId: string): Promise<string>;
}

export interface EmailAlertInput {
  familyId: string;
  parentUserId: string;
  integrationId: string;
  messageId: string;
  envelope: { subject: string; from: string; snippet: string; receivedAt: string };
  /**
   * WHAT THIS SWEEP HAS ALREADY BEEN TOLD IS OFF — {@link bookingCancellationKey} per
   * cancellation read so far, written by this function and read by it.
   *
   * Required rather than optional, and a caller's own Set rather than one minted here: a
   * batch is read newest first, so the cancellation reaches the closer BEFORE the receipt
   * it cancels exists in the table, and the only thing that can carry that fact the few
   * milliseconds forward is the loop that owns both envelopes. A default would make the
   * hole re-openable by forgetting an argument.
   */
  cancelledThisSweep: Set<string>;
  timeZone: string;
  now: Date;
}

export async function alertParentForEmail(
  database: Database,
  input: EmailAlertInput,
  ports: EmailAlertPorts,
): Promise<EmailAlertResult> {
  if (!f14EnabledFor(input.familyId)) return { alert: 'dark', booking: null, going: null };
  if (!laneEnabled('email_alert')) return { alert: 'lane_off', booking: null, going: null };
  if (input.envelope.receivedAt === undefined) {
    return { alert: 'no_received_at', booking: null, going: null };
  }
  return recordBackfillEnvelope(
    database,
    {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      integrationId: input.integrationId,
      envelope: {
        messageId: input.messageId,
        subject: input.envelope.subject,
        from: input.envelope.from,
        snippet: input.envelope.snippet,
        receivedAt: input.envelope.receivedAt,
      },
      cancelledThisSweep: input.cancelledThisSweep,
      timeZone: input.timeZone,
      now: input.now,
    },
    ports,
  );
}

function bookingDraftFor(
  extraction: NonNullable<SentinelClassification['extraction']>,
  from: string,
  booked: boolean,
  now: Date,
): BookingDraftResult | null {
  if (!booked) return null;
  // THE SAME ANSWER THE SENTENCE IS BUILT FROM, from the same call rather than from half
  // of it: the row and the text can only name the class differently if this is two calls.
  const rendered = renderedTitle(extraction.event.title, extraction.kind);
  return bookingDraft({
    kind: extraction.kind,
    event: extraction.event,
    from,
    teenContent: extraction.teenContent,
    teenAttributed: extraction.teenAttributed,
    sourceConfidence: extraction.sourceConfidence,
    matchedEventRef: extraction.matchedEventRef,
    // The VENDOR's own name for the class, through the renderer's own fold - so the row
    // and the message can never name the class differently - and the FLAG beside it,
    // because Hale's `GENERIC_TITLE` words are the object of the sentence rather than a
    // name: `bookingDraft` refuses an email that leaves nothing behind them, and a key
    // built from them would file every nameless receipt under one "session".
    title: rendered.text,
    titleIsFallback: rendered.fallback,
    // The same fold the offer row's place goes through, and the same function.
    location: foldedPlace(extraction.event.location),
    now,
  });
}

/**
 * A provider's cancellation, applied to what this family still holds from that provider.
 *
 * ONE AUDIT ROW PER BOOKING CLOSED, carrying ONE FLAG. The verb, the table and the target
 * id say everything else true here; the title is the email, and an audit row a support
 * agent reads is a table that is never redacted (rule #1), so `targetId` points at the row
 * that holds the name and nothing is copied. `offerWithdrawn` is there because a second
 * thing happened — a standing question was taken down — and an effect nobody can read in
 * the trail is an effect nobody can audit (rule #11).
 *
 * The sender goes over WHOLE and is folded to a host inside `closeCancelledBookings`, by
 * the same private function that wrote the row's host — so a cancellation is matched on
 * exactly the domain the booking was written with. The title goes through `sanitizedTitle`
 * for the same reason: it is the fold the stored title already took, and comparing a raw
 * vendor string against a folded one is a match that silently never fires.
 *
 * AND IT TAKES THE CALENDAR OFFER DOWN WITH IT. The receipt wrote two rows — a booking and
 * a standing "Want it on your calendar?" — and closing only the first leaves a YES that
 * still places the cancelled class, reminders and all. One email, one identity
 * (connection, message), both rows.
 */
async function closeBookingsFor(
  database: Database,
  input: { familyId: string; from: string; title: string; now: Date },
): Promise<void> {
  const closed = await closeCancelledBookings(database, {
    familyId: input.familyId,
    from: input.from,
    title: sanitizedTitle(input.title),
    now: input.now,
  });
  for (const booking of closed) {
    const offer = await withdrawEmailAlertOffer(database, {
      integrationId: booking.integrationId,
      messageId: booking.messageId,
      now: input.now,
    });
    await database.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: 'system',
      actionTaken: 'activity_booking_cancelled',
      targetTable: 'activity_bookings',
      targetId: booking.id,
      after: { offerWithdrawn: offer === 'withdrawn' },
    });
  }
}

/**
 * The booking WRITE and its own audit row — everything after the send that belongs to this
 * feature, behind one boundary.
 *
 * THE DECISION IS NOT MADE HERE ANY MORE: it is `bookingDraftFor`, called before the
 * sentence so the clause can speak a count read off the key this row will carry (R3). One
 * decision, two readers — a second call here would be a row keyed differently from the
 * number the parent was just told.
 *
 * THE AUDIT ROW CARRIES ONE BOOLEAN. `provider_host` is the sender's domain, and this
 * module's own rule for `after` is "enums and flags only — not the title, NOT THE SENDER,
 * not the subject", because an audit row a support agent can read is a copy of the email
 * in a table that is never redacted. `markham.ca` beside a family id is the sender in that
 * table, and it is the provider identity D13 calls the family's business. `offered` is the
 * one fact the trail actually needs: did the parent get a CTA with this. `targetId`
 * already points at the row that holds the host.
 */
async function recordBooking(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    integrationId: string;
    messageId: string;
    channelMessageId: string | null;
    /** `null` when booked detection is dark — the one state that is not a refusal. */
    draft: BookingDraftResult | null;
  },
): Promise<BookingOutcome> {
  const { draft } = input;
  if (draft === null) return 'booked_dark';
  if (!draft.ok) return draft.reason;

  let recorded: Awaited<ReturnType<typeof recordActivityBooking>>;
  try {
    recorded = await recordActivityBooking(database, {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      integrationId: input.integrationId,
      messageId: input.messageId,
      channelMessageId: input.channelMessageId,
      draft: draft.draft,
    });
  } catch (err) {
    // The CLASS only — a rejection here can carry a title or an address in its message
    // (rule #1).
    console.error(
      { familyId: input.familyId, err: err instanceof Error ? err.constructor.name : 'unknown' },
      'email alert: the text went out and the booking row did not - the ask will not happen',
    );
    return 'record_failed';
  }

  // Rule #6, and only for the pass that actually INSERTED it. A redrive
  // (`already_recorded`) and a re-sent receipt (`refreshed`) changed no class into
  // being — a second `activity_booking_recorded` row would read as a second class.
  // audit_log is append-only, so the original row stays the receipt.
  //
  // OUTSIDE the catch above, deliberately. `record_failed` means "the text went, the row
  // did not"; a failure here is the opposite — the row is there and the ask WILL happen —
  // so reporting it as a missing booking would be a counter saying the opposite of the
  // table. It propagates instead, exactly as this module's own `email_alert_sent` audit
  // already does.
  if (recorded.outcome === 'recorded' && recorded.bookingId !== null) {
    await database.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: 'system',
      actionTaken: 'activity_booking_recorded',
      targetTable: 'activity_bookings',
      targetId: recorded.bookingId,
      after: { offered: false },
    });
  }
  return recorded.outcome;
}

/**
 * The title the renderer put on the wire: the vendor's own, folded, or Hale's words when
 * that survives sanitising as nothing at all. ONE definition, read by the sentence and by
 * the row — which it now actually is, because `recordBooking` reads it here rather than
 * calling half of it a second time.
 *
 * IT RETURNS THE FALLBACK FLAG BESIDE THE TEXT, because the two readers need opposite
 * things from one answer: the sentence needs Hale's words so the message is still true,
 * and the row needs to know they ARE Hale's words — a booking has no name to ask about
 * four days later, and a session key built from them would file every nameless receipt
 * from one host at one instant under a single "session" (going.ts).
 */
function renderedTitle(raw: string, kind: ExtractionKind): { text: string; fallback: boolean } {
  const vendor = sanitizedTitle(raw);
  return vendor === ''
    ? { text: GENERIC_TITLE[kind], fallback: true }
    : { text: vendor, fallback: false };
}

export interface GmailSweepAlertInput {
  familyId: string;
  /** `integrations.user_id`, which the column permits to be null. A mailbox with no
   * connecting user has nobody to text, and that is an outcome, not a skip. */
  parentUserId: string | null;
  integrationId: string;
  /** This run seeded the connection's cursor, so its envelopes are the 25 most recent
   * messages ALREADY in the mailbox — history the parent never asked to be told about.
   * Nothing is alerted; every later run sees only messages added since. */
  seeding: boolean;
  /**
   * Historical booking-shaped mail from before the cursor. Writes `activity_bookings`
   * and sends nothing: no iMessage, no offer row, no `email_alert_sent` audit.
   */
  backfill?: boolean;
  envelopes: readonly GmailAlertEnvelope[];
  now: Date;
}

/** The batch the connector sweep hands this module. Structural so email-alert does not
 * import sync.ts (sync already imports this file). */
export function gmailAlertSweepInput(
  batch: {
    connection: { id: string; familyId: string; userId: string | null };
    seeding: boolean;
    pass?: 'incremental' | 'backfill';
    envelopes: readonly GmailAlertEnvelope[];
  },
  now: Date,
): GmailSweepAlertInput {
  const backfill = batch.pass === 'backfill';
  return {
    familyId: batch.connection.familyId,
    parentUserId: batch.connection.userId,
    integrationId: batch.connection.id,
    // A backfill batch is not the seeding page. Forcing seeding false keeps a caller
    // that copied the live batch from suppressing the write.
    seeding: backfill ? false : batch.seeding,
    backfill,
    envelopes: batch.envelopes,
    now,
  };
}

/**
 * One sweep's worth of Gmail envelopes for one connection → one outcome per envelope.
 *
 * Newest first and bounded, because the interesting failure is not a quiet mailbox: it is
 * a mailbox that just received sixty messages, where the ones worth a text are the ones
 * that arrived last and the cost of reading all of them is sixty model calls.
 */
const BOOKING_WROTE = new Set<BookingOutcome>(['recorded', 'already_recorded', 'refreshed']);

/** Why this envelope did not become a text or a booking, when that is a fact worth
 * reading. Null when the pass did the thing it came to do. */
function sweepSkip(result: EmailAlertResult): string | null {
  if (result.alert === 'sent') {
    if (
      result.booking !== null &&
      result.booking !== 'booked_dark' &&
      !BOOKING_WROTE.has(result.booking)
    ) {
      return result.booking;
    }
    return null;
  }
  if (result.alert === 'backfill_suppressed') {
    if (result.booking !== null && BOOKING_WROTE.has(result.booking)) return null;
    return result.booking ?? 'backfill_suppressed';
  }
  return result.alert;
}

/** One structured line per envelope. No subject, snippet, or message id — those are
 * the mail (rule #1). A sweep that skipped everything is still readable here. Seeding
 * runs are the 25 messages already in the mailbox and are not logged. */
function logSweepOutcomes(
  input: GmailSweepAlertInput,
  outcomes: readonly EmailAlertResult[],
): void {
  if (input.seeding && input.backfill !== true) return;
  for (const result of outcomes) {
    console.info(
      {
        familyId: input.familyId,
        integrationId: input.integrationId,
        pass: input.backfill === true ? 'backfill' : 'incremental',
        alert: result.alert,
        booking: result.booking,
        going: result.going,
        skip: sweepSkip(result),
      },
      'gmail sweep: envelope outcome',
    );
  }
}

function datedEnvelopes(
  envelopes: readonly GmailAlertEnvelope[],
  limit?: number,
): {
  skipped: EmailAlertResult[];
  considered: Array<GmailAlertEnvelope & { receivedAt: string }>;
  capped: EmailAlertResult[];
} {
  const skipped: EmailAlertResult[] = [];
  const dated: Array<GmailAlertEnvelope & { receivedAt: string }> = [];
  for (const envelope of envelopes) {
    if (envelope.receivedAt === undefined)
      skipped.push({ alert: 'no_received_at', booking: null, going: null });
    else dated.push({ ...envelope, receivedAt: envelope.receivedAt });
  }
  dated.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  const bound = limit ?? dated.length;
  const capped: EmailAlertResult[] = [];
  for (let i = bound; i < dated.length; i += 1) {
    capped.push({ alert: 'over_sweep_cap', booking: null, going: null });
  }
  return { skipped, considered: dated.slice(0, bound), capped };
}

/**
 * Historical mail. The booking decision is the live one (`bookingDraftFor` and
 * `recordActivityBooking`, including the dedupe key). The parent is not told: no
 * transport, no offer, no `email_alert_sent`, no channel row.
 */
async function recordBackfillEnvelope(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    integrationId: string;
    envelope: GmailAlertEnvelope & { receivedAt: string };
    cancelledThisSweep: Set<string>;
    timeZone: string;
    now: Date;
  },
  ports: EmailAlertPorts,
): Promise<EmailAlertResult> {
  const quiet = (booking: BookingOutcome | null): EmailAlertResult => ({
    alert: 'backfill_suppressed',
    booking,
    going: null,
  });
  if (!bookedDetectionEnabledFor(input.familyId)) return quiet('booked_dark');

  const signal = falseBookingSignal({
    subject: input.envelope.subject,
    snippet: input.envelope.snippet,
  });
  if (signal) return quiet(signal);

  let classification: SentinelClassification;
  try {
    classification = await ports.classify(
      {
        familyId: input.familyId,
        messageId: input.envelope.messageId,
        subject: input.envelope.subject,
        from: input.envelope.from,
        snippet: input.envelope.snippet,
        receivedAt: input.envelope.receivedAt,
      },
      input.timeZone,
    );
  } catch (err) {
    console.error(
      {
        familyId: input.familyId,
        err: err instanceof Error ? err.constructor.name : 'unknown',
      },
      'email alert: the sentinel could not read this message - no text, and the key is unspent',
    );
    return { alert: 'classifier_failed', booking: null, going: null };
  }

  const extraction = classification.extraction;
  if (classification.status !== 'classified' || extraction === null) {
    return { alert: 'not_parenting', booking: null, going: null };
  }

  const cancellationKey = bookingCancellationKey(
    input.envelope.from,
    sanitizedTitle(extraction.event.title),
  );
  if (extraction.kind === 'cancellation') {
    await closeBookingsFor(database, {
      familyId: input.familyId,
      from: input.envelope.from,
      title: extraction.event.title,
      now: input.now,
    });
    if (cancellationKey !== null) input.cancelledThisSweep.add(cancellationKey);
    return quiet('not_a_booking');
  }
  if (
    extraction.kind === 'booking_confirmation' &&
    cancellationKey !== null &&
    input.cancelledThisSweep.has(cancellationKey)
  ) {
    return { alert: 'cancelled_in_sweep', booking: null, going: null };
  }

  const draft = bookingDraftFor(extraction, input.envelope.from, true, input.now);
  const booking = await recordBooking(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    integrationId: input.integrationId,
    messageId: input.envelope.messageId,
    channelMessageId: null,
    draft,
  });
  const passport = await attachPassportToEmailAlert(database, {
    body: '',
    sending: false,
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    integrationId: input.integrationId,
    messageId: input.envelope.messageId,
    subject: input.envelope.subject,
    title: extraction.event.title,
    kind: extraction.kind,
    teenAttributed: extraction.teenAttributed,
    childRef: extraction.event.childRef,
    now: input.now,
  });
  await passport.afterSend();
  return quiet(booking);
}

export async function alertParentForGmailSweep(
  database: Database,
  input: GmailSweepAlertInput,
  ports: EmailAlertPorts,
): Promise<readonly EmailAlertResult[]> {
  const { parentUserId, envelopes } = input;
  if (parentUserId === null) {
    const outcomes = envelopes.map(
      (): EmailAlertResult => ({ alert: 'no_parent_user', booking: null, going: null }),
    );
    logSweepOutcomes(input, outcomes);
    return outcomes;
  }
  if (input.seeding && input.backfill !== true) {
    return envelopes.map(() => ({ alert: 'seeding_run', booking: null, going: null }));
  }

  if (input.backfill === true) {
    // A backfill is not a text. The page size is a processing budget so one
    // mailbox cannot spend the tick; the unread remainder is named
    // over_sweep_cap and is not recorded on this pass.
    const { skipped, considered, capped } = datedEnvelopes(
      envelopes,
      BOOKED_BACKFILL_MAX_PER_SWEEP,
    );
    const outcomes: EmailAlertResult[] = [...skipped, ...capped];
    if (considered.length > 0) {
      const timeZone = await ports.timeZone(parentUserId);
      const cancelledThisSweep = new Set<string>();
      for (const envelope of considered) {
        outcomes.push(
          await recordBackfillEnvelope(
            database,
            {
              familyId: input.familyId,
              parentUserId,
              integrationId: input.integrationId,
              envelope,
              cancelledThisSweep,
              timeZone,
              now: input.now,
            },
            ports,
          ),
        );
      }
    }
    logSweepOutcomes(input, outcomes);
    return outcomes;
  }

  // The lane holds the booking pass. It does not text: a parenting email is recorded,
  // and the parent is not sent a message about it.
  if (!laneEnabled('email_alert')) {
    const outcomes = envelopes.map(
      (): EmailAlertResult => ({ alert: 'lane_off', booking: null, going: null }),
    );
    logSweepOutcomes(input, outcomes);
    return outcomes;
  }

  const { skipped, considered, capped } = datedEnvelopes(envelopes);
  const outcomes: EmailAlertResult[] = [...skipped, ...capped];
  if (considered.length === 0) {
    logSweepOutcomes(input, outcomes);
    return outcomes;
  }

  const timeZone = await ports.timeZone(parentUserId);
  const cancelledThisSweep = new Set<string>();
  for (const envelope of considered) {
    outcomes.push(
      await recordBackfillEnvelope(
        database,
        {
          familyId: input.familyId,
          parentUserId,
          integrationId: input.integrationId,
          envelope,
          cancelledThisSweep,
          timeZone,
          now: input.now,
        },
        ports,
      ),
    );
  }
  logSweepOutcomes(input, outcomes);
  return outcomes;
}

/** What the booking row names when a vendor title survives sanitising as nothing.
 * Hale's own words, so a nameless receipt is not filed under one shared "session". */
const GENERIC_TITLE: Record<ExtractionKind, string> = {
  cancellation: 'something was cancelled',
  reschedule: 'something moved',
  new_event: 'a new date',
  reminder_only: 'there is something coming up',
  unclear: 'a possible schedule change',
  booking_confirmation: 'a spot',
};

/** The place as the booking row keeps it. A digit is allowed: a room number on the
 * family's own row is the useful half of an address. */
const TITLE_MAX = 60;

function foldedPlace(location: string | null): string | null {
  const place = clamp(gsm7(location ?? ''), TITLE_MAX);
  return place === '' ? null : place;
}

/** The vendor's filing label off the front and its punctuation off the back. One fold,
 * read by the booking row and by a cancellation matched against that row. */
const VENDOR_LABEL =
  /^(?:reminder|cancell?ed|rescheduled|postponed|new|update|updated|notice|fyi)\s*[:\-]\s*/i;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

function sanitizedTitle(raw: string): string {
  return clamp(gsm7(raw).replace(VENDOR_LABEL, ''), TITLE_MAX).replace(TRAILING_PUNCTUATION, '');
}

/** Typographic characters a mail client emits that have an obvious ASCII fold. */
const GSM7_FOLDS: Record<string, string> = {
  '\u2018': "'",
  '\u2019': "'",
  '\u201a': "'",
  '\u201c': '"',
  '\u201d': '"',
  '\u2013': '-',
  '\u2014': '-',
  '\u2212': '-',
  '\u2026': '...',
  '\u00a0': ' ',
  '\u2009': ' ',
  '\u202f': ' ',
  '\u2022': '-',
};

function gsm7(text: string): string {
  let out = '';
  for (const char of text) {
    for (const folded of GSM7_FOLDS[char] ?? char) {
      if (isPrintableGsm7Basic(folded)) out += folded;
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max / 2 ? cut.slice(0, space) : cut).trimEnd();
}
