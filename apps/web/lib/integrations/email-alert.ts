import { type Database, householdFamilyEvent, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { f14EnabledFor } from '~/lib/channel/f14';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { laneEnabled } from '~/lib/channel/lanes';
import { acceptedStatus, dedupeActive } from '~/lib/channel/ledger';
import { familyOutboundTarget } from '~/lib/channel/linq/family-outbound';
import { withOptOut } from '~/lib/channel/opt-out';
import {
  type ProactiveSendRequest,
  type ProactiveSendVerdict,
  holdStatus,
} from '~/lib/channel/outbound-gate';
import {
  failedSendPatch,
  readSendRefusal,
  sendResolvingNewChat,
} from '~/lib/channel/outbound-transport';
import { isPrintableGsm7Basic } from '~/lib/channel/sms-segments';
import type { threadProactiveMessage } from '~/lib/channel/thread';
import { attachPassportToEmailAlert } from '~/lib/passport/ingest';
import type {
  CorrelatedEventRef,
  ExtractedEvent,
  ExtractionKind,
  FamilyChildRef,
  InboxEnvelope,
  SentinelClassification,
} from '~/lib/sentinel';
import { falseBookingSignal } from '~/lib/sentinel/booking-guard';
import { bookedDetectionEnabledFor } from './booked';
import {
  type BookingDraftResult,
  bookingCancellationKey,
  bookingDraft,
  closeCancelledBookings,
  familyHoldsLiveBooking,
  recordActivityBooking,
} from './booking';
import {
  type EmailAlertNotice,
  type EmailAlertNoticeFacts,
  emailAlertNoticeFacts,
  quietBeforeWriting,
} from './email-alert-notice';
import {
  type EmailAlertOfferDraft,
  recordEmailAlertOffer,
  withdrawEmailAlertOffer,
} from './email-alert-offer';
import {
  type GoingCount,
  type GoingOutcome,
  goingCount,
  goingCountEnabled,
  goingOutcome,
  readSessionGoing,
} from './going';
import { readRecentNotices } from './recent-notices';

/**
 * A parenting email in a connected Gmail becomes ONE text to the parent.
 *
 * The two halves this joins have both existed for a while and never met: the connector
 * sweep reads envelopes and enqueues them as drafts on a web page nobody opens, and the
 * E2 sentinel can tell a cancelled swim class from a newsletter but had no production
 * caller at all. This module is the join, and it is deliberately the only thing between
 * them — the classifier's verdict decides whether the email holds a dated change, the
 * notice writer (email-alert-notice.ts) decides from facts whether it is about THIS
 * family's children and clear, and writes every word if so, and the outbound chokepoint
 * decides whether Hale may speak right now. No sentence is assembled here.
 *
 * WHAT IT MAY NOT DO, and the reasons are not stylistic:
 *   - The SMS carries no line of the email. The snippet, the quote evidence and the body
 *     never reach the writer, a wire body or an audit row (rule #1).
 *   - A 13+ child's mail is category-only. The pipeline has already genericized the title
 *     by the time this sees it, and the facts additionally drop the sender, subject, time
 *     and place, because a therapist's domain and a Thursday 4pm are the disclosure.
 *   - Nothing is sent that the writer did not write: an email that is not about the kids,
 *     is unclear, or could not be written ends as a named outcome with no text.
 *   - An email about an occasion already on the family's calendar is told only when it
 *     CHANGES it (a cancellation or a move). Anything else would be a second text about
 *     something the parent already has.
 *   - Every ending is a named outcome ({@link EmailAlertOutcome}) the cron summary counts
 *     (rule #11). A throw is the one ending this module cannot name for itself, so the
 *     sweep holds a boundary around the call and names it `alert_failed` — because the
 *     alternative, which this code shipped with, was Hale's own bug arriving as a broken
 *     Gmail CONNECTION: a lie about Google that stops the ingest too.
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
  /** The extraction or the notice writer could not tell what the email was about. */
  'unclear',
  /** The notice writer judged the email is not about this family's children. */
  'not_about_the_kids',
  /** The family already holds this occasion and the email does not change it. */
  'already_on_calendar',
  /** The notice writer failed or every draft was refused. There is no fallback. */
  'notice_unwritten',
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
  'no_received_at',
  'gate_refused:not_enrolled',
  'gate_refused:opt_out_unread',
  'gate_refused:no_watch_consent',
  'gate_refused:quiet_hours',
  'classifier_failed',
  'no_send_target',
  'send_failed',
  'alert_failed',
  /** A claimed Linq group. Mailbox subjects, senders, and bodies stay off the
   * group and off SMS. Kid dates, when they exist, use the kid-event notice. */
  'group_privacy',
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
  /** This family's children, the notice writer's context for "is this about them". */
  familyChildren(): Promise<readonly FamilyChildRef[]>;
  /** The language this parent texts Hale in (`readNoticeLanguage`): the notice is written in it. */
  parentLanguage(parentUserId: string, now: Date): Promise<string>;
  /** The notice writer: one model call that decides and writes, or sends nothing. Its
   * quality is the eval's job (rule #8); a port here, like `classify`. */
  writeNotice(facts: EmailAlertNoticeFacts, familyId: string): Promise<EmailAlertNotice>;
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
  const { familyId, parentUserId, integrationId, messageId, now } = input;
  if (!f14EnabledFor(familyId)) return { alert: 'dark', booking: null, going: null };
  if (!laneEnabled('email_alert')) return { alert: 'lane_off', booking: null, going: null };

  const dedupeKey = emailAlertDedupeKey(integrationId, messageId);
  // Read BEFORE the classifier, not only via the claim below: a re-fired sweep over a
  // mailbox it has already read must cost nothing, and the claim happens after two model
  // calls have already been paid for.
  if (await dedupeActive(dedupeKey, database))
    return { alert: 'already_sent', booking: null, going: null };

  let classification: SentinelClassification;
  try {
    classification = await ports.classify(
      {
        familyId,
        messageId,
        subject: input.envelope.subject,
        from: input.envelope.from,
        snippet: input.envelope.snippet,
        receivedAt: input.envelope.receivedAt,
      },
      input.timeZone,
    );
  } catch (err) {
    // The class only — a rejection from the body fetch or the model can carry subject
    // lines and addresses in its message (rule #1).
    console.error(
      { familyId, err: err instanceof Error ? err.constructor.name : 'unknown' },
      'email alert: the sentinel could not read this message - no text, and the key is unspent',
    );
    return { alert: 'classifier_failed', booking: null, going: null };
  }

  const extraction = classification.extraction;
  if (classification.status !== 'classified' || extraction === null) {
    return { alert: 'not_parenting', booking: null, going: null };
  }
  // The extraction's own verdict that it could not tell what changed. Nothing true and
  // specific is left to say, so nothing is said.
  const kind = extraction.kind;
  const quiet = quietBeforeWriting(extraction);
  if (kind === 'unclear' || quiet === 'unclear') {
    return { alert: 'unclear', booking: null, going: null };
  }

  // ONE read of the flag per envelope, threaded into every call below rather than read
  // again: the closer, the facts and the row they promise must be built from the same
  // answer.
  const booked = bookedDetectionEnabledFor(familyId);

  // ONE KEY, TWO USES: the closer matches the table on it, and the sweep remembers it.
  const cancellationKey = bookingCancellationKey(
    input.envelope.from,
    sanitizedTitle(extraction.event.title),
  );

  // A RECEIPT FOR A CLASS THIS SWEEP HAS ALREADY BEEN TOLD IS OFF. Nothing true is left to
  // say: the batch is newest-first, so this email is older than the cancellation, and
  // "you're in for Swim Level 2" would contradict a text this same run put on the same
  // phone. No text, no CTA, no offer row, no booking — the suppression sits ABOVE the gate
  // and above the claim so none of the three is minted for a message nobody is told about.
  if (
    booked &&
    extraction.kind === 'booking_confirmation' &&
    cancellationKey !== null &&
    input.cancelledThisSweep.has(cancellationKey)
  ) {
    console.warn(
      { familyId },
      'email alert: a receipt for a class this sweep already read the cancellation of - staying quiet',
    );
    return { alert: 'cancelled_in_sweep', booking: null, going: null };
  }

  // ALREADY ON THE CALENDAR AND UNCHANGED: a reminder, a re-announcement or a second
  // receipt for an occasion the family already holds is a duplicate of what they have.
  // Only a cancellation or a move is news about it. The booking row is still written, as
  // the backfill writes it, because the receipt is evidence whether or not a text goes.
  if (quiet === 'already_on_calendar') {
    return {
      alert: 'already_on_calendar',
      booking: await recordQuietBooking(database, {
        familyId,
        parentUserId,
        integrationId,
        messageId,
        envelope: input.envelope,
        extraction,
        booked,
        now,
      }),
      going: null,
    };
  }

  // THE BOOKING DECISION and the count come first, because both are facts the writer is
  // handed, and the post-send write reuses the same draft: the row and the number the
  // parent is told cannot be read off two different keys.
  const draft = bookingDraftFor(extraction, input.envelope.from, booked, now);
  // Gated on `draft.ok`, which is gated on `booked`: a dark-booked family's sweep never
  // reads other families' bookings.
  const counted = await readGoingFor(database, familyId, draft);
  // The one pure decision the offer row is written from. The writer is told whether it may
  // ask, and the refusals hold its question to this answer.
  const offer = emailAlertOfferDraft({
    kind,
    event: extraction.event,
    teenContent: extraction.teenContent,
    matchedEventRef: extraction.matchedEventRef,
    booked,
    from: input.envelope.from,
    now,
  });

  const facts = emailAlertNoticeFacts({
    from: input.envelope.from,
    subject: input.envelope.subject,
    // Dark-booked, a receipt is a new date like any other: the writer is not told about a
    // place Hale is not recording (`effectiveKind`).
    kind: kind === 'booking_confirmation' && !booked ? 'new_event' : kind,
    extraction,
    children: await ports.familyChildren(),
    fromParentsOwnCalendar: fromParentsCalendar(input.envelope.from),
    offer:
      offer === null
        ? null
        : offer.kind === 'booking_confirmation'
          ? 'add_to_calendar'
          : 'add_to_week',
    otherHaleFamiliesGoing: counted?.shown ? counted.others : null,
    language: await ports.parentLanguage(parentUserId, now),
    recentNotices: await readRecentNotices(database, { familyId, parentUserId }),
    durationMinutes: await matchedDurationMinutes(database, familyId, extraction.matchedEventRef),
    timeZone: input.timeZone,
    now,
  });
  // ABOVE THE GATE: an email the writer will not text about leaves no hold receipt for a
  // text that was never going to exist.
  const notice = await ports.writeNotice(facts, familyId);
  if (!notice.send) {
    console.info({ familyId, outcome: notice.why }, 'email alert: nothing sent');
    return { alert: NOT_SENT[notice.why], booking: null, going: null };
  }

  // THE PROVIDER CANCELLED IT, so Hale stops holding it — but only once the writer has
  // said this email is about these children and clear. A cancellation the model calls
  // not about the kids (or cannot read) must not close a child's booking on a sender and
  // title key alone. It still runs ABOVE THE GATE: a hold returns before every post-send
  // line, and the Gmail cursor advanced past this message the moment the sweep read it,
  // so a closer placed after the send would leave a 23:40 cancellation permanently
  // unread. Closing a booking is not speaking to anybody, so the chokepoint has no say.
  if (booked && extraction.kind === 'cancellation') {
    await closeBookingsFor(database, {
      familyId,
      from: input.envelope.from,
      title: extraction.event.title,
      now,
    });
    // ...AND THE REST OF THIS SWEEP HEARS ABOUT IT. The closer above can only stamp rows
    // that already exist, and the receipt for this class may still be three envelopes
    // away — older, therefore read later.
    if (cancellationKey !== null) input.cancelledThisSweep.add(cancellationKey);
  }

  const verdict = await ports.gate({ familyId, parentUserId, kind: 'email_alert', now });
  if (!verdict.allowed) {
    // A RECEIPT, not a claim. Unlike a nudge, a held email alert is not deferred: the
    // Gmail cursor advanced past this message the moment the sweep read it, so nothing
    // will offer it again. This row is therefore the whole lasting record that Hale read
    // a parenting email at 23:40 and chose to stay quiet — a counter in a cron response
    // is not something a parent or a support agent can ever be shown.
    //
    // The key stays NULL: the unique index is total over non-null dedupe keys, so a
    // suppression carrying it would block the send it is a record of NOT making.
    await database.insert(schema.channelMessages).values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'email_alert',
      templateKey: EMAIL_ALERT_TEMPLATE_KEY,
      dedupeKey: null,
      status: holdStatus(verdict.reason),
    });
    console.warn({ familyId, reason: verdict.reason }, 'email alert: held by the outbound gate');
    return { alert: `gate_refused:${verdict.reason}`, booking: null, going: null };
  }

  const passport = await attachPassportToEmailAlert(database, {
    body: notice.text,
    sending: true,
    familyId,
    parentUserId,
    integrationId,
    messageId,
    subject: input.envelope.subject,
    title: extraction.event.title,
    kind: extraction.kind,
    teenAttributed: extraction.teenAttributed,
    childRef: extraction.event.childRef,
    now,
  });

  // CLAIM FIRST, by the insert rather than by a read a concurrent sweep can race. The
  // dedupe read above is the cost guard; this is the correctness one.
  const [claimed] = await database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'email_alert',
      templateKey: EMAIL_ALERT_TEMPLATE_KEY,
      dedupeKey,
      status: acceptedStatus('sms'),
      sentAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.channelMessages.id });
  if (!claimed) return { alert: 'already_sent', booking: null, going: null };

  const to = await ports.resolvePhone(database, parentUserId);
  if (!to) {
    // The gate just said this parent has a live channel, so this is a contradiction
    // between two readers of the same table. Recorded on the claimed row rather than
    // thrown: the row is already claimed, and leaving it queued forever would read as a
    // text in flight.
    await database
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: 'no_send_target' })
      .where(eq(schema.channelMessages.id, claimed.id));
    console.error(
      { familyId, parentUserId },
      'email alert: the gate allowed a parent with no sendable number',
    );
    return { alert: 'no_send_target', booking: null, going: null };
  }

  let providerMessageId: string;
  let carried: 'sms' | 'imessage' = 'sms';
  let chatId: string | null = null;
  try {
    const sent = await sendResolvingNewChat(ports.transport, {
      to,
      body: withOptOut(passport.body, verdict.optOut),
    });
    providerMessageId = sent.providerMessageId;
    if (sent.transport === 'imessage') {
      carried = 'imessage';
      chatId = sent.chatId ?? null;
    }
  } catch (err) {
    const code = readSendRefusal(err)?.code ?? 'unknown';
    await database
      .update(schema.channelMessages)
      .set(failedSendPatch(code))
      .where(eq(schema.channelMessages.id, claimed.id));
    console.error({ familyId, code }, 'email alert: the provider refused the text');
    return { alert: 'send_failed', booking: null, going: null };
  }

  await database
    .update(schema.channelMessages)
    .set(
      carried === 'imessage'
        ? {
            providerMessageId,
            channel: 'imessage',
            providerChatId: chatId,
            status: acceptedStatus('imessage'),
          }
        : { providerMessageId },
    )
    .where(eq(schema.channelMessages.id, claimed.id));

  // AFTER THE SEND, and that order is the rule rather than convenience: an offer nobody
  // was told about is not an offer, and a row minted for a text the transport refused
  // would make every bare affirmative in this household ambiguous for a day against a
  // question that was never asked. The exposure runs the other way too — a throw between
  // here and the send leaves a CTA with nothing behind it — which is why this sits with
  // the thread and the audit row, in the stretch the sweep names `alert_failed`.
  if (offer !== null) {
    await recordEmailAlertOffer(database, {
      familyId,
      parentUserId,
      integrationId,
      messageId,
      channelMessageId: claimed.id,
      draft: offer,
      now,
    });
  }

  // THE BOOKING, in the same post-send stretch and for the same reason: the evidence is
  // the provider's receipt, not the parent's reply, so it is written at DETECTION rather
  // than on the YES — a parent who keeps their own calendar says NO and is still booked.
  //
  // IN ITS OWN CATCH, and that is the difference between `record_failed` being a real
  // outcome and an unreachable one. An uncaught throw here becomes `alert_failed` at the
  // sweep's boundary and SKIPS the thread and the audit below — leaving a parent's thread
  // that the coach reads a reply to with nothing above it. The text went out; the row not
  // landing must not take the two receipts for it down as well.
  const booking = await recordBooking(database, {
    familyId,
    parentUserId,
    integrationId,
    messageId,
    channelMessageId: claimed.id,
    draft,
    offered: offer !== null,
  });
  await passport.afterSend();

  // The written text. The opt-out line is not appended, so this is also the wire body.
  // The coach re-reads this row next turn (channel/thread.ts).
  await ports.threadMessage(database, { familyId, parentUserId, body: passport.body });

  await database.insert(schema.auditLog).values({
    familyId,
    actor: 'system',
    actionTaken: 'email_alert_sent',
    targetTable: 'channel_messages',
    targetId: claimed.id,
    // Enums and flags only. Not the title, not the sender, not the subject: an audit row
    // a support agent can read is a copy of the email in a table that is never redacted.
    //
    // `othersCount` is EXACTLY what the writer was handed, and a bare integer about no
    // identifiable person is a flag: it is what makes this row able to answer "what could
    // Hale have told me about other families". `null` whenever nothing was shown - the REASON lives in the
    // cron counter, because `below_floor` will be the answer ten thousand times and a
    // column full of it is noise rather than a receipt.
    //
    // IT IS THE ONLY ROW THIS DISCLOSURE WRITES. The counted families get none: a row in
    // their trail saying their booking was counted into a text to another family would tell
    // them another Hale family is in their child's class - the same disclosure, in reverse,
    // to a household that was never asked.
    after: {
      kind,
      teenContent: extraction.teenContent,
      othersCount: counted?.shown ? counted.others : null,
    },
  });

  return {
    alert: 'sent',
    booking,
    going: counted === null ? null : goingOutcome(counted),
  };
}

