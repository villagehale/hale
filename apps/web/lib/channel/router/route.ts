import { type Database, type UnmetIntentLane, schema } from '@hale/db';
import { captureAgentError } from '~/lib/analytics/server-capture';
import { scopedReply } from '~/lib/channel/caregiver/copy';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { acceptedStatus } from '~/lib/channel/ledger';
import type { OffDomainLane } from '~/lib/channel/off-domain/lane';
import type { MedicalReplySource } from '~/lib/channel/off-domain/medical';
import { type FamilyRole, isCaregiverRole } from '~/lib/channel/role-scope';
import type { ChannelMessageReceivedJob } from '~/lib/channel/twilio/inbound';
import { appendMessage, resolveOrCreateNoteConversation } from '~/lib/coach/conversation';
import { channelSmsNoteKey } from '~/lib/coach/note-key';
import type { RateLimiter } from '~/lib/rate-limit/limiter';
import type { ActivityPromise } from '~/lib/channel/activity/commitment';
import type { PlanOffer } from '~/lib/channel/plan/offer';
import { extractStateClaims } from '~/lib/channel/reconcile/claims';
import {
  type ReconcileVerdict,
  type ReconcileView,
  type RegistrationWatchMint,
  reconcile,
  reconcileViolations,
  withoutRefusedClaims,
} from '~/lib/channel/reconcile/reconcile';
import type { ApologyFallback, TurnApology } from './apology';
import {
  type ChannelCoachRuntime,
  type ChannelTurn,
  type ChannelTurnResult,
  draftsFromFailure,
} from './coach-runtime';
import { FLOOD_REPLY, clarifyWhichQuestion, partialFailureReply } from './copy';
import { AGENT_TURN_LIMIT, AGENT_TURN_ROUTE } from './flood';
import { type SmokeAlarmClaim, classifyTurnFailure, considerSmokeAlarm } from './smoke-alarm';
import type { OpenQuestion, OpenQuestionKind, OpenQuestionReader } from './open-questions';
import { type ReplyConfidence, type ReplyResolver, warrantsClarifying } from './resolve';
import type { InboundTurnLedger, TurnFailureReason } from './turn-ledger';

/**
 * VIL-220 · C1 — the inbound router: the consumer of A3's `channel.message.received`.
 *
 * A3 answers "may this number talk to us at all" and writes the ledger row. This module
 * answers the next three questions, and the ORDER it answers them in is the whole
 * design:
 *
 *   1. WHO IS TALKING?   A caregiver is answered with M6's one static line and stops
 *      here. The webhook already refuses to enqueue a non-parent, so this is the second
 *      of two gates — deliberately, because the cost of the pair being wrong is a
 *      household agent answering a babysitter's question about a child (rule #1), and
 *      one gate is one edit away from none.
 *
 *   2. IS THIS A TURN, OR A COMMAND?   The deterministic handlers run FIRST, in order,
 *      and the first one to claim the message ends the turn. This is not an
 *      optimization. "done" is a family fact being filed, "YES 2" is consent to execute
 *      (rule #4), "waitlisted #3" starts a 36-hour clock — none of them may be
 *      paraphrased by a model, and the only way to guarantee that is for the model
 *      never to see them.
 *
 *   3. CAN WE AFFORD TO THINK?   Flood control sits BELOW the handlers, so a parent
 *      whose hour is spent can still approve, decline, and file a "done". Only the
 *      expensive half is held.
 *
 *   4. IS THIS THE FAMILY'S WEEK, OR THE WORLD?   (VIL-273, re-aimed by boundary v3.)
 *      The last question before the expensive one, and the cheapest of the four that
 *      costs a model at all. "How's the weather" has a right answer that no coach turn
 *      improves, and on live-gate day 1 it cost ~42 seconds of one to say nothing. The
 *      off-domain lane answers it in two sentences with no context assembled and no
 *      tools — and answers a symptom with the fixed 811 line instead. It sits HERE
 *      rather than among the handlers because it is not deterministic — it costs a Haiku
 *      call, and a Haiku call must never be what stands between a parent and the word
 *      "yes".
 *
 * Everything the router does after that is bookkeeping it owes the parent: the turn is
 * threaded into their one long-lived conversation (visible in the app's Ask history),
 * every message either way is a `messages` row, every outbound is a ledger row plus an
 * immutable audit row (rule #6), and nothing that fails does so silently.
 *
 * PRIVACY. Bodies are never logged, in any branch — not the parent's message, not
 * Hale's reply, not the number. The log line carries ids and an outcome enum, which is
 * everything X1 needs to count and nothing a log aggregator should not hold (rule #1).
 */

/** The roles a household agent may speak to. A POSITIVE list, mirroring A3's: the
 * legacy `extended`/`service` buckets carry an empty content scope precisely so they
 * fail closed, and a negative check would route them. */
const PARENT_ROLES: ReadonlySet<string> = new Set(['primary_parent', 'co_parent']);

/**
 * Who texted, what they said, and where a reply can go — resolved in ONE read so the
 * router has no queries of its own. `phoneE164` is null unless there is an ACTIVE,
 * verified, non-revoked channel, which is what makes texting a stopped number
 * structurally impossible rather than merely unlikely (CASL, rule #1).
 */
export interface InboundContext {
  body: string;
  role: FamilyRole | null;
  /** Who a caregiver is pointed at (M6's copy), null when it cannot be resolved. */
  primaryParentName: string | null;
  phoneE164: string | null;
}

/**
 * One turn as a deterministic handler sees it — the same shape the coach gets, plus the
 * one thing a handler needs and the agent does not.
 *
 * `phoneE164` is here because a handler is allowed to answer for itself (`reply: null`),
 * and the full-plan handler is the first one that does: a plan is two or three ordered
 * messages, which the router's one-body `reply` contract cannot express. Handing the
 * number down is what stops that handler re-running `resolveSendablePhone` and reaching
 * a DIFFERENT answer than the gate the router already passed one function up. Non-null
 * by construction — the router does not reach the handlers without one.
 */
