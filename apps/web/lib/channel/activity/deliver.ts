import type { Database } from '@hale/db';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { withOptOut } from '~/lib/channel/opt-out';
import type { refuseUnbackedSend } from '~/lib/channel/reconcile/gate';
import type { threadProactiveMessage } from '~/lib/channel/thread';
import type { OptOutForm } from '~/lib/channel/opt-out';
import type { fulfillCommitment } from '~/lib/commitments/ledger';
import {
  ACTIVITY_WATCH_DUE_HOURS,
  type ActivityPromise,
  type ActivityPromiseRecordOutcome,
} from './commitment';
import type { DeepSlot } from './deep';
import type { PageVerdict } from './evidence';
import { statesAFigure, statesNoCost } from './quote-match';
import {
  type FollowUpComposer,
  type FollowUpFallback,
  type FollowUpPick,
  asksTheParent,
  claimsNotPosted,
} from './followup-note';
import { type ActivitySharePage, SLOTS_IN_TEXT, withSharePage } from './share-page';

/**
 * THE ONE PATH A KEPT PROMISE TAKES TO A PHONE.
 *
 * Two things now decide to answer an activity promise: the hourly sweep (sweep.ts), which
 * keeps every promise that has come due, and the question-time deep job (deep-job.ts),
 * which keeps ONE promise minutes after it is made because the parent named a place and
 * the answer is worth opening pages for. They disagree about a great deal — which
 * research runs, what a failure costs, whether to fall back to a snippet search — and
 * they must not disagree about ONE thing: what happens between a set of picks and a
 * parent reading them.
 *
 * That stretch is this module, and it is a single copy on purpose. It holds the two send
 * gates, the share page, the CASL line, the ledger row, the thread append, the fulfilment
 * and the continuation promise — nine steps in a fixed order where seven of them were
 * added because one had gone wrong in production. A second implementation of it would
 * pass its own tests and drift on the eighth: this codebase already ran two parallel
 * classify→review pipelines and learned what that costs.
 *
 * THE ORDER IS THE DESIGN, and two places in it are load-bearing:
 *
 *   THE GATES RUN LAST, on the string that actually leaves. `withSharePage` and
 *   `withOptOut` both append AFTER the composer's own gates have passed, and on
 *   2026-08-22 a question appended past a green gate reached a parent. Everything between
 *   a gate and `transport.send` is unchecked by construction, so nothing may sit there.
 *
 *   THE WATCH IS WRITTEN AFTER THE FULFILMENT. The ledger permits one open promise of a
 *   kind per family, so recording the continuation first would be refused by the partial
 *   unique index and the watch would silently not exist.
 */

/** WHAT THIS FOLLOW-UP ACTUALLY DID TO GET ITS ANSWER — the row an ops reader needs and
 * did not have.
 *
 * Diagnosing the 2026-08-22 message took an hour of live probing because its audit row
 * said `{"picks":2}` and nothing else. Every question that mattered — did the deep pass
 * run, did it open a page, was the page refused, did the search return anything — had no
 * answer anywhere. COUNTS ONLY: never a venue, never a URL, never a subject (rule #1). */
export interface FollowUpEvidence {
  picks: number;
  deepRead: number;
  deepUnread: number;
  pagesRead: number;
  pagesRefused: number;
  searchResults: number;
}

export function noEvidence(): FollowUpEvidence {
  return { picks: 0, deepRead: 0, deepUnread: 0, pagesRead: 0, pagesRefused: 0, searchResults: 0 };
}

/**
 * IS THERE ANYTHING LEFT TO COME BACK FOR?
 *
 * Nothing found at all, or a best find whose day or price the answer could not carry.
 * Those are the two shapes where a parent is left holding half a thing — and they are
 * exactly the two shapes that used to end in "Want me to check back once they're up?",
 * which is Hale asking permission for the work it is going to do anyway.
 *
 * Read off the TOP pick because the top pick is what the text leads with (followup-note.ts
 * `topPickLeads`); a complete second find does not fill the gap in the one the parent
 * actually sees.
 */
export function watchWarranted(picks: readonly FollowUpPick[]): boolean {
  const top = picks[0];
  if (!top) return true;
  return !carriesFact(top.when, 'when') || !carriesFact(top.price, 'price');
}