const NOT_SENT: Record<Extract<EmailAlertNotice, { send: false }>['why'], EmailAlertOutcome> = {
  not_about_the_kids: 'not_about_the_kids',
  unclear: 'unclear',
  unwritten: 'notice_unwritten',
};

/**
 * An email about an occasion the family already holds, which does not change it: no
 * text, no offer, no channel row. A receipt still becomes its booking row, through the
 * same decision the live path uses, exactly as the quiet backfill writes one.
 */
async function recordQuietBooking(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    integrationId: string;
    messageId: string;
    envelope: EmailAlertInput['envelope'];
    extraction: NonNullable<SentinelClassification['extraction']>;
    booked: boolean;
    now: Date;
  },
): Promise<BookingOutcome> {
  const { extraction } = input;
  const booking = await recordBooking(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    integrationId: input.integrationId,
    messageId: input.messageId,
    channelMessageId: null,
    draft: bookingDraftFor(extraction, input.envelope.from, input.booked, input.now),
    offered: false,
  });
  const passport = await attachPassportToEmailAlert(database, {
    body: '',
    sending: false,
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    integrationId: input.integrationId,
    messageId: input.messageId,
    subject: input.envelope.subject,
    title: extraction.event.title,
    kind: extraction.kind,
    teenAttributed: extraction.teenAttributed,
    childRef: extraction.event.childRef,
    now: input.now,
  });
  await passport.afterSend();
  return booking;
}