export interface HandlerContext extends Omit<ChannelTurn, 'standingQuestions'> {
  phoneE164: string;
  /**
   * A decision the natural-reply stage already made about this message (resolve.ts), or
   * null on the ordinary first pass.
   *
   * Non-optional so every handler has to see it exists. When it is set, the router is on
   * its SECOND pass and is calling exactly one handler — the one that declared this kind
   * in {@link DeterministicHandler.resolves} — so a handler reading a kind that is not
   * its own is a wiring bug rather than a case to handle.
   */
  resolved: ResolvedAnswer | null;
  /**
   * What Hale is still waiting to hear back about — read at most ONCE per turn, and only
   * if something asks.
   *
   * A thunk rather than a value because the overwhelming majority of inbound texts never
   * need it: a handler consults it only when it is about to claim a BARE affirmative,
   * which is the one case where the word alone does not say which question it answers
   * (see `soleOpenKind`). The resolver stage below shares the same memo, so a turn that
   * both checks and resolves still costs one read.
   */
  openQuestions(): Promise<readonly OpenQuestion[]>;
}

/** What the resolver decided, in the form the owning handler needs: which question, and
 * which way. The `questionId` is the row's own id (open-questions.ts), never a position. */
export interface ResolvedAnswer {
  kind: OpenQuestionKind;
  questionId: string;
  polarity: 'yes' | 'no';
  /** How sure the stage said it was. Carried down to the CONSENT LEDGER, not just used
   * for the grade check: rule #6's trail has to be able to answer "did a person type a
   * token, or did a model read a sentence, and how sure was it" months later. */
  confidence: ReplyConfidence;
}

export type { ChannelCoachRuntime, ChannelTurn };

export type HandlerVerdict =
  /** Not mine — the router tries the next handler. */
  | { claimed: false }
  /** Mine, and finished. `reply` is null when the handler already answered for itself. */
  | {
      claimed: true;
      outcome: string;
      reply: string | null;
      /**
       * Work that may only happen once the receipt has actually reached the parent,
       * handed the `channel_messages` id of the message that carried it.
       *
       * The MEM-10 send-time discipline, which the router already keeps for the coach's
       * plan offer (see `runAgentTurn`), made available to the deterministic chain: a
       * ledger row is minted or closed against the message that made it true, so a turn
       * that acted and then failed to reply leaves the question standing and the re-drive
       * finds it. Only called when a reply was sent — a handler that answers for itself
       * owns its own ledger writes.
       */
      afterSend?: (channelMessageId: string) => Promise<unknown>;
    };

/**
 * A pre-agent answer that does not involve a model.
 *
 * Each one wraps a module that already owns its own certainty — M8's health replies,
 * M7's registration check-ins, C1's own approval grammar — and adapts it to this
 * contract. They are ordered by the caller (see `defaultHandlers`), and the order is a
 * product decision, not an implementation detail.
 */
export interface DeterministicHandler {
  readonly name: string;
  /**
   * The open-question kinds this handler OWNS — the ones it can act on when the resolver
   * has read a parent's own words as an answer (resolve.ts). Absent for the handlers that
   * answer only exact shapes and have no question behind them (the address and name
   * captures, the registration check-in).
   *
   * Declared here rather than in a lookup table so the mapping cannot drift from the
   * chain: a kind nobody claims is visible as an unhandled resolution in the log, and a
   * handler that starts owning a kind says so in its own definition.
   */
  readonly resolves?: ReadonlySet<OpenQuestionKind>;
  handle(database: Database, ctx: HandlerContext): Promise<HandlerVerdict>;
}

export interface ChannelRouterDeps {
  database: Database;
  loadContext(
    database: Database,
    job: ChannelMessageReceivedJob,
  ): Promise<InboundContext | null>;
  transport: ChannelTransport;
  handlers: readonly DeterministicHandler[];
  /**
   * What Hale is still waiting to hear back about, and the stage that reads a parent's own
   * words against it (open-questions.ts, resolve.ts). Both non-nullable (rule #11): a
   * router with no question reader would silently stop understanding every reply that is
   * not a keyword, which is the failure this arc exists to remove — and it would do it
   * invisibly, because the turn would simply go to the coach and look fine.
   */
  questions: OpenQuestionReader;
  replyResolver: ReplyResolver;
  /** The cheap screen that answers what Hale does not do, before the coach is woken.
   * Non-nullable (rule #11): "no lane wired" is not a state this router has — a lane
   * that cannot run says so by returning `in_domain` with a named fallback. */
  offDomain: OffDomainLane;
  coach: ChannelCoachRuntime;
  /** The outage smoke alarm's memory (smoke-alarm.ts). Non-nullable (rule #11): "no
   * alarm wired" is not a state this router has — the alarm's own outcome enum is where
   * a quiet alarm says why it stayed quiet. */
  smokeAlarm: SmokeAlarmClaim;
  /** How far this inbound already got (turn-ledger.ts). Non-nullable (rule #11): a
   * router that could not tell a re-drive from a first attempt would answer some texts
   * twice and thread others nine times, and "we didn't wire the ledger" is not a state
   * this router may be in. */
  turns: InboundTurnLedger;
  /** The words a broken turn gets, composed (apology.ts). Non-nullable (rule #11) and
   * for the same reason the off-domain composer is: a composer that cannot run says so
   * by name, and this router has no preset sentence to fall back on. */
  apology: TurnApology;
  /**
   * Write down a full-plan offer the coach just made, against the message that carried
   * it. Non-nullable (rule #11): an offer sentence a parent can read with no ledger row
   * behind it is a question Hale cannot answer, so "no writer wired" is not a state
   * this router has.
   */
  recordPlanOffer(
    database: Database,
    input: {
      familyId: string;
      offer: PlanOffer;
      channelMessageId: string | null;
      now: Date;
    },
  ): Promise<unknown>;
  /**
   * Write down the "I'll come back to you" the coach just said, against the message that
   * carried it. Non-nullable for the sharper version of the reason above: a promise a
   * parent reads with no ledger row behind it is a debt no sweep can keep and no digest
   * can count — the 2026-08-20 defect exactly — so "no writer wired" is not a state this
   * router has (rule #11).
   */
  recordActivityPromise(
    database: Database,
    input: {
      familyId: string;
      promise: ActivityPromise;
      channelMessageId: string | null;
      now: Date;
    },
  ): Promise<unknown>;
  /**
   * What this family's ledger says, read beside the model call — the reconciliation
   * primitive's view (VIL-293). Non-nullable (rule #11): a router that could not read
   * the ledger would send every claim the model invented, which is the exact defect
   * this dep exists to close, and it would do it invisibly.
   */
  reconcileView(
    database: Database,
    input: { familyId: string; now: Date },
  ): Promise<ReconcileView>;
  /**
   * Write down the registration watch the coach just promised, against the message that
   * carried it. Non-nullable for the same reason `recordActivityPromise` is: the whole
   * point of MINTING rather than refusing is that the promise gets kept, and a mint that
   * silently did not happen leaves the parent with the sentence and nothing behind it.
   */
  recordRegistrationWatch(
    database: Database,
    input: {
      familyId: string;
      mint: RegistrationWatchMint;
      channelMessageId: string | null;
      now: Date;
    },
  ): Promise<unknown>;
  limiter: RateLimiter;
  now(): Date;
  log: Pick<Console, 'info' | 'error'>;
}

