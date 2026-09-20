import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { f14EnabledFor } from '~/lib/channel/f14';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { acceptedStatus, dedupeActive } from '~/lib/channel/ledger';
import { withOptOut } from '~/lib/channel/opt-out';
import type {
  ProactiveHoldReason,
  ProactiveSendRequest,
  ProactiveSendVerdict,
} from '~/lib/channel/outbound-gate';
import { isPrintableGsm7Basic } from '~/lib/channel/sms-segments';
import type { threadProactiveMessage } from '~/lib/channel/thread';
import { TwilioSendError } from '~/lib/channel/twilio/transport';
import { formatDayHeading } from '~/lib/format/datetime';
import type {
  CorrelatedEventRef,
  ExtractedEvent,
  ExtractionKind,
  InboxEnvelope,
  SentinelClassification,
} from '~/lib/sentinel';
import { bookedDetectionEnabledFor } from './booked';
import { type EmailAlertOfferDraft, recordEmailAlertOffer } from './email-alert-offer';

/**
 * A parenting email in a connected Gmail becomes ONE text to the parent.
 *
 * The two halves this joins have both existed for a while and never met: the connector
 * sweep reads envelopes and enqueues them as drafts on a web page nobody opens, and the
 * E2 sentinel can tell a cancelled swim class from a newsletter but had no production
 * caller at all. This module is the join, and it is deliberately the only thing between
 * them — the classifier's verdict decides WHETHER, the outbound chokepoint decides
 * whether Hale may speak right now, and the sentence itself is assembled from the typed
 * extraction by the code below rather than by a second model call (rule #2).
 *
 * WHAT IT MAY NOT DO, and the reasons are not stylistic:
 *   - The SMS carries no line of the email. The snippet, the quote evidence and the body
 *     never reach a wire body or an audit row (rule #1); what goes out is the extraction's
 *     own title, the sender's display name or bare domain, and a time.
 *   - A 13+ child's mail is category-only. The pipeline has already genericized the title
 *     by the time this sees it, and {@link renderEmailAlert} additionally drops the
 *     sender and the time, because a therapist's domain and a Thursday 4pm are the
 *     disclosure, not the title.
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
  'already_sent',
  'dark',
  'no_parent_user',
  'seeding_run',
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
] as const;

export type EmailAlertOutcome = (typeof EMAIL_ALERT_OUTCOMES)[number];

export type EmailAlertCounts = Record<EmailAlertOutcome, number>;

export function emptyEmailAlertCounts(): EmailAlertCounts {
  return Object.fromEntries(EMAIL_ALERT_OUTCOMES.map((o) => [o, 0])) as EmailAlertCounts;
}

/** At most this many messages per connection per sweep reach the classifier, newest
 * first. A 15-minute cron over a mailbox that just received a hundred messages is the
 * shape this bounds: the cap on what may be SENT is the outbound gate's, and this is the
 * cap on what may be SPENT — ten model calls, not a hundred. */
export const EMAIL_ALERT_MAX_PER_SWEEP = 10;

export const EMAIL_ALERT_TEMPLATE_KEY = 'connector:email_alert';

/** Which suppression the ledger records, per hold — dispatch.ts's four statuses, chosen
 * by the gate's four reasons. */
const HOLD_STATUS: Record<
  ProactiveHoldReason,
  'suppressed_quiet_hours' | 'suppressed_cap' | 'suppressed_consent'
> = {
  quiet_hours: 'suppressed_quiet_hours',
  frequency_cap: 'suppressed_cap',
  not_enrolled: 'suppressed_consent',
  no_watch_consent: 'suppressed_consent',
};

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
  timeZone: string;
  now: Date;
}