/**
 * The booking decision, made ONCE and before the notice is written (R3).
 *
 * `null` and not a refusal when booked detection is dark: "this family's receipts are not
 * being recorded" is a different fact from "this receipt was refused", and `recordBooking`
 * turns the two into `booked_dark` and the reason respectively.
 */
function bookingDraftFor(
  extraction: NonNullable<SentinelClassification['extraction']>,
  from: string,
  booked: boolean,
  now: Date,
): BookingDraftResult | null {
  if (!booked) return null;
  const title = sanitizedTitle(extraction.event.title);
  return bookingDraft({
    kind: extraction.kind,
    event: extraction.event,
    from,
    teenContent: extraction.teenContent,
    teenAttributed: extraction.teenAttributed,
    sourceConfidence: extraction.sourceConfidence,
    matchedEventRef: extraction.matchedEventRef,
    // The VENDOR's own name for the class, through the one fold the cancellation key and
    // the offer row use. A title that folds to nothing is refused as `no_title`.
    title,
    titleIsFallback: title === '',
    // The same fold the offer row's place goes through, and the same function.
    location: foldedPlace(extraction.event.location),
    now,
  });
}

/**
 * HOW MANY OTHER HALE FAMILIES HOLD THIS SESSION - or the named reason there is no number.
 *
 * `null` is "never reached the going decision", exactly as `booking: null` is on the other
 * axis. The ONE booking refusal that keeps its own name here is the teen one: how often a
 * disclosure is withheld for a 13+ child is a rate rule #1 wants readable, and burying it
 * under `going_dark` would make it unreadable for the whole dark period - which is the
 * period that matters.
 *
 * DARK MEANS THE QUERY IS NOT RUN AT ALL, not run and discarded. No flag-off read of
 * another household's bookings.
 */