/** Why a turn went back to the queue instead of answering. `model_unreachable` is the
 * arc's own reason; the rest are the composer's, and they mean Hale had nothing
 * sendable to say rather than nobody to say it. */
export type TurnDeferralReason = 'model_unreachable' | ApologyFallback;

/**
 * The turn is not finished, and the parent gets NOTHING right now.
 *
 * Thrown so the drain FAILS rather than completes the job (lib/cron/drain.ts), which is
 * what puts it back on `channel.message.received` for pg-boss to re-drive with backoff.
 * The whole pipeline runs again on the next attempt — including the off-domain screen,
 * so the deterministic safety lane it fails open past during an outage gets its chance
 * the moment the provider returns.
 *
 * The founder's trade, stated plainly: a real answer two hours late beats a canned one
 * on time. At the retry ceiling the job dead-letters and the parent is never answered at
 * all, which is the deliberate other half of that trade — see the ceiling in
 * lib/cron/drain.ts.
 */
export class TurnDeferred extends Error {
  readonly reason: TurnDeferralReason;

  constructor(reason: TurnDeferralReason, cause: unknown) {
    super(`channel router: turn deferred (${reason})`, { cause });
    this.name = 'TurnDeferred';
    this.reason = reason;
  }
}

export type RouterStatus =
  /** The ledger row named by the job is gone — nothing to route. */
  | 'unknown_message'
  /** Not a parent: answered with M6's line, never threaded, never modelled. */
  | 'not_a_parent'
  /** No active verified channel to answer on. Nothing sent (CASL). */
  | 'unreachable'
  /** A deterministic handler owned it. */
  | 'handled'
  /** A parent answered an open question in their own words, and the handler that owns
   * that question acted on it (resolve.ts). Distinct from `handled` on purpose: it is
   * the number that says whether this arc is working. */
  | 'resolved'
  /** More than one question was open and the reply named none of them, so Hale asked
   * which — in one sentence, never a menu. */
  | 'clarified'
  | 'flood_held'
  /** The off-domain lane answered it with a fixed line; no coach turn was spent. */
  | 'deflected'
  | 'agent_replied'
  | 'agent_failed'
  /** This text already has Hale's answer, and the queue handed it back anyway. The turn
   * stops before anything is threaded, spent or sent (turn-ledger.ts). */
  | 'already_answered'
  /** The turn broke because the provider was unreachable AND the text named an
   * emergency: the fixed safety line went out with no model in the loop (smoke-alarm.ts).
   * A distinct status from `agent_failed` because it is the one outcome where a failed
   * turn still answered the question the parent actually asked. */
  | 'smoke_alarm_fired';

export interface RouterResult {
  status: RouterStatus;
  /** Which handler claimed it, when one did. */
  handler: string | null;
  conversationId: string | null;
  /** Which lane deflected it, when one did. Null for every other status — including an
   * in-domain turn, which is not an unmet intent and is counted as nothing. */
  lane: UnmetIntentLane | null;
}