/**
 * A FIELD THAT EXPLAINS ITS OWN ABSENCE IS AN ABSENCE — AND SO IS ONE WITH NO FACT IN IT.
 *
 * The extract skill says to leave `when` and `price` out when no page carried them, and
 * live on 2026-08-22 the Cartwheels turn did not: it filled `price` with "Not listed on
 * main site; pricing varies by term length and is only visible after logging into the
 * Registration Website" and `when` with a paragraph about a PDF it could not decode.
 * Read as prose those are values; read as facts they are gaps — and a null check alone
 * let the one venue this whole arc is named after come back with nothing to watch for.
 *
 * TWO READINGS, BECAUSE ONE OF THEM MISSES THE POLITE NON-ANSWER. Refusing an absence
 * CLAIM only catches the fields that admit what they are. "Fees set by Council each year,
 * published in the current Recreation Guide" claims nothing and answers nothing: it is a
 * sentence about where a price lives, offered where a price should be. It survived only
 * by accident until 2026-08-24 — the old absence regex matched the "nt" in "current" —
 * and when that bug was fixed Hale started handing it over as a complete find and writing
 * no follow-up, leaving the parent with no price and no promise to get one.
 *
 * So a schedule fact must also CARRY one: a day, a clock time, a date or an amount
 * (quote-match.ts's anchors, the same reading the refutation uses). Erring towards "this
 * is a gap" costs a watch Hale would have kept anyway; erring the other way is a parent
 * told they have the whole answer.
 *
 * EXCEPT THAT FREE IS A PRICE. Measured across the corpus's twenty-six distinct top picks,
 * demanding a figure moved six of them and five were free drop-ins — a complete answer
 * turned into an open question, on one of this product's beachhead subjects. Which field
 * is being read decides whether "free" means anything, so the field says which it is.
 */
function carriesFact(field: string | null, kind: 'when' | 'price'): boolean {
  if (field === null || field.trim() === '' || claimsNotPosted(field)) return false;
  if (kind === 'price' && statesNoCost(field)) return true;
  return statesAFigure(field);
}

/** Who the promise is owed to, and the thread it was made in. */
export interface FollowUpRecipient {
  parentUserId: string;
  /** The conversation the promise was made in, so the answer lands where the question was
   * asked. Null when the carrying message was not threaded. */
  conversationId: string | null;
}

/** The effects a delivery performs. Every one is REQUIRED (rule #11): a sender that could
 * be wired without a transport, without a ledger writer or without the reconciliation gate
 * is a sender that can close a promise having sent nothing, and look identical doing it. */
export interface FollowUpDelivery {
  composer: FollowUpComposer;
  sharePage(
    database: Database,
    input: { familyId: string; slots: readonly DeepSlot[] },
  ): Promise<ActivitySharePage>;
  refuseUnbackedSend: typeof refuseUnbackedSend;
  resolveSendablePhone(database: Database, parentUserId: string): Promise<string | null>;
  transport: ChannelTransport;
  recordSend(
    database: Database,
    write: {
      familyId: string;
      parentUserId: string;
      templateKey: string;
      dedupeKey: string;
      providerMessageId: string;
      relatedConversationId: string | null;
      sentAt: Date;
    },
  ): Promise<string>;
  audit(database: Database, row: Record<string, unknown>): Promise<void>;
  threadMessage: typeof threadProactiveMessage;
  fulfillCommitment: typeof fulfillCommitment;
  recordWatch(
    database: Database,
    input: {
      familyId: string;
      promise: ActivityPromise;
      channelMessageId: string | null;
      dueInHours: number;
      now: Date;
    },
  ): Promise<ActivityPromiseRecordOutcome>;
}

export interface FollowUpDeliveryInput {
  commitmentId: string;
  familyId: string;
  subjectChildId: string | null;
  /** The de-identified subject the promise was about — what the message is grounded on. */
  subject: string;
  recipient: FollowUpRecipient;
  /** The dedupe key the send is claimed under. The two callers derive it the SAME way
   * (`activity_followup:<commitment id>`) so a question-time send and an hourly tick can
   * never both reach a parent about one promise. */
  dedupeKey: string;
  /** The CASL form this send carries, decided by the outbound gate. */
  optOut: OptOutForm;
  /** What goes in the TEXT — at most {@link SLOTS_IN_TEXT}. */
  picks: readonly FollowUpPick[];
  /** Everything found, including what the text cannot carry. A share page is minted only
   * when this is longer than the text can hold. */
  rest: readonly DeepSlot[];
  /** What the pages actually read license this message to say about what a page does NOT
   * carry (evidence.ts `PageVerdict`). Never inferred from how many facts survived the
   * refutation - see `FollowUpGrounding.pageEvidence`. */
  pageEvidence: PageVerdict;
  evidence: FollowUpEvidence;
}