export async function alertParentForEmail(
  database: Database,
  input: EmailAlertInput,
  ports: EmailAlertPorts,
): Promise<EmailAlertOutcome> {
  const { familyId, parentUserId, integrationId, messageId, now } = input;
  if (!f14EnabledFor(familyId)) return 'dark';

  const dedupeKey = emailAlertDedupeKey(integrationId, messageId);
  // Read BEFORE the classifier, not only via the claim below: a re-fired sweep over a
  // mailbox it has already read must cost nothing, and the claim happens after two model
  // calls have already been paid for.
  if (await dedupeActive(dedupeKey, database)) return 'already_sent';

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
    return 'classifier_failed';
  }

  const extraction = classification.extraction;
  if (classification.status !== 'classified' || extraction === null) return 'not_parenting';

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
      status: HOLD_STATUS[verdict.reason],
    });
    console.warn({ familyId, reason: verdict.reason }, 'email alert: held by the outbound gate');
    return `gate_refused:${verdict.reason}`;
  }

  // ONE read of the flag per envelope, threaded into both calls below rather than read
  // twice: the sentence and the row it promises must be built from the same answer.
  const booked = bookedDetectionEnabledFor(familyId);
  const message = renderEmailAlert({
    from: input.envelope.from,
    kind: extraction.kind,
    event: extraction.event,
    teenContent: extraction.teenContent,
    matchedEventRef: extraction.matchedEventRef,
    booked,
    timeZone: input.timeZone,
    now,
  });
  // The same pure decision the sentence above just made. Two calls of one function rather
  // than a flag threaded between them: the CTA and the row it promises cannot disagree.
  const offer = emailAlertOfferDraft({
    kind: extraction.kind,
    event: extraction.event,
    teenContent: extraction.teenContent,
    matchedEventRef: extraction.matchedEventRef,
    booked,
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
  if (!claimed) return 'already_sent';

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
    return 'no_send_target';
  }

  let providerMessageId: string;
  try {
    ({ providerMessageId } = await ports.transport.send({
      to,
      body: withOptOut(message, verdict.optOut),
    }));
  } catch (err) {
    const code = err instanceof TwilioSendError ? err.code : 'unknown';
    await database
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: code })
      .where(eq(schema.channelMessages.id, claimed.id));
    console.error({ familyId, code }, 'email alert: the provider refused the text');
    return 'send_failed';
  }

  await database
    .update(schema.channelMessages)
    .set({ providerMessageId })
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

  // The composed sentence, not the wire body — the CASL line belongs on the wire, and
  // the coach re-reads this row next turn (channel/thread.ts).
  await ports.threadMessage(database, { familyId, parentUserId, body: message });

  await database.insert(schema.auditLog).values({
    familyId,
    actor: 'system',
    actionTaken: 'email_alert_sent',
    targetTable: 'channel_messages',
    targetId: claimed.id,
    // Enums and flags only. Not the title, not the sender, not the subject: an audit row
    // a support agent can read is a copy of the email in a table that is never redacted.
    after: { kind: extraction.kind, teenContent: extraction.teenContent },
  });

  return 'sent';
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
  envelopes: readonly GmailAlertEnvelope[];
  now: Date;
}

/**
 * One sweep's worth of Gmail envelopes for one connection → one outcome per envelope.
 *
 * Newest first and bounded, because the interesting failure is not a quiet mailbox: it is
 * a mailbox that just received sixty messages, where the ones worth a text are the ones
 * that arrived last and the cost of reading all of them is sixty model calls.
 */
export async function alertParentForGmailSweep(
  database: Database,
  input: GmailSweepAlertInput,
  ports: EmailAlertPorts,
): Promise<readonly EmailAlertOutcome[]> {
  const { parentUserId, envelopes } = input;
  if (parentUserId === null) return envelopes.map(() => 'no_parent_user');
  if (input.seeding) return envelopes.map(() => 'seeding_run');

  const outcomes: EmailAlertOutcome[] = [];
  const dated: Array<GmailAlertEnvelope & { receivedAt: string }> = [];
  for (const envelope of envelopes) {
    if (envelope.receivedAt === undefined) outcomes.push('no_received_at');
    else dated.push({ ...envelope, receivedAt: envelope.receivedAt });
  }
  dated.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  for (let i = EMAIL_ALERT_MAX_PER_SWEEP; i < dated.length; i += 1) outcomes.push('over_sweep_cap');

  const considered = dated.slice(0, EMAIL_ALERT_MAX_PER_SWEEP);
  if (considered.length === 0) return outcomes;

  const timeZone = await ports.timeZone(parentUserId);
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
          timeZone,
          now: input.now,
        },
        ports,
      ),
    );
  }
  return outcomes;
}

// ── The sentence ─────────────────────────────────────────────────────────────