export async function routeChannelMessage(
  deps: ChannelRouterDeps,
  job: ChannelMessageReceivedJob,
): Promise<RouterResult> {
  const now = deps.now();

  // GATE 0 — have we been here before? The drain is at-least-once and the defer arc
  // makes re-drives routine, so this is the first question, before a row is written or a
  // token spent. `answered` ends the turn on the spot; `deferred` says the two
  // CONSUMING steps below (the thread write and the hourly budget) are already paid for
  // and must not be paid again. See turn-ledger.ts for why those two and not the rest.
  const stage = await deps.turns.stageOf({
    familyId: job.family_id,
    channelMessageId: job.channel_message_id,
  });
  if (stage === 'answered') {
    return done(deps, job, {
      status: 'already_answered',
      handler: null,
      conversationId: null,
      lane: null,
    });
  }
  const redriven = stage === 'deferred';

  const context = await deps.loadContext(deps.database, job);
  if (!context) {
    return done(deps, job, {
      status: 'unknown_message',
      handler: null,
      conversationId: null,
      lane: null,
    });
  }

  // Flipped in the same breath as the durable claim (see sendReply), so a failure
  // AFTER the transport accepted the answer cannot make this turn answer a second time
  // on its way out. The durable claim stops the next ATTEMPT; this stops this one.
  let answered = false;
  const claimAnswer = async () => {
    answered = true;
    await deps.turns.recordAnswered({
      familyId: job.family_id,
      parentUserId: job.parent_user_id,
      channelMessageId: job.channel_message_id,
    });
  };

  // GATE 1 — who is talking. Before the thread is opened, so a non-parent's message can
  // never appear in the parents' Ask history.
  if (context.role === null || !PARENT_ROLES.has(context.role)) {
    if (context.phoneE164 && isOutsiderWeMayAnswer(context.role)) {
      // Ledgered and audited like every other outbound (rule #6) — but with NO
      // conversation, because a caregiver's exchange must never appear in the parents'
      // Ask history. That is the one difference between this send and a parent's.
      await sendReply(deps, {
        to: context.phoneE164,
        body: scopedReply(context.primaryParentName),
        job,
        conversationId: null,
        claim: claimAnswer,
      });
    }
    return done(deps, job, {
      status: 'not_a_parent',
      handler: null,
      conversationId: null,
      lane: null,
    });
  }

  if (!context.phoneE164) {
    return done(deps, job, {
      status: 'unreachable',
      handler: null,
      conversationId: null,
      lane: null,
    });
  }
  const phoneE164 = context.phoneE164;

  // THREAD. One long-lived conversation per parent, resolved through the note anchor's
  // partial unique index so two texts arriving together cannot fork it.
  const conversationId = await resolveOrCreateNoteConversation(
    job.family_id,
    channelSmsNoteKey(job.parent_user_id),
    deps.database,
  );
  // Once per TEXT, not once per attempt. A deferred turn already put these words in the
  // thread, and the coach re-reads that thread on the attempt that finally works.
  if (!redriven) {
    await appendMessage(conversationId, 'user', context.body, deps.database);
  }

  // Read at most once per turn, by whoever needs it first — a handler about to claim a
  // bare affirmative, the resolver, or nobody at all.
  let openQuestions: Promise<readonly OpenQuestion[]> | null = null;
  const readOpenQuestions = () => {
    openQuestions ??= deps.questions.open(deps.database, {
      familyId: job.family_id,
      parentUserId: job.parent_user_id,
      now,
    });
    return openQuestions;
  };

  const turn: HandlerContext = {
    familyId: job.family_id,
    parentUserId: job.parent_user_id,
    conversationId,
    body: context.body,
    phoneE164,
    now,
    resolved: null,
    openQuestions: readOpenQuestions,
  };

  /**
   * The turn's ANSWER: sent, then claimed, so a re-drive can never send a second one.
   *
   * `medicalSource` is the ONE fact about a reply that its ledger row carries beyond
   * delivery — see sendReply. Null for every answer that is not the medical lane's, which
   * is all of them but one.
   */
  const answer = (body: string, medicalSource: MedicalReplySource | null = null) =>
    sendReply(deps, {
      to: phoneE164,
      body,
      job,
      conversationId,
      claim: claimAnswer,
      medicalSource,
    });

  // GATE 2 — the deterministic handlers, in order. First claim ends the turn.
  for (const handler of deps.handlers) {
    const verdict = await handler.handle(deps.database, turn);
    if (!verdict.claimed) continue;
    await deliver(verdict, answer);
    return done(deps, job, {
      status: 'handled',
      handler: handler.name,
      conversationId,
      lane: null,
    });
  }

  // GATE 2b — DID THEY JUST ANSWER SOMETHING? The words a parent uses are theirs, and
  // Hale never hands them a keyword to recite (resolve.ts). This runs ONLY when both of
  // its preconditions hold: every free reader above declined, AND Hale is actually
  // holding a question. On the overwhelming majority of turns the second is false and
  // this costs one batch of indexed selects and no model call at all.
  //
  // It sits ABOVE flood control for the reason the handlers do: answering "yeah go ahead"
  // is the same act as answering "yes", and a parent whose hour is spent must still be
  // able to approve, decline and opt out. It sits BELOW them because a free, exact read
  // must always win — no keyword was removed, only stopped being printed.
  const natural = await resolveNaturalReply(deps, turn, answer);
  if (natural.status === 'handled') {
    return done(deps, job, { ...natural.result, conversationId, lane: null });
  }

  // GATE 3 — can we afford to think. Counted only here, so a deterministic answer never
  // spends a parent's hourly budget — and counted once per TEXT, because `check` COUNTS
  // as it decides: a turn deferred through an outage would otherwise come back over a
  // limit it spent on itself, and be answered with the flood line.
  if (!redriven) {
    const decision = await deps.limiter.check(
      job.parent_user_id,
      AGENT_TURN_ROUTE,
      AGENT_TURN_LIMIT,
    );
    if (!decision.allowed) {
      await answer(FLOOD_REPLY);
      return done(deps, job, { status: 'flood_held', handler: null, conversationId, lane: null });
    }
  }

  // GATE 4 — the family's week, or the world. The screen reads the LEDGER body (the same
  // words the handlers just declined), stamps its verdict on that same row, and either
  // answers it briefly or hands over one of the two fixed doors — so an off-domain turn
  // costs two Haiku calls and no coach turn at all. An in-domain verdict, including
  // every fail-open one, falls through untouched.
  const verdict = await deps.offDomain.consider({
    familyId: job.family_id,
    channelMessageId: job.channel_message_id,
    text: context.body,
  });
  if (verdict.status === 'deflected') {
    await answer(verdict.reply, verdict.medicalSource);
    return done(deps, job, {
      status: 'deflected',
      handler: null,
      conversationId,
      lane: verdict.lane,
    });
  }

  return runAgentTurn(deps, {
    job,
    turn,
    answer,
    hasAnswered: () => answered,
    conversationId,
    // Every coach turn is told what Hale is waiting on; an UNPLACED answer additionally
    // gets the canned choice sentence as its fallback, because that turn is the one where
    // silence-plus-an-apology would read as Hale ignoring a decision the parent made.
    questions: natural.questions,
    unplacedAnswer: natural.status === 'unplaced',
  });
}

/**
 * What GATE 2b decided, and what the rest of the turn is owed because of it.
 *
 * `questions` rides on EVERY outcome, including the ordinary one: whatever happens next,
 * the coach is entitled to know what Hale is holding an answer for, and this stage is
 * where that list was read.
 */
type NaturalReplyOutcome =
  | { status: 'handled'; result: Pick<RouterResult, 'status' | 'handler'> }
  /** They plainly ANSWERED something and Hale could not place which. */
  | { status: 'unplaced'; questions: readonly OpenQuestion[] }
  /** An ordinary message, or a degraded read. Carry on to the coach. */
  | { status: 'carry_on'; questions: readonly OpenQuestion[] };