async function readGoingFor(
  database: Database,
  familyId: string,
  draft: BookingDraftResult | null,
): Promise<GoingCount | null> {
  if (draft === null) return null;
  if (!draft.ok) {
    return draft.reason === 'teen_attributed' ? { shown: false, reason: 'teen_attributed' } : null;
  }
  if (!goingCountEnabled()) return { shown: false, reason: 'going_dark' };
  try {
    // The session key is the full instant, so an invoice at 1:00 and a receipt at 1:05
    // are two keys and `alreadyHeld` never fires. The class key is the date. Holding it
    // already is `repeat_receipt` — the count is not spoken, and this household is not
    // added to it a second time.
    const held = await familyHoldsLiveBooking(database, {
      familyId,
      providerHost: draft.draft.providerHost,
      title: draft.draft.title,
      firstSessionAt: draft.draft.firstSessionAt,
    });
    if (held) return { shown: false, reason: 'repeat_receipt' };
    const sessionKey = draft.draft.sessionKey;
    if (sessionKey === null) return { shown: false, reason: 'no_session' };
    return goingCount(await readSessionGoing(database, { familyId, sessionKey }));
  } catch (err) {
    // THE TEXT STILL GOES. The count is the least important thing in this message, and a
    // silent zero would be indistinguishable from an empty room. The error CLASS only - a
    // query rejection can carry parameter values, and the key is a title (rule #1).
    console.error(
      { familyId, err: err instanceof Error ? err.constructor.name : 'unknown' },
      'email alert: the going count could not be read - the text goes without the clause',
    );
    return { shown: false, reason: 'count_unavailable' };
  }
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
 * notice so the writer is handed a count read off the key this row will carry (R3). One
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
    /** Whether the text that went out asked to put it on the calendar. */
    offered: boolean;
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
      after: { offered: input.offered },
    });
  }
  return recorded.outcome;
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
 * Newest first. Every dated envelope in the sweep is read. A count is not a reason
 * to leave one unsaid.
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