export interface EmailAlertRenderInput {
  from: string;
  kind: ExtractionKind;
  event: ExtractedEvent;
  teenContent: boolean;
  /** The family occasion this email already matched, or null. It decides whether the text
   * may END with an offer — see {@link emailAlertOfferDraft}. */
  matchedEventRef: CorrelatedEventRef | null;
  /** Whether BOOKED DETECTION is armed for this family (lib/integrations/booked.ts).
   * Dark, a `booking_confirmation` is rendered and offered as a `new_event` in every
   * respect — see {@link effectiveKind}. */
  booked: boolean;
  timeZone: string;
  now: Date;
}

/**
 * THE KIND THE SENTENCE AND THE OFFER ARE BUILT FROM.
 *
 * One subtraction rather than three gates. Dark, `booking_confirmation` simply IS
 * `new_event` here: it picks the same frame, the same CTA, the same generic title and
 * the same offered instant, so the flag-off body is byte-identical to what that email
 * produces today by construction rather than by three branches that have to agree. The
 * kind itself never changes — it stays in `EXTRACTION_KINDS` in both states, because a
 * flag that changed what the model may return would re-key the eval cache on every flip.
 */
function effectiveKind(kind: ExtractionKind, booked: boolean): ExtractionKind {
  return kind === 'booking_confirmation' && !booked ? 'new_event' : kind;
}

/** The clamps that keep the composed body inside TWO GSM-7 segments once the full
 * opt-out paragraph is appended (the conservative bound — the short form is cheaper).
 * Nothing else in the message is variable-length, so these are what make that arithmetic
 * a fact rather than a hope; the property test in this module's suite is the proof. */
const SENDER_MAX = 40;
const TITLE_MAX = 60;
const LOCATION_MAX = 30;
const TEEN_CLOSER = "I've kept the details out of this text.";

/** `Reminder:`, `CANCELLED -`, `New:` — the label a vendor files its own subject line
 * under. Hale's sentence already says who and what happened, so relaying the label says it
 * a second time in someone else's voice. Only a label followed by a colon or a dash: the
 * words are ordinary English otherwise ("New time for swim class" is the title). */
const VENDOR_LABEL =
  /^(?:reminder|cancell?ed|rescheduled|postponed|new|update|updated|notice|fyi)\s*[:\-]\s*/i;