/**
 * GATE 2b — the parent's own words, read against what Hale is actually waiting on.
 *
 *   RESOLVED. The owning handler acts, exactly as it would have for the keyword, and the
 *   parent gets that handler's own receipt. The handler is found by asking which one
 *   DECLARES the kind, so the mapping lives in the chain rather than in a table beside it
 *   — and only that one handler runs on this pass, which is what keeps M7's `reasked_at`
 *   stamp (a side effect on the way past) from being spent a second time.
 *
 *   UNPLACED. They plainly answered something and Hale cannot tell what, with more than
 *   one thing open. This USED TO BE a fixed sentence sent from right here ("Which one -
 *   add to your calendar, or meeting the family nearby?"), and on 2026-08-20 a parent got
 *   exactly that in answer to an offer Hale had made them four hours earlier and had
 *   never written down. The list was wrong, and the shape was wrong too: it is a machine
 *   reading its own option labels back at someone. So the turn goes to the COACH, which
 *   has the thread, the family, and now the candidates, and can ask like a person. The
 *   canned sentence survives only as the fallback for a coach that cannot run at all.
 *
 *   CARRY ON. Everything else, including a handler that declined the resolution because
 *   the row moved underneath it. Logged, named, never silent (rule #11).
 */
async function resolveNaturalReply(
  deps: ChannelRouterDeps,
  turn: HandlerContext,
  answer: (body: string) => Promise<string>,
): Promise<NaturalReplyOutcome> {
  const questions = await turn.openQuestions();
  // NO OPEN QUESTION, NO MODEL CALL. The precondition that makes this stage affordable on
  // every inbound text.
  if (questions.length === 0) return { status: 'carry_on', questions };

  const reading = await deps.replyResolver.read({ text: turn.body, questions });
  if (reading.status === 'unresolved') {
    return questions.length > 1 && warrantsClarifying(reading.reason)
      ? { status: 'unplaced', questions }
      : { status: 'carry_on', questions };
  }

  const owner = deps.handlers.find((handler) => handler.resolves?.has(reading.kind));
  if (!owner) {
    // A kind nobody owns. Impossible with the shipped chain and loud rather than silent,
    // because the failure it would otherwise cause is a parent's plain yes disappearing.
    deps.log.error(
      { kind: reading.kind },
      'channel router: no handler owns this resolved question kind',
    );
    return { status: 'carry_on', questions };
  }

  const verdict = await owner.handle(deps.database, {
    ...turn,
    resolved: {
      kind: reading.kind,
      questionId: reading.questionId,
      polarity: reading.polarity,
      confidence: reading.confidence,
    },
  });
  if (!verdict.claimed) {
    // The question closed between the two reads — the co-parent answered it in the app,
    // the offer expired. The coach takes the turn and can say something true about it.
    deps.log.info(
      { handler: owner.name, kind: reading.kind },
      'channel router: the owning handler declined a resolved answer',
    );
    return { status: 'carry_on', questions };
  }
  await deliver(verdict, answer);
  return { status: 'handled', result: { status: 'resolved', handler: owner.name } };
}

/**
 * Send a handler's receipt, then let it finish what only a delivered message can finish.
 *
 * The two halves are ordered and not optional: {@link HandlerVerdict.afterSend} closes
 * ledger rows against the message that closed them, so it may only run once the transport
 * has accepted one. A handler that answered for itself (`reply: null`) owns both halves.
 */
async function deliver(
  verdict: Extract<HandlerVerdict, { claimed: true }>,
  answer: (body: string) => Promise<string>,
): Promise<void> {
  if (verdict.reply === null) return;
  const channelMessageId = await answer(verdict.reply);
  await verdict.afterSend?.(channelMessageId);
}

/**
 * A message from a number that resolves to a household member who is not a parent.
 *
 * A caregiver gets M6's line. The legacy `extended`/`service` buckets get SILENCE: they
 * hold an empty content scope because we cannot say what they are entitled to, and
 * pointing them at a named parent ("that's one for Sam") is itself a small disclosure
 * to someone we cannot vouch for.
 */
function isOutsiderWeMayAnswer(role: FamilyRole | null): boolean {
  return role !== null && isCaregiverRole(role);
}

/**
 * The agent half. ONE message goes out per turn, and it is the answer.
 *
 * There used to be an "On it - one sec." raced against a five-second timer. It is gone
 * (founder decision, 2026-08-13): silence, then the answer. Two texts for one question
 * is worse on a phone than a pause — and the coach itself had started promising parents
 * it would stop sending the thing, which deterministic code then went on sending. An
 * agent must not be wired to break its own promises, so the wiring is what was removed.
 * The real fix for a slow turn is upstream anyway: the pickup delay (cron/kick-drain.ts)
 * and the unbounded model call, not a message about waiting.
 */