function datedEnvelopes(envelopes: readonly GmailAlertEnvelope[]): {
  skipped: EmailAlertResult[];
  considered: Array<GmailAlertEnvelope & { receivedAt: string }>;
} {
  const skipped: EmailAlertResult[] = [];
  const dated: Array<GmailAlertEnvelope & { receivedAt: string }> = [];
  for (const envelope of envelopes) {
    if (envelope.receivedAt === undefined)
      skipped.push({ alert: 'no_received_at', booking: null, going: null });
    else dated.push({ ...envelope, receivedAt: envelope.receivedAt });
  }
  dated.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  return { skipped, considered: dated };
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
    offered: false,
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
    // A backfill is not a text. Every dated envelope this pass was handed is recorded.
    const { skipped, considered } = datedEnvelopes(envelopes);
    const outcomes: EmailAlertResult[] = [...skipped];
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

  // Below the backfill pass on purpose: that pass never texts, and it is held under this
  // lane by backfillBookedMail (sync.ts), where its page cursor lives.
  if (!laneEnabled('email_alert')) {
    const outcomes = envelopes.map(
      (): EmailAlertResult => ({ alert: 'lane_off', booking: null, going: null }),
    );
    logSweepOutcomes(input, outcomes);
    return outcomes;
  }

  // Nothing from a mailbox reaches the group, and a family whose home channel
  // is the group is not texted the same mail on SMS either.
  const outbound = await familyOutboundTarget(database, input.familyId);
  if (outbound.channel === 'group') {
    console.info(
      { familyId: input.familyId },
      'email alert: mailbox stays off the group and off SMS',
    );
    const outcomes = envelopes.map(
      (): EmailAlertResult => ({ alert: 'group_privacy', booking: null, going: null }),
    );
    logSweepOutcomes(input, outcomes);
    return outcomes;
  }

  const { skipped, considered } = datedEnvelopes(envelopes);
  const outcomes: EmailAlertResult[] = [...skipped];
  if (considered.length === 0) {
    logSweepOutcomes(input, outcomes);
    return outcomes;
  }

  const timeZone = await ports.timeZone(parentUserId);
  // ONE SET FOR THE WHOLE BATCH. The sort above is what makes it sound: every envelope
  // read after a cancellation is OLDER than that cancellation, so a receipt that lands in
  // this set is a receipt the provider has since called off.
  const cancelledThisSweep = new Set<string>();
  for (const envelope of considered) {
    outcomes.push(
      await alertParentForEmail(
        database,
        {
          familyId: input.familyId,
          parentUserId,
          integrationId: input.integrationId,
          messageId: envelope.messageId,
          envelope: {
            subject: envelope.subject,
            from: envelope.from,
            snippet: envelope.snippet,
            receivedAt: envelope.receivedAt,
          },
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

// ── The offer, and the folds the rows keep ───────────────────────────────────

/**
 * THE KIND THE OFFER IS BUILT FROM.
 *
 * Dark, `booking_confirmation` simply IS `new_event` here: the same offer row and the same
 * offered instant. The kind itself never changes — it stays in `EXTRACTION_KINDS` in both
 * states, because a flag that changed what the model may return would re-key the eval
 * cache on every flip.
 */
function effectiveKind(kind: ExtractionKind, booked: boolean): ExtractionKind {
  return kind === 'booking_confirmation' && !booked ? 'new_event' : kind;
}

/** The clamp on every vendor string a row keeps. */
const TITLE_MAX = 60;

/** `Reminder:`, `CANCELLED -`, `New:` — the label a vendor files its own subject line
 * under, off the front of the name a ROW keeps (the offer, the booking and the
 * cancellation key), so a cancellation matches the booking it cancels. It never decides
 * whether or what Hale texts. */
const VENDOR_LABEL =
  /^(?:reminder|cancell?ed|rescheduled|postponed|new|update|updated|notice|fyi)\s*[:\-]\s*/i;

/** The full stop that ends someone else's line, off the back of a row's name. */
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/**
 * THE ONE OFFER THIS TEXT MAY MAKE, and the row that has to exist before it may be made.
 *
 * The sentence used to be here with nothing behind it. An email alert registered no open
 * question of any kind, so a parent doing exactly what the text told them to do reached
 * the coach with nothing drafted — or, with one unrelated action pending, APPROVED THAT
 * ONE: consent read against a question it was never given to (rule #4). The line was
 * removed in #649 and the module's note said what it would take to bring it back: a row
 * of its own, because `agent_commitments` permits ONE open promise of a kind per family
 * while the gate allows three alerts a day, and because the row has to carry a title and
 * an instant that the ledger's parent-safe `summary` and closed-vocabulary `topic` cannot
 * hold. That row is `email_alert_offers` (lib/integrations/email-alert-offer.ts), and
 * this function is the single decision both it and the writer's question are derived from.
 *
 * SIX CONDITIONS, and each one is a way the question would otherwise be untrue:
 *   · A 13+ child's mail is genericised by the time this sees it, so there is no occasion
 *     left to add and nothing that could be added without re-disclosing what the teen
 *     gate just removed (rule #1). No row and no question.
 *   · A CANCELLATION is the removal of a date. Putting it on the week is the opposite of
 *     what the email said. `unclear` means Hale could not tell what the email was.
 *   · The occasion must have a CONCRETE time: the destination for a move or a new date,
 *     the stated one for a reminder. "Invalid Date" is the model's free text failing, and
 *     a week entry at the epoch is worse than no offer.
 *   · It must be in the FUTURE. An offer to put last Tuesday on your week is a sentence
 *     nobody would write.
 *   · The family must not already TRACK it (`matchedEventRef`). A reschedule of a class
 *     Hale already holds would be placed beside the old one — two copies of one Saturday,
 *     from a text that promised to tidy it. This is also what stops a REGISTRATION
 *     RECEIPT for a class the family already has being offered a second time, and it is
 *     reachable for a booking only because `correlate.ts` maps the kind to a time.
 *   · The mail must not already BE the parent's calendar. A Google Calendar notification
 *     is the week speaking about an event that is on it; "Want me to add it to your
 *     week?" asks them to add what they already have.
 *
 * Everything else is told without a question, and that is still the common case.
 */
export function emailAlertOfferDraft(input: {
  kind: ExtractionKind;
  event: ExtractedEvent;
  teenContent: boolean;
  matchedEventRef: CorrelatedEventRef | null;
  booked: boolean;
  /** The envelope's From. A Google Calendar notification is not an offer. */
  from: string;
  now: Date;
}): EmailAlertOfferDraft | null {
  if (input.teenContent || input.matchedEventRef !== null || fromParentsCalendar(input.from)) {
    return null;
  }
  const kind = effectiveKind(input.kind, input.booked);
  const startsAt = instant(OFFERED_TIME[kind](input.event));
  if (startsAt === null || startsAt.getTime() <= input.now.getTime()) return null;
  const title = sanitizedTitle(input.event.title);
  if (title === '') return null;
  const place = foldedPlace(input.event.location);
  // The EFFECTIVE kind on the row too, so a dark booking is a `new_event` offer in the
  // ledger exactly as it is on the wire — and so a lit one is the thing `stampBookingEvent`
  // can recognise when the parent says yes.
  return { kind, title, startsAt, location: place };
}

/**
 * The place as a ROW keeps it — folded and clamped like everything else this file writes
 * down, because these strings reach a wire later, in a reminder or in an ask.
 *
 * ONE function, read by the offer row and by the booking row, so the two rows born from
 * one email can never hold the place differently.
 */
function foldedPlace(location: string | null): string | null {
  const place = clamp(gsm7(location ?? ''), TITLE_MAX);
  return place === '' ? null : place;
}

/** WHICH time field is the occasion, per kind. A move's destination, a new date's date,
 * and the stated time of something the parent already has. */
const OFFERED_TIME: Record<ExtractionKind, (event: ExtractedEvent) => string | null> = {
  new_event: (event) => event.newTime,
  reschedule: (event) => event.newTime,
  reminder_only: (event) => event.originalTime,
  // The first session. This entry is the whole of what makes the YES path work for a
  // booking: the offer, the row and the placement are the ones that already exist.
  booking_confirmation: (event) => event.newTime,
  cancellation: () => null,
  unclear: () => null,
};

/**
 * The vendor's own filing label off the front and its punctuation off the back: the name
 * the offer row, the booking row and the cancellation key all keep. ONE function, so the
 * three can never hold the class differently.
 */
function sanitizedTitle(raw: string): string {
  return clamp(gsm7(raw).replace(VENDOR_LABEL, ''), TITLE_MAX).replace(TRAILING_PUNCTUATION, '');
}

/**
 * A Google Calendar notification, named by the address Google sends it from or by the
 * display name the parent's phone already showed. Either one means the event is on
 * their calendar. A school that merely mentions a calendar does not match: the address
 * is exact, and the display name is the whole label.
 */
function fromParentsCalendar(from: string): boolean {
  const display = /^\s*"?([^"<]*?)"?\s*<[^>]*>\s*$/.exec(from)?.[1]?.trim() ?? '';
  if (/^google calendar$/i.test(display)) return true;
  const address = (/<([^>]*)>/.exec(from)?.[1] ?? from).trim();
  return /^calendar-notification@google\.com$/i.test(address);
}

function instant(iso: string | null): Date | null {
  if (iso === null) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The typographic characters a mail client emits that GSM-7 has no septet for. One
 * curly apostrophe in a subject line flips the WHOLE body to UCS-2 and halves the
 * segment budget, for a difference nobody reading it can see. */
const GSM7_FOLDS: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '‚': "'",
  '“': '"',
  '”': '"',
  '–': '-',
  '—': '-',
  '−': '-',
  '…': '...',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  '•': '-',
};

/**
 * Vendor text, made safe to put on a wire Hale is billed for: folded where there is an
 * obvious ASCII equivalent, dropped where there is not, whitespace collapsed to single
 * spaces so a subject line cannot open a second line under Hale's name.
 *
 * The strict printable-basic test rather than {@link isGsm7}: the basic alphabet
 * contains LF and CR, and the extension table costs two septets, so neither belongs in a
 * string whose length is being budgeted one septet per character.
 */
function gsm7(text: string): string {
  let out = '';
  for (const char of text) {
    for (const folded of GSM7_FOLDS[char] ?? char) {
      if (isPrintableGsm7Basic(folded)) out += folded;
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Cut at a word boundary where there is one in the back half, hard otherwise. No
 * ellipsis: three more septets to say what a sentence ending mid-word already says. */
function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max / 2 ? cut.slice(0, space) : cut).trimEnd();
}

/**
 * How long the matched calendar occasion lasts, from its own `ends_at`. Only a
 * `family_events` row carries an end; a week-plan item or a row with none is null.
 */
export async function matchedDurationMinutes(
  database: Database,
  familyId: string,
  ref: CorrelatedEventRef | null,
): Promise<number | null> {
  if (ref === null || ref.table !== 'family_events') return null;
  const [row] = await database
    .select({ startsAt: schema.familyEvents.startsAt, endsAt: schema.familyEvents.endsAt })
    .from(schema.familyEvents)
    .where(
      and(
        eq(schema.familyEvents.id, ref.id),
        eq(schema.familyEvents.familyId, familyId),
        householdFamilyEvent(),
      ),
    )
    .limit(1);
  if (!row?.endsAt) return null;
  const minutes = Math.round((row.endsAt.getTime() - row.startsAt.getTime()) / 60_000);
  return minutes > 0 ? minutes : null;
}