/** What became of one delivery. Named rather than void, and never folded: `deferred` is
 * the model failing to write a sendable sentence, `refused_at_send` is CODE having put an
 * unbacked claim or a question into a body the gates had already passed, and a run with a
 * non-zero second number has a bug in the append path (rule #11). */
export type FollowUpDeliveryOutcome =
  | {
      status: 'sent';
      channelMessageId: string;
      /** The search ran and there was nothing. Still sent, still kept. */
      emptyHanded: boolean;
      /** A link to the rest of the schedule was appended. */
      shared: boolean;
      /** The message says Hale is still watching. */
      watch: boolean;
      /** The continuation row behind that sentence: true written, false NOT written (the
       * worst outcome this path has), null when no watch was claimed. */
      watchRecorded: boolean | null;
    }
  | { status: 'deferred'; reason: FollowUpFallback }
  | { status: 'refused_at_send'; reasons: readonly string[] };

/**
 * Compose the message, gate it, send it, and close the promise against the row that
 * carried it.
 *
 * A `deferred` or `refused_at_send` outcome leaves the promise OPEN, deliberately and in
 * both cases: the next tick composes a whole message, and a canned sentence in its place
 * would be Hale saying something nobody wrote for this family.
 */
export async function deliverFollowUp(
  database: Database,
  deps: FollowUpDelivery,
  input: FollowUpDeliveryInput,
  now: Date,
): Promise<FollowUpDeliveryOutcome> {
  // THE OFFER IS A PROPOSAL, AND A PROPOSAL IS A ROW — decided HERE, before a word is
  // composed, because the composer's gates read it. `watch` is what the message is
  // allowed to say and what the ledger is about to be told, and they are one value so
  // they cannot disagree (#521, and the 2026-08-22 repeat of it through this door).
  const watch = watchWarranted(input.picks);
  const composed = await deps.composer.compose({
    subject: input.subject,
    picks: input.picks,
    pageEvidence: input.pageEvidence,
    watch,
  });
  if (composed.status === 'deferred') {
    console.error(
      { commitmentId: input.commitmentId, reason: composed.reason },
      'activity follow-up: nothing sendable composed - promise left open for the next tick',
    );
    return { status: 'deferred', reason: composed.reason };
  }

  const to = await deps.resolveSendablePhone(database, input.recipient.parentUserId);
  if (!to) {
    // The gate just said this parent has a live channel, so there IS one — a missing
    // number here is a contradiction, not a state to paper over.
    throw new Error(
      `activity follow-up: no send target for parent ${input.recipient.parentUserId}`,
    );
  }

  // THE REST OF THE SCHEDULE, on a page. Minted only when more slots were read than two
  // segments of SMS can hold — a follow-up that already said everything it found needs no
  // link, and a link to a page repeating the text is noise.
  //
  // The link is appended by CODE, after the composer's gates have passed on the sentence.
  // That is deliberate: `followUpViolations` refuses any message containing a URL, and
  // that gate is right — a model that may write links will eventually write a wrong one.
  // So the model never sees a URL, and the one link Hale sends is built from a token this
  // process just minted (share-page.ts `withSharePage`, the same shape as `withOptOut`).
  let message = composed.message;
  let shared = false;
  if (input.rest.length > SLOTS_IN_TEXT) {
    const page = await deps.sharePage(database, {
      familyId: input.familyId,
      slots: input.rest,
    });
    if (page.status === 'minted') {
      message = withSharePage(message, page.url);
      shared = true;
    }
  }

  const body = withOptOut(message, input.optOut);
  // THE GATE, RE-READ ON THE STRING THAT ACTUALLY LEAVES — and it must stay the last
  // thing before the send, because everything between it and `transport.send` is
  // unchecked by construction. `followUpViolations` refuses a question in the sentence
  // the MODEL wrote, and then two appends run after it; a mutation that added "Want me
  // to check back once they're up?" here survived all 193 tests of this lane. A question
  // on the wire has no row behind it, so the parent's yes lands on whatever the router
  // guesses next (2026-08-22). Refused rather than trimmed: the promise stays open and
  // the next tick composes a whole message.
  if (asksTheParent(body)) {
    console.error(
      { commitmentId: input.commitmentId },
      'activity follow-up: the wire body asks the parent a question - refused at the send boundary, promise left open',
    );
    return { status: 'refused_at_send', reasons: ['asks_the_parent'] };
  }
  // THE SECOND HALF OF THE SAME BOUNDARY (VIL-293). The gate above asks whether the wire
  // body asks anything; this asks whether it CLAIMS anything — a booking with nothing on
  // the calendar, a registration watch nothing is watching, a promise about Hale's own
  // behaviour. The composer's own grounding gates cover the claim this lane is most
  // likely to invent ("I'll keep looking" with `watch: false`, followup-note.ts); these
  // are the three it has no opinion about.
  const unbacked = await deps.refuseUnbackedSend(database, {
    familyId: input.familyId,
    body,
    now,
  });
  if (unbacked.length > 0) {
    console.error(
      { commitmentId: input.commitmentId, reasons: unbacked },
      'activity follow-up: the wire body claims a row that does not exist - refused at the send boundary, promise left open',
    );
    return { status: 'refused_at_send', reasons: unbacked };
  }

  const { providerMessageId } = await deps.transport.send({ to, body });
  const channelMessageId = await deps.recordSend(database, {
    familyId: input.familyId,
    parentUserId: input.recipient.parentUserId,
    templateKey: 'activity_followup:kept',
    dedupeKey: input.dedupeKey,
    providerMessageId,
    relatedConversationId: input.recipient.conversationId,
    sentAt: now,
  });
  await deps.audit(database, {
    familyId: input.familyId,
    actor: 'system',
    actionTaken: 'activity_followup_sent',
    targetTable: 'channel_messages',
    targetId: channelMessageId,
    // COUNTS, never the finds themselves: an audit row is read by ops and by a
    // right-to-access export, and neither needs the venue names (rule #1). What it DOES
    // need is what this follow-up did to get its answer — see FollowUpEvidence.
    after: { ...input.evidence, watch },
  });
  // Threaded so the parent's answer arrives as an ordinary coach turn with the finds in
  // front of it. The COMPOSED sentence, not the wire body: the CASL line belongs on the
  // wire and nowhere else (plan check-in keeps the same rule, for the same reason).
  await deps.threadMessage(database, {
    familyId: input.familyId,
    parentUserId: input.recipient.parentUserId,
    body: message,
  });
  // KEPT, against the message that kept it — including when the message was bad news. The
  // promise was to come back.
  await deps.fulfillCommitment(database, {
    familyId: input.familyId,
    kind: 'activity_followup',
    channelMessageId,
    now,
  });

  const sent = {
    status: 'sent' as const,
    channelMessageId,
    emptyHanded: input.picks.length === 0,
    shared,
    watch,
  };
  if (!watch) return { ...sent, watchRecorded: null };

  // THE CONTINUATION, minted against the message that carried the sentence — the same
  // send-time discipline the coach's own promise keeps, and AFTER the fulfilment above
  // because the ledger permits one open promise of a kind per family.
  //
  // It never throws. The parent already has the text, so an exception here would buy a
  // carrier retry and a duplicate send — the failure is a COUNT instead, because a
  // message that says Hale is still watching with no row behind it is the exact defect
  // this whole change is about.
  const recorded = await deps.recordWatch(database, {
    familyId: input.familyId,
    promise: { subject: input.subject, childId: input.subjectChildId },
    channelMessageId,
    dueInHours: ACTIVITY_WATCH_DUE_HOURS,
    now,
  });
  if (recorded.status === 'recorded') return { ...sent, watchRecorded: true };
  console.error(
    { commitmentId: input.commitmentId, reason: recorded.reason },
    'activity follow-up: the parent was told Hale is still watching and no row was written',
  );
  return { ...sent, watchRecorded: false };
}