async function runAgentTurn(
  deps: ChannelRouterDeps,
  args: {
    job: ChannelMessageReceivedJob;
    turn: HandlerContext;
    /**
     * The turn's answer: sent, then claimed. Hands back the `channel_messages` id,
     * because a promise is minted against the message that CARRIED it (the MEM-10
     * send-time discipline) and this is the only place that knows which row that was.
     */
    answer: (body: string) => Promise<string>;
    /** Whether the transport has already accepted this turn's answer. */
    hasAnswered: () => boolean;
    conversationId: string;
    /** What Hale is holding an answer for — the coach gets their subjects (see
     * ChannelTurn), and a coach that cannot run gets the choice sentence built from them. */
    questions: readonly OpenQuestion[];
    /**
     * The parent plainly answered something and the resolver could not place which.
     *
     * The coach owns this turn (see resolveNaturalReply), so this flag changes only what
     * happens if the coach cannot run: a turn that broke here is the one turn where an
     * apology alone reads as Hale ignoring a decision, so the choice sentence is sent
     * instead. It is the fallback and never the first answer.
     */
    unplacedAnswer: boolean;
  },
): Promise<RouterResult> {
  try {
    // THE LEDGER, READ BESIDE THE MODEL AND NOT AFTER IT. The reconciliation view depends
    // only on WHICH family is talking, never on what the coach ends up saying, so the
    // whole batch resolves inside the seconds the turn is already thinking. That is what
    // keeps a gate on Hale's honesty off the critical path of a parent holding a phone —
    // the added wall-clock on an ordinary turn is the regex pass and nothing else.
    const view = deps.reconcileView(deps.database, {
      familyId: args.turn.familyId,
      now: args.turn.now,
    });
    const { reply, planOffer, activityPromise, mints } = await composeReconciledReply(
      deps,
      args,
      view,
    );
    const channelMessageId = await args.answer(reply);
    // AFTER the send, against the row that carried it — the MEM-10 send-time discipline
    // (lib/commitments/ledger.ts). A turn that composed an offer and then failed to
    // deliver it promised nobody anything, and must not leave a debt behind. The writer
    // never throws: the parent already has the message, so an exception here would buy a
    // carrier retry and a duplicate reply.
    if (planOffer) {
      await deps.recordPlanOffer(deps.database, {
        familyId: args.turn.familyId,
        offer: planOffer,
        channelMessageId,
        now: args.turn.now,
      });
    }
    // The same send-time discipline for the same reason, and the writer never throws for
    // the same reason too: the parent already has the message, so an exception here would
    // buy a carrier retry and a duplicate reply. A turn that composed "I'll come back to
    // you" and then failed to deliver it promised nobody anything.
    if (activityPromise) {
      await deps.recordActivityPromise(deps.database, {
        familyId: args.turn.familyId,
        promise: activityPromise,
        channelMessageId,
        now: args.turn.now,
      });
    }
    // THE PROMISE THE RECONCILE KEPT (VIL-293). The coach said it was watching a
    // registration morning; the ledger had no row for that, and a matched municipal
    // window with the ladder armed is the fact that lets one be written rather than the
    // sentence deleted. Same send-time discipline and same never-throws contract as the
    // two writers above it: the parent already has the text.
    for (const mint of mints) {
      await deps.recordRegistrationWatch(deps.database, {
        familyId: args.turn.familyId,
        mint,
        channelMessageId,
        now: args.turn.now,
      });
    }
    return done(deps, args.job, {
      status: 'agent_replied',
      handler: null,
      conversationId: args.conversationId,
      lane: null,
    });
  } catch (err) {
    // A turn can break AFTER its drafts landed, and those are real rows the parent can
    // approve. Saying "nothing was changed" would be false AND would orphan them — see
    // coach-runtime.ts (VIL-260).
    const drafted = draftsFromFailure(err);
    const disposition = await disposeOfFailedTurn(deps, args, err, drafted);
    // The error object may carry a provider payload, so only its class and message are
    // kept — never the turn body (rule #1). The disposition rides along so a turn that
    // said nothing is legible as a decision rather than as nothing (rule #11).
    deps.log.error(
      {
        channelMessageId: args.job.channel_message_id,
        err: err instanceof Error ? err.message : 'unknown',
        draftedThisTurn: drafted.length,
        ...disposition.log,
      },
      'channel router: agent turn failed',
    );

    if (disposition.outcome === 'deferred') {
      await deps.turns.recordDeferred({
        familyId: args.job.family_id,
        parentUserId: args.job.parent_user_id,
        channelMessageId: args.job.channel_message_id,
      });
      // A deferral is the quietest failure Hale has: the parent is told nothing and the
      // job goes back on the queue, so past the retry ceiling a question is simply never
      // answered. The log line above says it happened; this makes it a RATE, per reason
      // and per household. Only the enum and a hashed family id travel — the reporter
      // cannot express anything else (lib/analytics/server-capture.ts).
      await captureAgentError({
        lane: 'coach',
        reason: disposition.reason,
        familyId: args.job.family_id,
      });
      throw new TurnDeferred(disposition.reason, err);
    }
    if (disposition.reply !== null) await args.answer(disposition.reply);
    // AN APOLOGY IS NOT AN ANSWER. The reply above claims the turn (turn-ledger.ts), so
    // `sms_turn_answered` is written and the re-drive stays quiet — correctly: the parent
    // has their text. What that row must never do is stand alone. On 2026-08-22 it did,
    // and a turn whose entire output was "I couldn't get that done for you, and nothing
    // changed on your end" left an audit trail of three success-shaped rows and no
    // failure anywhere. This is the failure, typed, beside it (rule #11).
    await deps.turns.recordFailed({
      familyId: args.job.family_id,
      parentUserId: args.job.parent_user_id,
      channelMessageId: args.job.channel_message_id,
      reason: disposition.reason,
    });
    // And a RATE, per household and per class, the same way a deferral is one. A log
    // line on a serverless function is something you read after a parent complains; the
    // whole point of the arc that added this reporter is that Hale's quiet failures get
    // counted. Only the enum and a hashed family id travel (lib/analytics/server-capture.ts).
    await captureAgentError({
      lane: 'coach',
      reason: disposition.reason,
      familyId: args.job.family_id,
    });
    return done(deps, args.job, {
      status: disposition.outcome,
      handler: null,
      conversationId: args.conversationId,
      lane: null,
    });
  }
}

/**
 * ONE RE-ASK, AND THEN THE KNIFE. Two attempts, deliberately (VIL-293).
 *
 * A coach turn cannot be refused the way a sweep's can. The activity follow-up sweep
 * meets an unbacked sentence by sending nothing and leaving the promise open for the
 * next tick (#529, `refusedAtSend`) — there is no parent waiting on that message. Here
 * there is: refusing outright means a text that never gets answered, which is a worse
 * failure than the one being prevented. So the turn is composed again, once, with the
 * violation named in the second person — the #529 composer's shape, reused rather than
 * re-invented — and the parent has still heard nothing at that point, so it is a rewrite
 * rather than a correction.
 *
 * IF IT SAYS IT AGAIN, the offending SENTENCES are cut and the rest goes out verbatim
 * (`withoutRefusedClaims`). That is a subtraction, never a paraphrase: what the parent
 * reads is what the model wrote minus the parts nothing backs. A reply that was ENTIRELY
 * an unbacked claim leaves nothing to send, and that is a failed turn — the router's
 * apology path, which is the honest end of the road for a turn whose every sentence was
 * about a row that does not exist.
 *
 * Every refusal is a LOG LINE and a RATE, per attempt and per reason (rule #11). A gate
 * that quietly rewrites the model's answer and reports nothing is a gate nobody can tell
 * is firing — and how often the coach invents a watch is exactly the number that says
 * whether the skill needs work.
 */
