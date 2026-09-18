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
import type { ExtractedEvent, ExtractionKind, InboxEnvelope, SentinelClassification } from '~/lib/sentinel';

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

  const message = renderEmailAlert({
    from: input.envelope.from,
    kind: extraction.kind,
    event: extraction.event,
    teenContent: extraction.teenContent,
    timeZone: input.timeZone,
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
  timeZone: string;
  now: Date;
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

/**
 * THERE IS NO CALL TO ACTION, and its absence is the design.
 *
 * This message used to end "I can add it to your week - reply YES." Nothing consumed that
 * YES. An email alert registers no open question of any kind — `OpenQuestionKind` has
 * nine members and none of them is this (lib/channel/router/open-questions.ts) — so a
 * parent doing exactly what the text told them to do reached the coach with nothing
 * drafted, or, with one unrelated action pending, APPROVED THAT ONE: consent read against
 * a question it was never given to (rule #4).
 *
 * Wiring it is not a small change, and the reasons are structural rather than budgetary.
 * A resolvable YES needs a row, the row would be an `agent_commitments` one, and that
 * table's `commitment_kind` is a Postgres enum (a migration) under a partial unique index
 * that permits ONE open promise of a kind per family — while `PROACTIVE_CAP.email_alert`
 * allows three alerts a day, so the second and third would be unwritable. The row would
 * also have to carry the title and the ISO instant, which is precisely the email-derived
 * detail this module persists nowhere (the ledger body is NULL, the audit row carries
 * enums only), and `topic` is a closed vocabulary that says so in its own comment.
 *
 * So the message ends on the fact. Ollie closes an item with "You can change or remove it
 * anytime" because Ollie has already put it on the calendar; Hale has not, and a sentence
 * that says otherwise is the one kind of copy this file must never ship.
 */

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
  // The vendor's own filing label off the front and its punctuation off the back, because
  // every frame below supplies the sentence's own subject and its own ending: "YRDSB says
  // Reminder: the form is due" says the kind of thing twice, and "Picture Day. on Friday"
  // is what a subject line's full stop reads as inside a clause.
  const title = clamp(gsm7(input.event.title).replace(VENDOR_LABEL, ''), TITLE_MAX).replace(
    /[.,;:!?]+$/,
    '',
  );

  if (input.teenContent) {
    // Category only. The pipeline has already replaced the title with its own generic
    // line; dropping the sender and the time is this renderer's half of the same rule,
    // because who wrote and when are the disclosure a 13+ child is owed protection from.
    return `${title || GENERIC_TITLE[input.kind]}. ${TEEN_CLOSER}`;
  }

  return compose(
    input,
    clamp(gsm7(senderLabel(input.from)), SENDER_MAX),
    title || GENERIC_TITLE[input.kind],
  );
}

/** One sentence per kind, and they are all the same sentence: who, what, when. */
function compose(input: EmailAlertRenderInput, sender: string, title: string): string {
  const { event, timeZone, now } = input;
  const at = (iso: string | null): string | null => longWhen(iso, timeZone, now);

  switch (input.kind) {
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
    case 'new_event': {
      // "Fall registration is open" is a sentence already, and nothing HAS a sentence.
      // A clause is relayed under "says" — Ollie's own frame for exactly this line — and
      // its time becomes a dash clause rather than an "on" the vendor's verb swallows.
      const clause = CLAUSE.test(title);
      const head = sender === '' ? title : `${sender} ${clause ? 'says' : 'has'} ${title}`;
      const on = at(event.newTime);
      const when = on === null ? '' : clause ? ` - ${on}` : ` on ${on}`;
      return end(`${head}${venue(event.location)}${when}`);
    }
    case 'reminder_only': {
      const head = sender === '' ? title : `${sender} says ${title}`;
      const due = at(event.originalTime);
      return end(due === null ? head : `${head} - ${due}`);
    }
    case 'unclear':
      return end(
        sender === '' ? `Something about ${title}` : `${sender} sent something about ${title}`,
      );
  }
}

/** `9:00 a.m.` already ends the sentence; a second period is the kind of thing nobody
 * notices in review and everybody notices on a phone. */
/** A title that is a whole clause rather than a noun phrase. Crude on purpose: the two
 * copulas are what separate "Fall registration is open" from "Picture day". */
const CLAUSE = /\s(?:is|are)\s/i;

function end(sentence: string): string {
  return sentence.endsWith('.') ? sentence : `${sentence}.`;
}

/** The words a vendor subject line has usually already said, per kind that has a verb. */
interface ChangeWords {
  /** What Hale says when the title has NOT said it. */
  verb: string;
  /** The word as a tail the vendor tacked on — `... - CANCELLED`, `... is cancelled`. */
  tail: RegExp;
  /** The same family of words anywhere at all. */
  anywhere: RegExp;
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
 */
const CHANGE: Record<'cancellation' | 'reschedule', ChangeWords> = {
  cancellation: {
    verb: 'cancelled',
    tail: /[\s\-:,]*(?:\b(?:is|has been|was|now)\s+)?\bcancell?ed\b$/i,
    anywhere: /\bcancell?ed\b|\bcancellation\b|\bcalled off\b/i,
  },
  reschedule: {
    verb: 'moved',
    tail: /[\s\-:,]*(?:\b(?:is|has been|was|now)\s+)?\b(?:moved|rescheduled|postponed)\b$/i,
    anywhere: /\bmoved?\b|\breschedul\w*\b|\bpostponed?\b|\bnew time\b/i,
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
  if (!words.anywhere.test(occasion)) {
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