/** The full stop that ends someone else's line and lands in the middle of Hale's — a
 * subject line's ("Picture Day." on Friday) and a display name's alike ("Riverside Pool."
 * as the subject of a sentence). */
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
 * this function is the single decision both it and the sentence are derived from.
 *
 * FIVE CONDITIONS, and each one is a way the sentence would otherwise be untrue:
 *   · A 13+ child's mail is genericised by the time this sees it, so there is no occasion
 *     left to add and nothing that could be added without re-disclosing what the teen
 *     gate just removed (rule #1). No row, and — since the teen text is category-only —
 *     no sentence either.
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
 *
 * Everything else ends with today's sentence, and that is still the common case.
 */
export function emailAlertOfferDraft(input: {
  kind: ExtractionKind;
  event: ExtractedEvent;
  teenContent: boolean;
  matchedEventRef: CorrelatedEventRef | null;
  booked: boolean;
  now: Date;
}): EmailAlertOfferDraft | null {
  if (input.teenContent || input.matchedEventRef !== null) return null;
  const kind = effectiveKind(input.kind, input.booked);
  const startsAt = instant(OFFERED_TIME[kind](input.event));
  if (startsAt === null || startsAt.getTime() <= input.now.getTime()) return null;
  const title = sanitizedTitle(input.event.title);
  if (title === '') return null;
  // The extraction's own place, folded and clamped like everything else this file keeps:
  // the row's strings reach a wire later, in a reminder. Unlike {@link venue}, a digit is
  // allowed — a room number on your own calendar is the useful half of an address, and
  // that rule is about what goes out in a text, not about what the family holds.
  const place = clamp(gsm7(input.event.location ?? ''), TITLE_MAX);
  // The EFFECTIVE kind on the row too, so a dark booking is a `new_event` offer in the
  // ledger exactly as it is on the wire — and so a lit one is the thing `stampBookingEvent`
  // can recognise when the parent says yes.
  return { kind, title, startsAt, location: place === '' ? null : place };
}

/** WHICH time field is the occasion, per kind. A move's destination, a new date's date,
 * and the stated time of something the parent already has — the same choice the sentence
 * itself makes when it decides which instant to name. */
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

/** The sentence the offer prints, and it is printed if and only if a row will exist to
 * keep it. English only: an alert is outbound-first and there is no inbound body to read
 * a language off (`replyLanguage` takes one), and `families.primary_language` is a column
 * nothing in this product reads yet. The REPLIES to this sentence do have a French twin,
 * because by then the parent has written (email-alert-offer.ts). */
const OFFER_CTA = 'Reply YES and it goes on your week.';

/**
 * The booking's own ending. A receipt has already told the parent they are in, so
 * "Reply YES and it goes on your week" would answer a question they did not ask; what is
 * genuinely open is the calendar.
 *
 * IT CLEARS THE CLAIM TAXONOMY, and that is checked rather than assumed:
 * `SCHEDULED_ASSERTION` (channel/reconcile/claims.ts) matches `is/are/'s/'re on your
 * calendar` — a copula immediately before the phrase — and this sentence has none. The
 * email-alert path does not run `refuseUnbackedSend`, so this is a copy discipline the
 * module's suite pins rather than a gate that would catch it.
 */
const BOOKING_CTA = 'Want it on your calendar?';

/**
 * WHICH ENDING, per kind — and the reason this is a Record and not a constant.
 *
 * `renderEmailAlert` appends a CTA if and only if `emailAlertOfferDraft` returned a
 * draft, which is exactly when a row will be written. That single line is what stops a
 * question ever being asked with nothing behind it (#649), so the booking's question
 * lives HERE and never inside `compose`: a frame that carried it would ask it in every
 * draft-null case, and after the correlation fix the most common such case is precisely
 * the booking for a class the family already holds.
 */
const CTA: Record<ExtractionKind, string> = {
  cancellation: OFFER_CTA,
  reschedule: OFFER_CTA,
  new_event: OFFER_CTA,
  reminder_only: OFFER_CTA,
  unclear: OFFER_CTA,
  booking_confirmation: BOOKING_CTA,
};

/** What the sentence says when it has nothing specific, per kind — the fallback when a
 * vendor title survives sanitising as nothing at all (a subject line entirely outside the
 * Latin alphabet). Hale's own words, so the message is still true, and each one is
 * written to read as the OBJECT of its kind's frame ("... has a new date on Friday"). */
const GENERIC_TITLE: Record<ExtractionKind, string> = {
  cancellation: 'something was cancelled',
  reschedule: 'something moved',
  new_event: 'a new date',
  reminder_only: 'there is something coming up',
  unclear: 'a possible schedule change',
  // A lowercase noun phrase, not the pipeline's standalone sentence of the same name:
  // this one is written to read as the OBJECT of its frame — "Riverside Pool says you're
  // in for a spot - first one Saturday, Sep 26 at 9:00 a.m."
  booking_confirmation: 'a spot',
};

/**
 * The text, assembled from the typed extraction and nothing else.
 *
 * Deterministic on purpose (rule #2): there is no prompt here and no second model call.
 * The extraction already decided what this email says; a composer would only give it a
 * chance to say something the email did not.
 *
 * The SENDER IS THE SUBJECT of a plain sentence and the time is a clause of it, because
 * that is how a person relays a message: "Riverside Pool cancelled Saturday swim class -
 * it was Saturday, Sep 19 at 9:00 a.m." No label in front of it, no dash standing in for
 * a verb, and no offer at the end (see above).
 */
export function renderEmailAlert(input: EmailAlertRenderInput): string {
  const title = sanitizedTitle(input.event.title);
  const kind = effectiveKind(input.kind, input.booked);

  if (input.teenContent) {
    // Category only. The pipeline has already replaced the title with its own generic
    // line; dropping the sender and the time is this renderer's half of the same rule,
    // because who wrote and when are the disclosure a 13+ child is owed protection from.
    return `${title || GENERIC_TITLE[kind]}. ${TEEN_CLOSER}`;
  }

  const body = compose(
    input,
    kind,
    clamp(gsm7(senderLabel(input.from)), SENDER_MAX).replace(TRAILING_PUNCTUATION, ''),
    title || GENERIC_TITLE[kind],
  );
  // The offer, decided by the one function that also decides whether the row gets
  // written. Appended AFTER `compose`, never inside it: every frame in there ends through
  // `end()`, and a clause spliced before that would put Hale's own offer inside the
  // vendor's sentence. The ENDING is per kind (see {@link CTA}) and the condition is not:
  // a question is asked if and only if a row will exist to keep it.
  return emailAlertOfferDraft(input) === null ? body : `${body} ${CTA[kind]}`;
}

/**
 * The vendor's own filing label off the front and its punctuation off the back, because
 * every frame supplies the sentence's own subject and its own ending: "YRDSB says
 * Reminder: the form is due" says the kind of thing twice, and "Picture Day. on Friday"
 * is what a subject line's full stop reads as inside a clause.
 *
 * ONE function, two readers — the sentence and the row it offers to write. A second copy
 * of this fold would be a week entry titled differently from the text that offered it.
 */
function sanitizedTitle(raw: string): string {
  return clamp(gsm7(raw).replace(VENDOR_LABEL, ''), TITLE_MAX).replace(TRAILING_PUNCTUATION, '');
}

/** One sentence per kind, and they are all the same sentence: who, what, when. */
function compose(
  input: EmailAlertRenderInput,
  kind: ExtractionKind,
  sender: string,
  title: string,
): string {
  const { event, timeZone, now } = input;
  const at = (iso: string | null): string | null => longWhen(iso, timeZone, now);

  switch (kind) {
    case 'cancellation': {
      const { text: head } = changeHead(sender, title, CHANGE.cancellation);
      const was = at(event.originalTime);
      return end(was === null ? head : `${head} - it was ${was}`);
    }
    case 'reschedule': {
      const { text: head, relayed } = changeHead(sender, title, CHANGE.reschedule);
      const to = at(event.newTime);
      if (to === null) {
        const was = at(event.originalTime);
        return end(was === null ? head : `${head} - it was ${was}`);
      }
      // The destination hangs off Hale's own verb when Hale supplied it, and off a dash
      // when the head is the vendor's sentence — "moved Practice to Saturday" against
      // "says Practice moved to 5pm - now Saturday", never the two spliced into one.
      const destination = relayed ? `${head} - now ${to}` : `${head} to ${to}`;
      // The old date as a bare parenthetical: a parent scanning this needs to recognise
      // WHICH occasion moved, and that is the date, not the hour it used to start at.
      const from = shortDate(event.originalTime, timeZone, now);
      return end(from === null ? destination : `${destination} (was ${from})`);
    }
    case 'new_event':
    case 'reminder_only': {
      // One frame for both, because the only difference between them is WHICH time the
      // extraction put the date in: a date the parent did not have, or one they did.
      // "Fall registration is open" is a sentence already and nothing HAS a sentence, so a
      // title carrying a verb is relayed under "says" — Ollie's own frame for that line —
      // with its time as a dash clause; a noun phrase takes Hale's verb and an "on", never
      // a dash standing in for the verb ("says Pediatric checkup - Saturday").
      const relayed = VERBISH.test(title);
      const head = sender === '' ? title : `${sender} ${relayed ? 'says' : 'has'} ${title}`;
      const on = at(kind === 'new_event' ? event.newTime : event.originalTime);
      const place = kind === 'new_event' ? venue(event.location) : '';
      const when = on === null ? '' : relayed ? ` - ${on}` : ` on ${on}`;
      return end(`${head}${place}${when}`);
    }
    case 'booking_confirmation': {
      // THE PROVIDER IS THE SUBJECT, as in every other frame here, and that is what keeps
      // Hale from asserting a thing it did not see: the receipt says the family is in, so
      // the sentence says the receipt says it. "you're in" clears SCHEDULED_ASSERTION
      // where "you're registered" and "is confirmed" do not (claims.ts).
      //
      // IT ENDS WITH A PERIOD AND CONTAINS NO QUESTION. The question is the CTA, appended
      // one level up and only when a row will exist behind it.
      //
      // The title is relayed flat — no "says X is open" grammar to weld onto — because a
      // confirmation's title is the CLASS ("Swim Level 2"), not a sentence about it.
      const head = sender === '' ? title : `${sender} says you're in for ${title}`;
      const first = at(event.newTime);
      if (first === null) return end(head);
      // The place LAST, after the instant, unlike the new_event frame: what a parent
      // reading a receipt needs first is which session is the first one.
      return end(`${head} - first one ${first}${venue(event.location)}`);
    }
    case 'unclear':
      return end(
        sender === '' ? `Something about ${title}` : `${sender} sent something about ${title}`,
      );
  }
}

/**
 * THE ONE QUESTION. Does the title already carry a verb — a finite verb or a change word,
 * anywhere in it?
 *
 * Every frame in this file hangs off that single answer, and it is one regex rather than a
 * test per frame because the alternative was found twice in review: a copula-only test
 * ("is"/"are") let "Term 1 registration opens Monday" through as a noun phrase, and a
 * past-tense-only test ("moved") let "Practice moves to 5pm" through, each producing the
 * sentence with two verbs or two destinations that the frames exist to prevent. Naming the
 * next inflection would have been the third fix of the same bug.
 *
 * Deliberately broad, because the two sides are not symmetric: relaying a noun phrase under
 * "says" reads a little flat, while treating a sentence as a noun phrase welds Hale's
 * grammar onto the vendor's. Erring towards "it has a verb" is the cheap side.
 */
const VERBISH =
  /\b(?:is|are|was|were|has|have|will|opens?|starts?|begins?|returns?|resumes?|ends?|mov(?:e|es|ed|ing)|cancell?(?:s|ed|ing)?|cancellation|called off|reschedul\w*|postpon\w*|new time)\b/i;

/** `9:00 a.m.` already ends the sentence; a second period is the kind of thing nobody
 * notices in review and everybody notices on a phone. */
function end(sentence: string): string {
  return sentence.endsWith('.') ? sentence : `${sentence}.`;
}

/** The words a vendor subject line has usually already said, per kind that has a verb. */
interface ChangeWords {
  /** What Hale says when the title has NOT said it. */
  verb: string;
  /** The word as a tail the vendor tacked on — `... - CANCELLED`, `... is now cancelled`. */
  tail: RegExp;
}

/** `... - CANCELLED`, `... is now cancelled`, `... is moving` — the change word at the very
 * end of the title, with however much auxiliary the vendor put in front of it. The two
 * auxiliary slots are optional AND independent: one combined group took `is cancelled` and
 * `now cancelled` but left the `is` of `is now cancelled` behind as the occasion Hale then
 * named ("cancelled Swim class is"). */
function changeTail(word: string): RegExp {
  return new RegExp(
    `[\\s\\-:,]*(?:\\b(?:is|are|was|were|has been|have been|will be)\\s+)?(?:\\bnow\\s+)?\\b(?:${word})\\b$`,
    'i',
  );
}

/**
 * WHY THE TITLE IS INSPECTED AT ALL.
 *
 * `extract-child-event.md`'s contract for `title` is the bare `"title": string` — nothing
 * says it names the occasion rather than the change — and the shipped fixtures settle it
 * the other way: `'Swim Class - CANCELLED'`, `'Soccer practice moved'`
 * (lib/sentinel/correlate.test.ts). A frame that always supplies the verb would write
 * "cancelled Swim Class - CANCELLED", and a frame that never supplies one would fail to
 * say what happened at all for the titles that are just `'Swim lessons'`.
 *
 * So: take a TRAILING change word off and say it in Hale's own voice; where the word is
 * embedded and cannot be removed cleanly ("Cancellation of Tuesday practice"), relay the
 * title under "says" and add no second verb — only, for a reschedule, the new time as its
 * own clause. Hale never states the change twice, and never rewrites the middle of a
 * sentence the school wrote.
 *
 * What counts as "embedded" is {@link VERBISH} — the same one question every other frame
 * here asks, rather than a per-kind list of change words, which is what caught 'moved' and
 * let 'moves' through.
 */
const CHANGE: Record<'cancellation' | 'reschedule', ChangeWords> = {
  cancellation: {
    verb: 'cancelled',
    tail: changeTail('cancell?ed|cancellation'),
  },
  reschedule: {
    verb: 'moved',
    tail: changeTail('mov(?:ed|es|ing)|reschedul(?:ed|es|ing)|postpon(?:ed|es|ing)'),
  },
};

/** A title that is ONLY the change word ('CANCELLED') leaves no occasion to name. Under
 * "says" it would put a vendor's shout in Hale's mouth, so the frame keeps its own verb
 * and takes Hale's own object instead. */
const GENERIC_OCCASION = 'something';

interface Head {
  text: string;
  /** True when the title was RELAYED whole under "says" — the change word is inside it, so
   * the head is the VENDOR's sentence and a clause welded straight onto it continues
   * someone else's grammar ("says Practice moved to 5pm to Saturday, Sep 26"). */
  relayed: boolean;
}

function changeHead(sender: string, title: string, words: ChangeWords): Head {
  const occasion = title.replace(words.tail, '').trim() || GENERIC_OCCASION;
  if (!VERBISH.test(occasion)) {
    return {
      text: sender === '' ? `${occasion} ${words.verb}` : `${sender} ${words.verb} ${occasion}`,
      relayed: false,
    };
  }
  return { text: sender === '' ? title : `${sender} says ${title}`, relayed: true };
}

/** `Saturday, Sep 19 at 9:00 a.m.`, in the parent's zone, with the year on another year's
 * date — the weekday included because a parent reading this on a phone plans against the
 * DAY and should not have to look the date up. Null when the extraction's time field is
 * absent or is not a date: the skill asks for ISO 8601 with an offset, but the field is a
 * model's free text, and "Invalid Date" on a phone is worse than no time at all. */
function longWhen(iso: string | null, timeZone: string, now: Date): string | null {
  const at = instant(iso);
  if (at === null) return null;
  const clock = new Intl.DateTimeFormat('en-CA', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(at);
  return gsm7(`${formatDayHeading(at, timeZone, now)} at ${clock}`);
}

/** `Sep 19` — the reschedule parenthetical, same zone and same other-year rule. */
function shortDate(iso: string | null, timeZone: string, now: Date): string | null {
  const at = instant(iso);
  if (at === null) return null;
  const yearOf = (date: Date): string =>
    new Intl.DateTimeFormat('en-CA', { year: 'numeric', timeZone }).format(date);
  return gsm7(
    new Intl.DateTimeFormat('en-CA', {
      month: 'short',
      day: 'numeric',
      year: yearOf(at) === yearOf(now) ? undefined : 'numeric',
      timeZone,
    }).format(at),
  );
}

function instant(iso: string | null): Date | null {
  if (iso === null) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * ` at the gym` — a short PLACE, and nothing that looks like an address.
 *
 * A street line or a room number is the half of a school email a text should not repeat:
 * the parent has been there, it is the longest thing the extraction returns, and putting
 * it on the wire is what turns an alert into a copy of the message. Any digit is the
 * cheap, honest test for one, and losing a genuine "Studio 2" to it is the right side to
 * err on.
 */
function venue(location: string | null): string {
  if (location === null) return '';
  const place = gsm7(location);
  if (place === '' || place.length > LOCATION_MAX || /\d/.test(place)) return '';
  return ` at ${place}`;
}

/**
 * Who it is from, as a parent would name them: the display name if the header carries
 * one, otherwise the bare domain.
 *
 * NEVER the full address. `registrar.k12@yrdsb.ca` in a text is a mailbox anyone holding
 * the phone can write to, and the domain is the whole of what the parent needs to know
 * who is speaking. Which is why a display name containing '@' is DROPPED rather than
 * trusted: `"noreply@school.ca" <noreply@school.ca>` is the standard header of every
 * school and daycare system that sends from a no-reply box, and reading its display name
 * is reading the address out loud. Any label with an '@' in it falls through to the
 * domain — a rare "Rec @ Markham" losing its flourish is the right side to err on.
 */
function senderLabel(from: string): string {
  const display = /^\s*"?([^"<]*?)"?\s*<[^>]*>\s*$/.exec(from)?.[1]?.trim();
  if (display !== undefined && display !== '' && !display.includes('@')) return display;
  const address = /<([^>]*)>/.exec(from)?.[1] ?? from;
  return address.split('@')[1]?.trim() ?? '';
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