const MAX_RECONCILE_ATTEMPTS = 2;

async function composeReconciledReply(
  deps: ChannelRouterDeps,
  args: {
    turn: HandlerContext;
    questions: readonly OpenQuestion[];
  },
  view: Promise<ReconcileView>,
): Promise<ChannelTurnResult & { mints: readonly RegistrationWatchMint[] }> {
  const standingQuestions = args.questions.map((question) => question.subject);
  let rejected: readonly string[] = [];
  let result: ChannelTurnResult | null = null;
  let verdict: ReconcileVerdict | null = null;

  for (let attempt = 1; attempt <= MAX_RECONCILE_ATTEMPTS; attempt += 1) {
    result = await deps.coach.respond({ ...args.turn, standingQuestions }, rejected);
    verdict = reconcile(extractStateClaims(result.reply), {
      ...(await view),
      // What THIS turn's tools already registered. A promise the router is about to write
      // is a promise: the sentence and the row go out together, so the model calling
      // `promise_activity_followup` is what makes "I'll come back to you" true.
      pendingKinds: new Set(result.activityPromise ? ['activity_followup' as const] : []),
    });
    if (verdict.refused.length === 0) {
      return { ...result, mints: verdict.mints };
    }
    rejected = reconcileViolations(verdict);
    for (const refusal of verdict.refused) {
      deps.log.error(
        { attempt, reason: refusal.reason },
        'channel router: the reply claimed a row that does not exist - not sent as written',
      );
      await captureAgentError({
        lane: 'reconcile',
        reason: refusal.reason,
        familyId: args.turn.familyId,
      });
    }
  }

  // Asked twice, claimed it twice. `result` and `verdict` are both set — the loop runs at
  // least once and only leaves early on the clean path.
  const composed = result as ChannelTurnResult;
  const refusedVerdict = verdict as ReconcileVerdict;
  const reply = withoutRefusedClaims(composed.reply, refusedVerdict);
  if (reply === '') {
    throw new Error(
      'channel router: every sentence of the reply claimed a row that does not exist',
    );
  }
  deps.log.error(
    { cut: refusedVerdict.refused.length },
    'channel router: sending the reply with the unbacked sentences cut out',
  );
  return { ...composed, reply, mints: refusedVerdict.mints };
}

/**
 * What a broken turn does next. Three answers, and which one it is turns entirely on
 * whether there was a model in the loop at all ({@link classifyTurnFailure}).
 *
 * MODEL UNREACHABLE. Nothing gets composed, because there is nothing to compose with.
 * The emergency branch is consulted first and unchanged (#427): a text naming an
 * unambiguous emergency gets the one fixed line, because a parent standing over a child
 * who is not breathing cannot wait on a provider. Everything else is DEFERRED — the
 * parent hears nothing now and gets the real reply when the model returns, which is the
 * founder's stated trade against a punctual canned sentence.
 *
 * DEFECT. The provider was reachable the whole time — our own request shape, a tool, a
 * query, a bug. So the sentence is COMPOSED (apology.ts) rather than recited, and the
 * twelve-word constant that used to answer every one of these is gone from this path.
 * A composer that cannot produce a sendable sentence defers too: there is no preset left
 * underneath it, and the re-drive may not need an apology at all.
 *
 * The ONE templated line still reachable from here is the drafts receipt, and it is not
 * an apology — it carries a count and the YES/NO grammar that resolves against real rows
 * (copy.ts partialFailureReply), the same reason every other receipt in this router is a
 * template the model never touches.
 */
type FailedTurnDisposition =
  | {
      outcome: 'smoke_alarm_fired' | 'agent_failed';
      reply: string | null;
      /**
       * WHY the turn failed, as a closed enum — required on every non-deferred branch
       * (rule #11). It rides here rather than being inferred at the call site because
       * the call site cannot tell an apology from a drafts receipt, and "this turn
       * failed and here is the class" is exactly the fact that did not exist anywhere
       * in the 2026-08-22 audit trail.
       */
      reason: TurnFailureReason;
      log: object;
    }
  | { outcome: 'deferred'; reason: TurnDeferralReason; log: object };

async function disposeOfFailedTurn(
  deps: ChannelRouterDeps,
  args: {
    job: ChannelMessageReceivedJob;
    turn: HandlerContext;
    answer: (body: string) => Promise<string>;
    hasAnswered: () => boolean;
    questions: readonly OpenQuestion[];
    unplacedAnswer: boolean;
  },
  err: unknown,
  drafted: readonly string[],
): Promise<FailedTurnDisposition> {
  // The turn already texted the parent and then broke on its own bookkeeping. They have
  // their answer; a second message about it would be Hale talking to itself. Nothing to
  // defer either — the durable claim is already written, so a re-drive stops at the
  // door.
  if (args.hasAnswered()) {
    return {
      outcome: 'agent_failed',
      reply: null,
      reason: 'broke_after_answering',
      log: { brokeAfterAnswering: true },
    };
  }

  if (classifyTurnFailure(err) === 'model_unreachable') {
    // THE SMOKE ALARM (smoke-alarm.ts), consulted first and only ever from here. During
    // a provider outage the off-domain screen fails open, so the lane that owns the
    // 811/911 sentence never got to classify — and deferring is what that parent would
    // otherwise get: silence, for hours, standing over a child who is not breathing.
    const smokeAlarm = await considerSmokeAlarm({
      claim: deps.smokeAlarm,
      err,
      body: args.turn.body,
      familyId: args.job.family_id,
      parentUserId: args.job.parent_user_id,
      channelMessageId: args.job.channel_message_id,
      // The alarm's send IS this text's answer — the one the parent acts on and the one
      // a re-drive must never repeat — so it claims the turn like every other. Adapted
      // rather than passed straight through because `answer` now hands back the ledger
      // row id (a promise is minted against the message that carried it), and the alarm
      // has no use for one: it sends a fixed line and is done.
      say: async (body) => {
        await args.answer(body);
      },
    });
    if (smokeAlarm === 'fired') {
      // No draft notice appended, deliberately. The alarm answers a parent who should be
      // dialling, and the drafts are still in the approvals queue for the next turn to
      // surface — a count of pending changes is not what that message is for.
      return {
        outcome: 'smoke_alarm_fired',
        reply: null,
        reason: 'smoke_alarm',
        log: { smokeAlarm },
      };
    }
    return {
      outcome: 'deferred',
      reason: 'model_unreachable',
      log: { smokeAlarm, deferred: 'model_unreachable' },
    };
  }

  if (drafted.length > 0) {
    return {
      outcome: 'agent_failed',
      reply: partialFailureReply(drafted.length),
      reason: 'drafts_receipt',
      log: {},
    };
  }

  // THE CANNED CHOICE, and this is the only place left that can send it. The parent made
  // a decision Hale could not place, and the coach — whose job that turn now is — could
  // not run. Deferring would leave a decision unacknowledged for as long as the outage
  // lasts, and an apology would answer a question they did not ask, so Hale asks which
  // one, in the subjects it was already holding.
  if (args.unplacedAnswer && args.questions.length > 1) {
    return {
      outcome: 'agent_failed',
      reply: clarifyWhichQuestion(args.questions),
      reason: 'unplaced_choice',
      log: { unplacedAnswer: true },
    };
  }

  const apology = await deps.apology.compose();
  if (apology.status === 'composed') {
    return {
      outcome: 'agent_failed',
      reply: apology.reply,
      reason: 'apology_sent',
      log: { apology: 'composed' },
    };
  }
  // The model went down BETWEEN the coach breaking on a bug and the apology being
  // written. That is no longer a defect — it is an outage, and it takes the outage's
  // route.
  const reason: TurnDeferralReason =
    apology.status === 'unreachable' ? 'model_unreachable' : apology.reason;
  return { outcome: 'deferred', reason, log: { deferred: reason } };
}

/**
 * Send one reply and record it three ways: the transport, the delivery ledger, and the
 * thread.
 *
 * The ledger row carries NO body. The reply's text lives in `messages`, which is what
 * the app renders and what the next turn reads back; copying it into channel_messages
 * would put a second copy of household detail in a table that exists to track delivery
 * (the M6 / loop-ledger discipline, rule #1).
 *
 * `conversationId` is null for the one reply that belongs to no thread — the caregiver
 * line. It still gets its ledger and audit rows, because rule #6 is about the ACT of
 * texting someone, not about which thread it landed in; it simply gets no `messages`
 * row, which is what keeps it out of the parents' history.
 *
 * Ordering: send first, then record. A recorded message that never went out would make
 * the thread lie to the parent about what Hale said; a sent message whose ledger row
 * failed is visible as a provider row we can reconcile. The audit row (rule #6) is
 * written with the ledger row it describes.
 *
 * `claim` is the ANSWER claim (turn-ledger.ts) and runs FIRST of the four records, which
 * is the tightest the ordering rule allows. Send-then-claim, because a claim written
 * before the send would suppress a text the parent never got; but every write between
 * the transport accepting and the claim landing is a window in which a crash makes the
 * re-drive answer a second time, so there are none. The ack passes no claim at all.
 * Returns the ledger row's id, because a promise is minted against the message that
 * CARRIED it (the MEM-10 send-time discipline) and this is the only place that knows
 * which row that was.
 */
async function sendReply(
  deps: ChannelRouterDeps,
  args: {
    to: string;
    body: string;
    job: ChannelMessageReceivedJob;
    conversationId: string | null;
    claim?: () => Promise<void>;
    /** The medical lane's outcome (migration 0090), or null for every other reply. The
     * only thing this row carries about the CONTENT of what was said, and it is a
     * two-value enum: which of the lane's two answers went out, so the founder
     * scorecard's safety row can count the fixed-line fallbacks it could not see while
     * the outcome lived only in memory. `body` stays null as ever (rule #1). */
    medicalSource?: MedicalReplySource | null;
  },
): Promise<string> {
  const { providerMessageId } = await deps.transport.send({ to: args.to, body: args.body });
  if (args.claim) await args.claim();

  const [row] = await deps.database
    .insert(schema.channelMessages)
    .values({
      familyId: args.job.family_id,
      parentUserId: args.job.parent_user_id,
      channel: 'sms',
      direction: 'out',
      category: 'reply',
      providerMessageId,
      // Accepted by Twilio, not yet on a phone — the receipt advances it
      // (channel/ledger.ts acceptedStatus, channel/twilio/status.ts).
      status: acceptedStatus('sms'),
      body: null,
      medicalReplySource: args.medicalSource ?? null,
      relatedConversationId: args.conversationId,
      sentAt: deps.now(),
    })
    .returning({ id: schema.channelMessages.id });
  const channelMessageId = row?.id;
  if (!channelMessageId) {
    throw new Error('channel router: channel_messages insert returned no row');
  }

  await deps.database.insert(schema.auditLog).values({
    familyId: args.job.family_id,
    actor: args.job.parent_user_id,
    actionTaken: 'sms_reply_sent',
    targetTable: 'channel_messages',
    targetId: channelMessageId,
  });

  if (args.conversationId) {
    await appendMessage(args.conversationId, 'assistant', args.body, deps.database);
  }
  return channelMessageId;
}

/** One structured line per routed message: ids and outcome enums, never a body. The
 * lane rides along because a deflection is the one outcome where Hale said no, and how
 * often it does that is the number X1 reports weekly. */
function done(
  deps: ChannelRouterDeps,
  job: ChannelMessageReceivedJob,
  result: RouterResult,
): RouterResult {
  deps.log.info(
    {
      channelMessageId: job.channel_message_id,
      status: result.status,
      handler: result.handler,
      lane: result.lane,
    },
    'channel router: routed',
  );
  return result;
}
