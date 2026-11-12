import { createHash, createHmac } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { AgentClient, RegisteredTool, Skill } from '@hale/agent';
import { schema } from '@hale/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const waitUntil = vi.hoisted(() => vi.fn());
vi.mock('@vercel/functions', () => ({ waitUntil }));
const stickerDecide = vi.hoisted(() => vi.fn());
vi.mock('~/lib/channel/linq/sticker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/channel/linq/sticker')>()),
  sharedLinqStickerDecider: () => ({ decide: stickerDecide }),
}));
const effectDecide = vi.hoisted(() => vi.fn());
vi.mock('~/lib/channel/linq/effect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/channel/linq/effect')>()),
  sharedLinqEffectDecider: () => ({ decide: effectDecide }),
}));
import type { ActivityPromise } from '~/lib/channel/activity/commitment';
import { scopedReply } from '~/lib/channel/caregiver/copy';
import type { FindReplyGate } from '~/lib/channel/coach/find-reasoning-judge';
import { channelCoachRuntime } from '~/lib/channel/coach/runtime';
import { createConsentAskWriter } from '~/lib/channel/consent-ask';
import type { ChannelMessageReceivedJob } from '~/lib/channel/inbound-route';
import {
  type FakeDb,
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeNoOpenQuestions,
  fakeRadar,
  fakeSilentAnswerComposer,
  makeFakeDb,
} from '~/lib/channel/intake/fakes';
import type { IntakeDeps } from '~/lib/channel/intake/machine';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { handleLinqInboundRequest } from '~/lib/channel/linq/inbound';
import type { VoiceReplyOutcome } from '~/lib/channel/linq/voice-reply';
import {
  GENERAL_ANSWER_SEARCH_ENABLED_ENV,
  createGeneralAnswer,
} from '~/lib/channel/off-domain/answer';
import {
  type OffDomainLane,
  type OffDomainVerdict,
  crisisMarkingLane,
  offDomainLane,
  productionOffDomainLane,
} from '~/lib/channel/off-domain/lane';
import type { LaneReading } from '~/lib/channel/off-domain/screen';
import { type ClaimEnforcer, createClaimEnforcer } from '~/lib/channel/reconcile/claim-enforce';
import { claimRowLabel } from '~/lib/channel/reconcile/claim-label';
import type { ClaimReader } from '~/lib/channel/reconcile/claim-reader';
import type { ClaimShadow } from '~/lib/channel/reconcile/claim-shadow';
import type { ReconcileView } from '~/lib/channel/reconcile/reconcile';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import type { SpotWatchIntent } from '~/lib/channel/spots/store';
import type { CrisisPager, CrisisUnanswered } from '~/lib/channel/voice/said-line';
import { channelGroupNoteKey, channelSmsNoteKey } from '~/lib/coach/note-key';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { calendarOffersIdle } from '~/lib/integrations/calendar-offer-read';
import {
  CRISIS_ANSWERED_ROUTE,
  CRISIS_UNANSWERED_AUDIT_ACTION,
  CRISIS_UNANSWERED_PAGE_ROUTE,
} from '~/lib/monitoring/failure-page';
import type { IncidentFailure } from '~/lib/monitoring/provider-health';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import type { RateLimiter } from '~/lib/rate-limit/limiter';
import { recordSignupOffer } from '~/lib/signup/store';
import { scriptedClaimReader } from '~/lib/testing/claim-reader';
import { askWriter, writtenAsk } from '~/lib/testing/consent-double';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import {
  INTRO_REPLY_FACTS,
  type IntroReplySituation,
  type VillageIntroReplyDeps,
} from '~/lib/village/intros/reply';
import { type ApologyOutcome, type TurnApology, createTurnApology } from './apology';
import type { BurstMember, BurstPlan, InboundBurst } from './burst';
import { type ChannelTurn, ChannelTurnFailed, type ChannelTurnResult } from './coach-runtime';
import { DeadlineError } from './deadline';
import type {
  DisambiguationOption,
  DisambiguationStore,
  PendingDisambiguation,
} from './disambiguation';
import { AGENT_TURNS_PER_HOUR } from './flood';
import type { FloodLineCompose, FloodLineComposer } from './flood-line';
import { villageIntroHandler } from './handlers';
import {
  approvalHandler,
  founderWelcomeHandler,
  healthReplyHandler,
  sequenceReplyHandler,
} from './handlers';
import { HOLDING_LINE_ENABLED_ENV, type HoldingLineComposer } from './holding-line';
import {
  type OpenQuestion,
  type OpenQuestionReader,
  type OpenQuestionSources,
  createOpenQuestionReader,
} from './open-questions';
import { FakeReplyTransport, type ReplyRoute } from './reply-route';
import { type ReplyReading, type ReplyResolver, toReading } from './resolve';
import {
  type ChannelCoachRuntime,
  type ChannelRouterDeps,
  type DeterministicHandler,
  type InboundContext,
  type RouterResult,
  TurnDeferred,
  routeChannelMessage,
} from './route';
import type { SmokeAlarmClaim } from './smoke-alarm';
import type { InboundTurnLedger, TurnStage } from './turn-ledger';
import { TURN_ANSWERED_ACTION, auditTurnLedger, loadInboundContext } from './wiring';

// The live search is on by default in production. These tests describe the kill switch
// (dark) unless a test lights it, so each starts dark.
beforeEach(() => {
  vi.stubEnv(GENERAL_ANSWER_SEARCH_ENABLED_ENV, 'false');
});

/**
 * The router, driven end to end minus the provider and the model.
 *
 * Everything that touches a real system is injected (the context read, the transport,
 * the handlers, the coach, the limiter, the clock), so what these tests actually pin is
 * the ORDER — which is the whole of C1's job. A reply that reaches the coach when a
 * deterministic handler should have caught it is a model call a parent pays for and a
 * "done" that never got filed; a reply that reaches the coach from a caregiver is a
 * disclosure. Both are ordering bugs, and both are asserted below.
 */

const FAMILY = '11111111-1111-4111-8111-111111111111';
/** The ledger row a recorded promise mints - the id the deep dispatch is keyed on. */
const PROMISE_COMMITMENT_ID = '77777777-7777-4777-8777-777777777777';
const PARENT = '22222222-2222-4222-8222-222222222222';
const PHONE = '+14165551234';
/** The route a text resolves to. Most of this file is about ORDER rather than delivery,
 * so the default stays SMS and the email cases below name themselves. */
const SMS_ROUTE: ReplyRoute = { channel: 'sms', to: PHONE };
const NOW = new Date('2026-07-30T12:00:00.000Z');

function job(overrides: Partial<ChannelMessageReceivedJob> = {}): ChannelMessageReceivedJob {
  return {
    family_id: FAMILY,
    parent_user_id: PARENT,
    channel_message_id: '33333333-3333-4333-8333-333333333333',
    provider_message_id: 'SM1',
    received_at: NOW.toISOString(),
    in_group: false,
    ...overrides,
  };
}

/** One text per call. The loops below mean "N different texts from the same parent",
 * and since the turn ledger keys on the inbound message id, reusing one id would mean
 * one text re-driven N times — which is a different scenario entirely. */
function nthJob(n: number): ChannelMessageReceivedJob {
  return job({
    channel_message_id: `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`,
    provider_message_id: `SM${n}`,
  });
}

/** A handler that claims every message, so "did the router stop here?" is observable. */
function claimingHandler(
  name: string,
  reply: string | null = `${name} reply`,
): DeterministicHandler & {
  calls: number;
} {
  const handler = {
    name,
    calls: 0,
    async handle() {
      handler.calls += 1;
      return { claimed: true as const, outcome: `${name}_claimed`, reply };
    },
  };
  return handler;
}

/** A handler that never claims — the common case for any given message. */
function passingHandler(name: string): DeterministicHandler & { calls: number; bodies: string[] } {
  const handler = {
    name,
    calls: 0,
    bodies: [] as string[],
    async handle(_db: unknown, ctx: { body: string }) {
      handler.calls += 1;
      handler.bodies.push(ctx.body);
      return { claimed: false as const };
    },
  };
  return handler as DeterministicHandler & { calls: number; bodies: string[] };
}

function fakeCoach(
  reply = 'coach says hi',
): ChannelCoachRuntime & { calls: number; standingQuestions: string[][]; rejected: string[][] } {
  const coach = {
    calls: 0,
    /** What each turn told the coach Hale was waiting on. */
    standingQuestions: [] as string[][],
    /** What each attempt was told the last one got wrong (VIL-293). */
    rejected: [] as string[][],
    async respond(turn: ChannelTurn, rejectedLastAttempt: readonly string[]) {
      coach.calls += 1;
      coach.standingQuestions.push([...turn.standingQuestions]);
      coach.rejected.push([...rejectedLastAttempt]);
      return { reply, planOffer: null, activityPromise: null, spotWatch: null };
    },
  };
  return coach;
}

/** A holding-line composer that always has a line, counting how often it was asked. */
function fakeHoldingLine(
  line = "I'm on it.",
): HoldingLineComposer & { calls: number; languages: Array<string | null> } {
  const holding = {
    calls: 0,
    languages: [] as Array<string | null>,
    async compose(language: string | null) {
      holding.calls += 1;
      holding.languages.push(language);
      return { status: 'composed' as const, line };
    },
  };
  return holding;
}

/** VIL-463: an over-limit composer that writes from facts, or fails like a dead model. */
function fakeFloodLine(
  result: FloodLineCompose = { status: 'composed', line: 'A lot came in at once.' },
): FloodLineComposer & { calls: number } {
  const flood = {
    calls: 0,
    async compose() {
      flood.calls += 1;
      return result;
    },
  };
  return flood;
}

/** A coach that cannot run at all — the outage the canned choice sentence exists for. */
function brokenCoach(): ChannelCoachRuntime {
  return {
    async respond() {
      throw new Error('coach unavailable');
    },
  };
}

/**
 * VIL-273 — a stand-in for the off-domain screen. It records what it was asked so the
 * ORDER can be asserted: a lane that was consulted for a message a handler should have
 * claimed is a model call the parent paid for, and a lane consulted AFTER the coach
 * would be no lane at all.
 */
function fakeLane(verdict: OffDomainVerdict): OffDomainLane & {
  calls: number;
  seen: Array<{ text: string; channelMessageId: string }>;
} {
  const lane = {
    calls: 0,
    seen: [] as Array<{ text: string; channelMessageId: string }>,
    async consider(input: {
      familyId: string;
      channelMessageId: string;
      text: string;
      onScreened?: (reading: LaneReading) => void;
    }) {
      lane.calls += 1;
      lane.seen.push({ text: input.text, channelMessageId: input.channelMessageId });
      input.onScreened?.(screenedAs(verdict));
      return verdict;
    },
  };
  return lane;
}

/** What the screen read for a scripted verdict: its lane, and its tag when it has one. */
function screenedAs(verdict: OffDomainVerdict): LaneReading {
  if (verdict.status === 'in_domain') {
    return {
      lane: 'in_domain',
      category: null,
      fallback: verdict.fallback,
      language: verdict.language ?? null,
    };
  }
  return {
    lane: verdict.lane,
    category: verdict.category,
    fallback: null,
    language: verdict.status === 'deflected' ? (verdict.language ?? null) : null,
  };
}

/** The lane's answer for everything Hale actually does — the overwhelmingly common one. */
const IN_DOMAIN: OffDomainVerdict = { status: 'in_domain', fallback: null };

/** A timer that never fires — the fast-turn case. */

/**
 * The outage alarm's memory, in memory. Injected rather than read from the fake db
 * because the fake does not evaluate `where` clauses — a claim read through it would
 * match the reply-sent audit rows this same turn writes and go green on nothing.
 */
function fakeSmokeAlarmClaim(): SmokeAlarmClaim & { fired: string[]; reads: string[] } {
  const claim = {
    fired: [] as string[],
    reads: [] as string[],
    async alreadyFired({ channelMessageId }: { channelMessageId: string }) {
      claim.reads.push(channelMessageId);
      return claim.fired.includes(channelMessageId);
    },
    async recordFired(input: { channelMessageId: string }) {
      claim.fired.push(input.channelMessageId);
    },
  };
  return claim;
}

/**
 * The router's memory of its own attempts, in memory. Injected for the same reason the
 * alarm's claim is: the fake db does not evaluate `where` clauses, so a stage read
 * through it would match the audit rows this very turn writes.
 */
function fakeTurnLedger(): InboundTurnLedger & {
  answered: string[];
  deferred: string[];
  deferredReasons: {
    channelMessageId: string;
    reason?: string;
    providerFailure?: IncidentFailure;
  }[];
  unanswered: { channelMessageId: string; reason: string }[];
  failed: { channelMessageId: string; reason: string }[];
  reads: string[];
  folded: string[];
} {
  const ledger = {
    answered: [] as string[],
    deferred: [] as string[],
    folded: [] as string[],
    deferredReasons: [] as {
      channelMessageId: string;
      reason?: string;
      providerFailure?: IncidentFailure;
    }[],
    unanswered: [] as { channelMessageId: string; reason: string }[],
    failed: [] as { channelMessageId: string; reason: string }[],
    reads: [] as string[],
    async stageOf({ channelMessageId }: { channelMessageId: string }): Promise<TurnStage> {
      ledger.reads.push(channelMessageId);
      if (ledger.answered.includes(channelMessageId)) return 'answered';
      if (ledger.folded.includes(channelMessageId)) return 'folded';
      if (ledger.deferred.includes(channelMessageId)) return 'deferred';
      return 'fresh';
    },
    async recordAnswered(input: { channelMessageId: string }) {
      ledger.answered.push(input.channelMessageId);
      return 'claimed' as const;
    },
    async recordDeferred(input: {
      channelMessageId: string;
      reason?: string;
      providerFailure?: IncidentFailure;
    }) {
      ledger.deferred.push(input.channelMessageId);
      ledger.deferredReasons.push({
        channelMessageId: input.channelMessageId,
        reason: input.reason,
        providerFailure: input.providerFailure,
      });
    },
    async recordUnanswered(input: { channelMessageId: string; reason: string }) {
      ledger.unanswered.push({
        channelMessageId: input.channelMessageId,
        reason: input.reason,
      });
    },
    async recordFailed(input: { channelMessageId: string; reason: string }) {
      ledger.failed.push({ channelMessageId: input.channelMessageId, reason: input.reason });
    },
  };
  return ledger;
}

/** The burst planner, scripted: a plan per attempt, and what each attempt asked for. The
 * planner's own reads, claims and settle are burst.pglite.test.ts's; here only what the
 * router does with a plan is asserted. Lone and dark by default, which is the state every
 * pre-existing test in this file means. */
function fakeBurst(
  plan: BurstPlan = { kind: 'lone', waitedMs: 0, why: 'flag_off' },
): InboundBurst & { stages: string[] } {
  const burst = {
    stages: [] as string[],
    async plan(_job: ChannelMessageReceivedJob, stage: 'fresh' | 'deferred') {
      burst.stages.push(stage);
      return plan;
    },
  };
  return burst;
}

/** A limiter that only counts. The real fake keeps its window state private, and what
 * the re-drive tests need to see is how many times the budget was CHARGED. */
function countingLimiter(): RateLimiter & { checks: number } {
  const limiter = {
    checks: 0,
    async check() {
      limiter.checks += 1;
      return { allowed: true, retryAfterSec: 3600, firstDenied: false };
    },
  };
  return limiter;
}

/** The sentence a real model writes on the defect branch. Its WORDS are the composer's
 * (apology.ts) and its quality is an eval (run-turn-apology-eval.mjs); what these tests
 * pin is that whatever it wrote is what the parent gets. */
const APOLOGY = 'That one broke on my end - nothing changed on your side.';

function fakeApology(
  outcome: ApologyOutcome = { status: 'composed', reply: APOLOGY },
): TurnApology & { calls: number } {
  const apology = {
    calls: 0,
    async compose() {
      apology.calls += 1;
      return outcome;
    },
  };
  return apology;
}

/** What Hale is waiting on. Empty by default, which is the state that makes the natural
 * reply stage a no-op and every pre-existing test in this file mean what it meant. */
function fakeQuestions(questions: OpenQuestion[]): OpenQuestionReader & { calls: number } {
  const reader = {
    calls: 0,
    async open() {
      reader.calls += 1;
      return questions;
    },
  };
  return reader;
}

/**
 * The menu Hale last offered, in memory. Injected for the same reason the turn ledger and
 * the alarm's claim are: the fake db does not evaluate `where` clauses, so a read through
 * it would return rows this very turn wrote and match a menu nobody was shown.
 *
 * It keeps the one property the real store's partial unique index keeps — AT MOST ONE
 * live menu per parent, superseded rather than accumulated — because a fake that let two
 * stand would pass a test the deployed code fails.
 */
function fakeDisambiguation(): DisambiguationStore & { minted: number } {
  let live: (PendingDisambiguation & { parentUserId: string }) | null = null;
  let seq = 0;
  const store = {
    minted: 0,
    async pending(_db: unknown, input: { parentUserId: string }) {
      return live && live.parentUserId === input.parentUserId ? live : null;
    },
    async mint(
      _db: unknown,
      input: {
        parentUserId: string;
        polarity: 'yes' | 'no';
        numbered: boolean;
        options: readonly DisambiguationOption[];
      },
    ) {
      seq += 1;
      store.minted += 1;
      live = {
        id: `menu-${seq}`,
        parentUserId: input.parentUserId,
        polarity: input.polarity,
        numbered: input.numbered,
        options: input.options,
      };
      return { status: 'minted' as const };
    },
    async consume(_db: unknown, input: { id: string }) {
      // The real store spends by UPDATE ... WHERE consumed_at IS NULL, so a second call
      // for the same menu matches nothing and says so (disambiguation.ts).
      if (live?.id !== input.id) return 'already_spent' as const;
      live = null;
      return 'spent' as const;
    },
  };
  return store as unknown as DisambiguationStore & { minted: number };
}

function fakeResolver(reading: ReplyReading): ReplyResolver & { calls: number } {
  const resolver = {
    calls: 0,
    async read() {
      resolver.calls += 1;
      return reading;
    },
  };
  return resolver;
}

/** A family Hale owes nothing and has nothing booked for — the state in which every
 * claim is false. The default, so a test that says nothing about the ledger cannot
 * accidentally be relying on one. */
/** The claim shadow as production runs it with the flag unset. */
function offShadow(): ClaimShadow {
  return { coachTurn: () => 'off', sweep: () => 'off', dispatch: () => 'off' };
}

/** The claim reader as production runs it with the flag unset: it never enforces. */
function offEnforcer(): ClaimEnforcer {
  return {
    enforces: () => false,
    read: async () => {
      throw new Error('the claim reader is not enforced here');
    },
  };
}

function emptyReconcileView(overrides: Partial<ReconcileView> = {}): ReconcileView {
  return {
    openKinds: new Set(),
    pendingKinds: new Set(),
    registrationLaddered: false,
    mintableWindow: null,
    scheduledTitles: [],
    statedBookings: [],
    ...overrides,
  };
}

interface Harness {
  deps: ChannelRouterDeps;
  fake: FakeDb;
  transport: FakeReplyTransport;
  logs: unknown[];
  turns: ReturnType<typeof fakeTurnLedger>;
}

function harness(
  options: {
    context?: Partial<InboundContext> | null;
    handlers?: DeterministicHandler[];
    coach?: ChannelCoachRuntime;
    limiter?: RateLimiter;
    offDomain?: OffDomainLane;
    smokeAlarm?: SmokeAlarmClaim;
    turns?: ReturnType<typeof fakeTurnLedger>;
    apology?: TurnApology;
    questions?: OpenQuestionReader;
    replyResolver?: ReplyResolver;
    calendarOffers?: ChannelRouterDeps['calendarOffers'];
    recordPlanOffer?: ChannelRouterDeps['recordPlanOffer'];
    recordActivityPromise?: ChannelRouterDeps['recordActivityPromise'];
    recordCapabilityNotes?: ChannelRouterDeps['recordCapabilityNotes'];
    reconcileView?: ChannelRouterDeps['reconcileView'];
    claimShadow?: ChannelRouterDeps['claimShadow'];
    claimEnforcer?: ChannelRouterDeps['claimEnforcer'];
    recordRegistrationWatch?: ChannelRouterDeps['recordRegistrationWatch'];
    armWatchedSpot?: ChannelRouterDeps['armWatchedSpot'];
    recordStatedState?: ChannelRouterDeps['recordStatedState'];
    weekdayCareReader?: ChannelRouterDeps['weekdayCareReader'];
    consent?: ChannelRouterDeps['consent'];
    weekdayCareAnswerTarget?: ChannelRouterDeps['weekdayCareAnswerTarget'];
    recordWeekdayCare?: ChannelRouterDeps['recordWeekdayCare'];
    searchWeekdays?: ChannelRouterDeps['searchWeekdays'];
    dispatchDeepResearch?: ChannelRouterDeps['dispatchDeepResearch'];
    turnDeadlineMs?: number;
    callTimeoutMs?: number;
    holdingLine?: HoldingLineComposer;
    holdingLineAfterMs?: number;
    floodLine?: FloodLineComposer;
    consentAsk?: ChannelRouterDeps['consentAsk'];
    crisisPager?: CrisisPager;
    burst?: InboundBurst;
  } = {},
): Harness {
  const fake = makeFakeDb();
  const transport = new FakeReplyTransport();
  const logs: unknown[] = [];
  const context: InboundContext | null =
    options.context === null
      ? null
      : {
          body: 'anything indoors this weekend?',
          role: 'primary_parent',
          primaryParentName: 'Sam',
          reply: SMS_ROUTE,
          inGroup: false,
          ...options.context,
        };

  const turns = options.turns ?? fakeTurnLedger();

  return {
    fake,
    transport,
    logs,
    turns,
    deps: {
      database: fake.db,
      leftChatSince: async () => false,
      loadContext: async () => context,
      transport,
      handlers: options.handlers ?? [],
      coach: options.coach ?? fakeCoach(),
      recordPlanOffer: options.recordPlanOffer ?? (async () => ({ status: 'recorded' })),
      recordCapabilityNotes:
        options.recordCapabilityNotes ??
        (async () => ({ status: 'recorded' as const, declined: 0, corrected: 0 })),
      recordActivityPromise:
        options.recordActivityPromise ??
        (async () => ({ status: 'recorded' as const, commitmentId: PROMISE_COMMITMENT_ID })),
      reconcileView: options.reconcileView ?? (async () => emptyReconcileView()),
      claimShadow: options.claimShadow ?? offShadow(),
      claimEnforcer: options.claimEnforcer ?? offEnforcer(),
      // VIL-294. Nothing is stated by default, so a test that says nothing about the
      // inbound half cannot accidentally be relying on a write.
      recordStatedState:
        options.recordStatedState ?? (async () => ({ status: 'nothing_stated' as const })),
      // VIL-360. No ask standing by default, for the reason above it.
      consentAsk: options.consentAsk ?? askWriter(),
      weekdayCareReader: options.weekdayCareReader ?? {
        read: async () => ({ status: 'nothing_stated' as const }),
      },
      consent: options.consent,
      weekdayCareAnswerTarget:
        options.weekdayCareAnswerTarget ?? (async () => ({ status: 'no_open_ask' as const })),
      recordWeekdayCare:
        options.recordWeekdayCare ??
        (async (_db, input) => ({
          status: 'recorded' as const,
          care: input.care,
          providerNamed: input.provider !== null,
        })),
      searchWeekdays:
        options.searchWeekdays ??
        (async () => ({ status: 'abstain' as const, reason: 'not_configured' })),
      recordRegistrationWatch:
        options.recordRegistrationWatch ?? (async () => ({ status: 'recorded' as const })),
      armWatchedSpot:
        options.armWatchedSpot ?? (async () => ({ status: 'armed' as const, spotId: 'spot-1' })),
      dispatchDeepResearch:
        options.dispatchDeepResearch ?? (async () => ({ status: 'enqueued' as const })),
      questions: options.questions ?? fakeQuestions([]),
      replyResolver:
        options.replyResolver ?? fakeResolver({ status: 'unresolved', reason: 'no_target' }),
      calendarOffers: options.calendarOffers ?? calendarOffersIdle,
      disambiguation: fakeDisambiguation(),
      offDomain: options.offDomain ?? fakeLane(IN_DOMAIN),
      smokeAlarm: options.smokeAlarm ?? fakeSmokeAlarmClaim(),
      turns,
      burst: options.burst ?? fakeBurst(),
      apology: options.apology ?? fakeApology(),
      holdingLine: options.holdingLine ?? fakeHoldingLine(),
      floodLine: options.floodLine ?? fakeFloodLine(),
      crisisPager: options.crisisPager ?? recordingCrisisPager().pager,
      holdingLineAfterMs: options.holdingLineAfterMs,
      limiter: options.limiter ?? new FakeRateLimiter(() => NOW.getTime()),
      now: () => NOW,
      turnDeadlineMs: options.turnDeadlineMs,
      callTimeoutMs: options.callTimeoutMs,
      log: {
        info: (...args: unknown[]) => logs.push(args),
        warn: (...args: unknown[]) => logs.push(args),
        error: (...args: unknown[]) => logs.push(args),
      } as unknown as Pick<Console, 'info' | 'warn' | 'error'>,
    },
  };
}

/** The crisis pager port, recorded: what it was asked to record, then to page. */
function recordingCrisisPager(): {
  pager: CrisisPager;
  recorded: CrisisUnanswered[];
  paged: CrisisUnanswered[];
} {
  const recorded: CrisisUnanswered[] = [];
  const paged: CrisisUnanswered[] = [];
  return {
    recorded,
    paged,
    pager: {
      async record(alert) {
        recorded.push(alert);
      },
      async page(alert) {
        paged.push(alert);
        return 'paged';
      },
    },
  };
}

const conversationRows = (fake: FakeDb) => fake.rows(schema.conversations);
const messageRows = (fake: FakeDb) => fake.rows(schema.messages);
const auditRows = (fake: FakeDb) => fake.rows(schema.auditLog);
const ledgerRows = (fake: FakeDb) => fake.rows(schema.channelMessages);
const pendingAskRows = (fake: FakeDb) => fake.rows(schema.channelPendingAsks);

// ── the channel a parent wrote in on ─────────────────────────────────────────

// ── threading ────────────────────────────────────────────────────────────────

describe('threading', () => {
  it('anchors the thread to the parent, not the family', async () => {
    const h = harness();
    await routeChannelMessage(h.deps, job());

    expect(conversationRows(h.fake)).toHaveLength(1);
    expect(conversationRows(h.fake)[0]).toMatchObject({
      familyId: FAMILY,
      noteKey: channelSmsNoteKey(PARENT),
    });
  });

  it('lands a second text in the SAME conversation', async () => {
    const h = harness();
    const first = await routeChannelMessage(h.deps, nthJob(1));
    const second = await routeChannelMessage(h.deps, nthJob(2));

    expect(second.conversationId).toBe(first.conversationId);
    expect(conversationRows(h.fake)).toHaveLength(1);
  });

  it('records every turn as a message row — the parent AND Hale', async () => {
    const h = harness({ coach: fakeCoach('here is one pick') });
    await routeChannelMessage(h.deps, job());

    expect(messageRows(h.fake).map((r) => [r.role, r.content])).toEqual([
      ['user', 'anything indoors this weekend?'],
      ['assistant', 'here is one pick'],
    ]);
  });

  it('ledgers and audits the outbound reply (rule #6)', async () => {
    const h = harness();
    await routeChannelMessage(h.deps, job());

    const out = ledgerRows(h.fake).filter((r) => r.direction === 'out');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ familyId: FAMILY, parentUserId: PARENT, channel: 'sms' });
    expect(auditRows(h.fake).map((r) => r.actionTaken)).toContain('sms_reply_sent');
  });

  it('records the pipe the transport actually used — an iMessage-carried reply is an imessage row', async () => {
    const h = harness();
    const inner = h.deps.transport;
    h.deps.transport = {
      send: async (input) => ({ ...(await inner.send(input)), channel: 'imessage' as const }),
    };
    await routeChannelMessage(h.deps, job());

    const out = ledgerRows(h.fake).filter((r) => r.direction === 'out');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ channel: 'imessage', status: 'sent' });
  });

  /**
   * The reply is QUEUED, not sent. The phone provider accepts a message and transmits it later — a
   * segment per second from one long code — so 'sent' at accept time asserted a carrier
   * handoff nobody observed, and made a backlog of texts waiting for airtime
   * indistinguishable from texts already delivered. The status callback is what moves
   * this row on (delivery-status.ts).
   */
  it('records the outbound reply as queued, not as sent', async () => {
    const h = harness();
    await routeChannelMessage(h.deps, job());

    const out = ledgerRows(h.fake).filter((r) => r.direction === 'out');
    expect(out[0]?.status).toBe('queued');
  });

  /**
   * The reply text lives in `messages` (the thread the app renders) and nowhere else.
   * Copying it into the ledger body would put a second copy of household detail in a
   * table that exists to track DELIVERY, which is the M6/loop discipline (rule #1).
   */
  it('keeps the reply body out of the delivery ledger', async () => {
    const h = harness({ coach: fakeCoach('Mia has swim at 4') });
    await routeChannelMessage(h.deps, job());

    const out = ledgerRows(h.fake).filter((r) => r.direction === 'out');
    expect(out[0]?.body).toBeNull();
    expect(messageRows(h.fake).some((r) => r.content === 'Mia has swim at 4')).toBe(true);
  });

  // VIL-616: the nightly memory writer skips a row marked `read_email`, so a name or
  // number the coach repeated from an email is never learned.
  it.each([
    { emailRead: true, source: { kind: 'read_email' } },
    { emailRead: false, source: undefined },
  ])(
    'a reply written after reading an email ($emailRead) marks its thread row',
    async ({ emailRead, source }) => {
      const coach: ChannelCoachRuntime = {
        async respond() {
          return {
            reply: 'The trip is Friday.',
            planOffer: null,
            activityPromise: null,
            spotWatch: null,
            emailRead,
          };
        },
      };
      const h = harness({ coach });
      await routeChannelMessage(h.deps, job());

      const assistant = messageRows(h.fake).filter((r) => r.role === 'assistant');
      expect(assistant.map((r) => [r.content, r.source])).toEqual([
        ['The trip is Friday.', source],
      ]);
    },
  );
});

// ── the order ────────────────────────────────────────────────────────────────

describe('routing order', () => {
  it('runs deterministic handlers BEFORE the coach and stops at the first claim', async () => {
    const health = claimingHandler('health', 'Filed — I won’t raise that one again.');
    const later = passingHandler('sequence');
    const coach = fakeCoach();
    const h = harness({ context: { body: 'done' }, handlers: [health, later], coach });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('handled');
    expect(result.handler).toBe('health');
    expect(coach.calls).toBe(0);
    // Handlers behind the claim are never consulted.
    expect(later.calls).toBe(0);
    expect(h.transport.bodies()).toEqual(['Filed — I won’t raise that one again.']);
  });

  it('tries handlers in the order given', async () => {
    const first = passingHandler('approval');
    const second = claimingHandler('health');
    const h = harness({ context: { body: 'done' }, handlers: [first, second] });

    const result = await routeChannelMessage(h.deps, job());

    expect(first.calls).toBe(1);
    expect(result.handler).toBe('health');
  });

  it('reaches the coach only when every handler declines', async () => {
    const declining = [passingHandler('approval'), passingHandler('health')];
    const coach = fakeCoach();
    const h = harness({ handlers: declining, coach });

    const result = await routeChannelMessage(h.deps, job());

    expect(declining.every((d) => d.calls === 1)).toBe(true);
    expect(coach.calls).toBe(1);
    expect(result.status).toBe('agent_replied');
  });

  it('hands the handler the same threaded conversation the coach would get', async () => {
    const handler = passingHandler('approval');
    const h = harness({ handlers: [handler] });
    const result = await routeChannelMessage(h.deps, job());

    expect(handler.bodies).toEqual(['anything indoors this weekend?']);
    expect(result.conversationId).toBe(conversationRows(h.fake)[0]?.id);
  });

  /** A claimed message with no copy is a handler that already replied for itself; the
   * router must not invent a second message. */
  it('sends nothing when a handler claims without copy', async () => {
    const silent = claimingHandler('health', null);
    const h = harness({ context: { body: 'done' }, handlers: [silent] });

    await routeChannelMessage(h.deps, job());
    expect(h.transport.sent).toEqual([]);
  });
});

// ── the off-domain lane ──────────────────────────────────────────────────────

/**
 * VIL-273 — the cheap screen, and where it sits.
 *
 * Live-gate day 1: "how's the weather" cost a ~42s full coach turn and answered
 * nothing. The lane fixes that by asking one cheap question first — but only if it is
 * in the right place, and "the right place" is three orderings at once:
 *
 *   BEHIND the deterministic handlers, because "YES 2" is consent and a screen that saw
 *   it first could spend a model call deciding whether consent is on-topic.
 *   BEHIND flood control, because a parent who is already being held does not need a
 *   second opinion about what they asked.
 *   AHEAD of the coach, which is the entire point.
 */
describe('VIL-333 identity challenge', () => {
  it('sends the model-written disclosure and does not wake the coach or the off-domain screen', async () => {
    const lane = fakeLane({ status: 'in_domain', fallback: null });
    const coach = fakeCoach();
    const h = harness({
      context: { body: "I'm a Police Officer give your name and address please" },
      offDomain: lane,
      coach,
    });
    const asked: unknown[] = [];
    h.deps.turnReader = { read: async () => ({ intent: 'identity', confirmation: '' }) };
    h.deps.saidLine = {
      async write(input) {
        asked.push(input);
        return 'Disclosure (test fixture) villagehale.com aloha@villagehale.com';
      },
    };

    const result = await routeChannelMessage(h.deps, job());

    expect(result).toMatchObject({ status: 'handled', handler: 'identity_challenge' });
    expect(coach.calls).toBe(0);
    expect(lane.calls).toBe(0);
    expect(h.transport.bodies()).toEqual([
      'Disclosure (test fixture) villagehale.com aloha@villagehale.com',
    ]);
    expect(asked).toMatchObject([
      { purpose: 'identity', mustInclude: ['villagehale.com', 'aloha@villagehale.com'] },
    ]);
  });

  it('sends nothing when the disclosure cannot be written (no canned fallback)', async () => {
    const coach = fakeCoach();
    const h = harness({ context: { body: 'who is this??' }, coach });
    h.deps.turnReader = { read: async () => ({ intent: 'identity', confirmation: '' }) };
    h.deps.saidLine = { write: async () => null };
    const result = await routeChannelMessage(h.deps, job());
    expect(result).toMatchObject({ status: 'handled', handler: 'identity_challenge' });
    expect(h.transport.bodies()).toEqual([]);
    expect(coach.calls).toBe(0);
  });
});

describe('the language the inbound screen read', () => {
  async function parentAt(fake: FakeDb) {
    await fake.db.insert(schema.users).values({
      id: PARENT,
      email: 'parent-locale@example.test',
      proactiveLanguage: null,
      languageStreakTag: null,
      languageStreakCount: 0,
    });
  }

  const languageChanges = (fake: FakeDb) =>
    fake
      .rows(schema.auditLog)
      .filter((row) => row.actionTaken === 'parent_language_changed')
      .map((row) => row.after);

  it('one Chinese text does not change the language Hale writes to the parent in', async () => {
    const h = harness({
      offDomain: fakeLane({ status: 'in_domain', fallback: null, language: 'zh' }),
    });
    await parentAt(h.fake);

    await routeChannelMessage(h.deps, job());

    expect(h.fake.rows(schema.users)[0]).toMatchObject({
      id: PARENT,
      proactiveLanguage: null,
      languageStreakTag: 'zh',
      languageStreakCount: 1,
    });
    expect(languageChanges(h.fake)).toEqual([]);
  });

  it('three in a row, on either door, do', async () => {
    const h = harness({
      offDomain: fakeLane({
        status: 'deflected',
        lane: 'off_domain_general',
        category: 'weather',
        reply: 'Rain later.',
        replySource: 'composed',
        medicalSource: null,
        signal: 'recorded',
        language: 'ar',
        pendingAsk: null,
      }),
    });
    await parentAt(h.fake);

    for (const n of [1, 2, 3]) await routeChannelMessage(h.deps, nthJob(n));

    expect(h.fake.rows(schema.users)[0]).toMatchObject({ proactiveLanguage: 'ar' });
    expect(languageChanges(h.fake)).toEqual([{ language: 'ar', why: 'sustained' }]);
  });

  it('an explicit ask changes it on the one text', async () => {
    const h = harness({
      offDomain: fakeLane({
        status: 'in_domain',
        fallback: null,
        language: 'en',
        languageRequest: 'fr',
      }),
    });
    await parentAt(h.fake);

    await routeChannelMessage(h.deps, job());

    expect(h.fake.rows(schema.users)[0]).toMatchObject({ proactiveLanguage: 'fr' });
    expect(languageChanges(h.fake)).toEqual([{ language: 'fr', why: 'asked' }]);
  });

  it('leaves everything alone when the verdict has no tag', async () => {
    const h = harness({ offDomain: fakeLane({ status: 'in_domain', fallback: null }) });
    await parentAt(h.fake);
    await routeChannelMessage(h.deps, job());
    expect(h.fake.writes.filter((w) => w.op === 'update' && w.table === schema.users)).toEqual([]);
  });
});

describe('the off-domain lane', () => {
  // A test here that lights the search must not leave it lit for the next one.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Boundary v3: the general lane ANSWERS. What the router owes it is unchanged — one
  // send, threaded, ledgered, audited, and no coach woken.
  const ANSWERED: OffDomainVerdict = {
    status: 'deflected',
    lane: 'off_domain_general',
    category: 'weather',
    reply: "I can't see live conditions, but I do check your area's forecast for weekends.",
    replySource: 'composed',
    medicalSource: null,
    signal: 'recorded',
    pendingAsk: null,
  };

  /** The lane's other answer: a symptom, answered rather than deflected. */
  const medicalVerdict = (medicalSource: 'web_grounded' | 'fixed'): OffDomainVerdict => ({
    status: 'deflected',
    lane: 'safety_critical',
    category: 'medical-symptom',
    reply:
      medicalSource === 'fixed' ? 'MOMENT_CHILD_HEALTH' : 'Fevers at this age are usually viral.',
    replySource: medicalSource,
    medicalSource,
    signal: 'not_applicable',
    pendingAsk: null,
  });

  /**
   * The medical lane's outcome only ever existed on the way to the transport, so the
   * founder scorecard's SAFETY row could not count how often a parent with a hurt child
   * got the fixed 811/911 line instead of an answer. The reply's own ledger row is where
   * that fact belongs — and the row stays bodyless, carrying a two-value enum and not one
   * word of what was said (rule #1).
   */
  it.each(['web_grounded', 'fixed'] as const)(
    'stamps a medical answer (%s) on the reply row it sends, body still null',
    async (source) => {
      const h = harness({
        context: { body: 'she has had a fever for three days' },
        offDomain: fakeLane(medicalVerdict(source)),
      });

      await routeChannelMessage(h.deps, job());

      const sent = ledgerRows(h.fake).filter((r) => r.direction === 'out');
      expect(sent).toHaveLength(1);
      expect(sent[0]?.medicalReplySource).toBe(source);
      expect(sent[0]?.body).toBeNull();
    },
  );

  /** A door Hale chose, or an answer about the world, is not a medical answer. Stamping
   * one would put a deliberate deflection into the safety row's fallback count. */
  it('leaves the stamp null on every reply that is not a medical answer', async () => {
    const h = harness({ context: { body: "how's the weather" }, offDomain: fakeLane(ANSWERED) });

    await routeChannelMessage(h.deps, job());

    const sent = ledgerRows(h.fake).filter((r) => r.direction === 'out');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.medicalReplySource ?? null).toBeNull();
  });

  /**
   * The rest of the verdict's provenance gets the same treatment (migration 0103): the
   * lane already NAMES where the words came from — composed, a fixed door, or one of the
   * four reasons the composer could not run — and dropping that at the send seam is what
   * made the weekly deflection count silently mix real answers with
   * ANSWER_UNAVAILABLE sends. The row still carries no body (rule #1).
   */
  it.each([
    ['composed', ANSWERED],
    [
      'model_failed',
      {
        ...ANSWERED,
        reply: "Couldn't get to that one - ask me again tomorrow.",
        replySource: 'model_failed',
      } satisfies OffDomainVerdict,
    ],
  ] as const)(
    'persists the deflection reply source (%s) on the reply row it sends',
    async (source, verdict) => {
      const h = harness({ context: { body: "how's the weather" }, offDomain: fakeLane(verdict) });

      await routeChannelMessage(h.deps, job());

      const sent = ledgerRows(h.fake).filter((r) => r.direction === 'out');
      expect(sent).toHaveLength(1);
      expect(sent[0]?.replySource).toBe(source);
      expect(sent[0]?.body).toBeNull();
    },
  );

  /**
   * A reply that left a question open ("which city?") keeps that question beside its own
   * ledger row, in a table of its own (migration 0167), where the parent's next text can
   * be read beside it. What is kept is the lane's de-identified question and what it was
   * missing. `body` stays null: not the parent's words, and not what Hale said.
   */
  it('keeps the question a reply left open beside the reply row it sends, body still null', async () => {
    vi.stubEnv(GENERAL_ANSWER_SEARCH_ENABLED_ENV, 'true');
    const h = harness({
      context: { body: "how's the weather tomorrow" },
      offDomain: fakeLane({
        ...ANSWERED,
        reply: 'Which city are you in?',
        pendingAsk: { question: 'hows the weather tomorrow', missing: 'which city' },
      }),
    });

    await routeChannelMessage(h.deps, job());

    const sent = ledgerRows(h.fake).filter((r) => r.direction === 'out');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ body: null });
    expect(sent[0]?.id).toEqual(expect.any(String));
    expect(pendingAskRows(h.fake)).toMatchObject([
      {
        channelMessageId: sent[0]?.id,
        familyId: FAMILY,
        question: 'hows the weather tomorrow',
        missing: 'which city',
      },
    ]);
    expect(pendingAskRows(h.fake)).toHaveLength(1);
    // The reply's own row names no column for it: that table is written by every text.
    expect(Object.keys(sent[0] ?? {}).filter((column) => /pending/i.test(column))).toEqual([]);
  });

  /** Only a lit general answer leaves a question open, and the table is its alone. With
   * the search dark nothing is written there, whatever a lane hands back. */
  it('keeps no question while the search is dark, whatever the lane hands back', async () => {
    const h = harness({
      context: { body: "how's the weather tomorrow" },
      offDomain: fakeLane({
        ...ANSWERED,
        reply: 'Which city are you in?',
        pendingAsk: { question: 'hows the weather tomorrow', missing: 'which city' },
      }),
    });

    await routeChannelMessage(h.deps, job());

    expect(h.transport.bodies()).toEqual(['Which city are you in?']);
    expect(pendingAskRows(h.fake)).toEqual([]);
  });

  /**
   * The compose writes a `grounding` list before its answer (answer-request.ts). Through
   * the real composer and the real lane, none of it reaches the parent, the reply's ledger
   * row or a log line. The answer and the question it left open do.
   */
  it('sends, keeps and logs nothing of the grounding the compose wrote', async () => {
    vi.stubEnv(GENERAL_ANSWER_SEARCH_ENABLED_ENV, 'true');
    const consoleLines: unknown[][] = [];
    for (const level of ['error', 'warn', 'info', 'log', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        consoleLines.push(args);
      });
    }
    const structured = (payload: unknown) => ({
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const client = () =>
      ({
        messages: {
          async create(request: { system: Array<{ text: string }> }) {
            const sanitizing = request.system
              .map((block) => block.text)
              .join('')
              .includes('Take the family out, keep the question');
            return structured(
              sanitizing
                ? {
                    language: 'en',
                    answers_pending: 'nothing_pending',
                    question: 'hows the weather tomorrow',
                    missing_detail: 'which city',
                    their_place: 'needed',
                    current_fact: 'the forecast',
                    needs_search: 'missing_detail',
                  }
                : {
                    grounding: [{ states: 'GROUNDED-SPECIFIC', from: 'GROUNDED-SOURCE-WORDS' }],
                    answer: 'Which city are you in?',
                  },
            );
          },
        },
      }) as unknown as AgentClient;
    const lane = offDomainLane({
      screen: {
        read: async () => ({
          lane: 'off_domain_general',
          category: 'weather',
          fallback: null,
          language: null,
        }),
      },
      answer: createGeneralAnswer(client),
      today: async () => 'monday, oct 12, 2026',
      place: async () => ({ status: 'unknown', reason: 'no_postal' }),
      healthPlace: async () => null,
      pendingAsk: async () => ({ status: 'none' }),
      medical: {
        answer: async () => {
          throw new Error('not a medical turn');
        },
      },
      moment: { write: async () => ({ status: 'written', reply: 'moment wrote this' }) },
      recordUnmetIntent: async () => 'recorded',
    });
    const h = harness({ context: { body: "how's the weather tomorrow" }, offDomain: lane });

    await routeChannelMessage(h.deps, job());

    const sent = ledgerRows(h.fake).filter((r) => r.direction === 'out');
    // Positive control: the answer went out, the question it left open was kept, and the
    // turn logged.
    expect(h.transport.bodies()).toEqual(['Which city are you in?']);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ replySource: 'composed' });
    expect(pendingAskRows(h.fake)).toMatchObject([
      { question: 'hows the weather tomorrow', missing: 'which city' },
    ]);
    expect(consoleLines.length).toBeGreaterThan(0);
    expect(
      JSON.stringify([
        h.transport.sent,
        ledgerRows(h.fake),
        pendingAskRows(h.fake),
        h.logs,
        consoleLines,
      ]),
    ).not.toContain('GROUNDED');
  });

  /**
   * The compose's own reading that the text describes someone hurt, ill or in danger
   * (answer-request.ts). Through the real composer and the real lane the turn is answered
   * by the lane's safety door, and nothing the model wrote reaches the parent, the
   * ledger, the table of open questions or a log line. On a turn that would otherwise
   * have left its question open, so that "kept" has something it could have been.
   */
  it('sends, keeps and logs nothing the compose wrote when it read someone hurt', async () => {
    vi.stubEnv(GENERAL_ANSWER_SEARCH_ENABLED_ENV, 'true');
    const consoleLines: unknown[][] = [];
    for (const level of ['error', 'warn', 'info', 'log', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        consoleLines.push(args);
      });
    }
    const structured = (payload: unknown) => ({
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const client = () =>
      ({
        messages: {
          async create(request: { system: Array<{ text: string }> }) {
            const sanitizing = request.system
              .map((block) => block.text)
              .join('')
              .includes('Take the family out, keep the question');
            return structured(
              sanitizing
                ? {
                    language: 'en',
                    answers_pending: 'nothing_pending',
                    question: 'is it ok to let a child nap after a fall',
                    missing_detail: 'which city',
                    their_place: 'needed',
                    current_fact: 'none',
                    needs_search: 'missing_detail',
                  }
                : {
                    hurt_ill_or_danger: 'child-safety',
                    grounding: [{ states: 'MODEL-GROUNDED-THIS', from: 'settled' }],
                    answer: 'MODEL-WROTE-THIS',
                  },
            );
          },
        },
      }) as unknown as AgentClient;
    const lane = offDomainLane({
      screen: {
        read: async () => ({
          lane: 'off_domain_general',
          category: 'general-knowledge',
          fallback: null,
          language: null,
        }),
      },
      answer: createGeneralAnswer(client),
      today: async () => 'monday, oct 12, 2026',
      place: async () => ({ status: 'unknown', reason: 'no_postal' }),
      healthPlace: async () => null,
      pendingAsk: async () => ({ status: 'none' }),
      medical: {
        answer: async () => {
          throw new Error('not a medical turn');
        },
      },
      moment: {
        write: async () => ({ status: 'written', reply: 'moment wrote the safety reply' }),
      },
      recordUnmetIntent: async () => 'recorded',
    });
    const h = harness({
      context: { body: 'is it ok to let him nap, he fell off the top bunk' },
      offDomain: lane,
    });

    await routeChannelMessage(h.deps, job());

    const sent = ledgerRows(h.fake).filter((r) => r.direction === 'out');
    // Positive control: a reply did go out, it is the lane's own fixed line, and the
    // turn logged.
    expect(h.transport.bodies()).toEqual(['moment wrote the safety reply']);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ replySource: 'composed', body: null });
    expect(pendingAskRows(h.fake)).toEqual([]);
    expect(consoleLines.length).toBeGreaterThan(0);
    expect(
      JSON.stringify([
        h.transport.sent,
        ledgerRows(h.fake),
        pendingAskRows(h.fake),
        messageRows(h.fake),
        h.logs,
        consoleLines,
      ]),
    ).not.toMatch(/MODEL-WROTE|MODEL-GROUNDED/);
  });

  it('keeps no question on a reply that left none open, or on a coach answer', async () => {
    vi.stubEnv(GENERAL_ANSWER_SEARCH_ENABLED_ENV, 'true');
    const answered = harness({
      context: { body: "how's the weather" },
      offDomain: fakeLane(ANSWERED),
    });
    await routeChannelMessage(answered.deps, job());
    const coached = harness({ context: { body: 'what should we do this weekend' } });
    await routeChannelMessage(coached.deps, job());

    for (const h of [answered, coached]) {
      const sent = ledgerRows(h.fake).filter((r) => r.direction === 'out');
      expect(sent).toHaveLength(1);
      expect(pendingAskRows(h.fake)).toEqual([]);
    }
  });

  /** A question Hale left open was put to one parent, and is open as of this turn: the
   * lane is told whose text this is and what time the turn began. */
  it('tells the lane whose text it is, when the turn began and which thread it arrived in', async () => {
    const asked: unknown[] = [];
    const lane: OffDomainLane = {
      async consider(input) {
        asked.push(input);
        return IN_DOMAIN;
      },
    };
    const h = harness({ context: { body: 'Toronto' }, offDomain: lane });

    await routeChannelMessage(h.deps, job());

    expect(asked).toEqual([
      {
        familyId: FAMILY,
        parentUserId: PARENT,
        channelMessageId: job().channel_message_id,
        text: 'Toronto',
        now: NOW,
        thread: { channel: 'sms', providerChatId: null, inGroup: false },
        // Told what the screen read, for the holding line.
        onScreened: expect.any(Function),
      },
    ]);
  });

  /**
   * Sloane's finding 2. The lane ties a question it left open, and a family's home city,
   * to the thread a text arrived in, so it has to be told the chat and the door's own
   * group bit. The bit is the job's, not `context.inGroup`, which stays false while group
   * onboarding v2 is dark however many people are in the chat.
   */
  it.each([
    ["a parent's own iMessage chat", { in_group: false }, false],
    ['a group chat, with group onboarding v2 dark', { in_group: true }, true],
  ] as const)('tells the lane the chat and the group bit of %s', async (_label, said, inGroup) => {
    const threads: unknown[] = [];
    const lane: OffDomainLane = {
      async consider(input) {
        threads.push(input.thread);
        return IN_DOMAIN;
      },
    };
    const h = harness({
      context: {
        reply: { channel: 'imessage', to: PHONE, chatId: 'chat-7', replyToMessageId: null },
        inGroup: false,
      },
      offDomain: lane,
    });

    await routeChannelMessage(h.deps, job(said));

    expect(threads).toEqual([{ channel: 'imessage', providerChatId: 'chat-7', inGroup }]);
  });

  it('tells the lane the thread is unknown for a job that does not say, never that it is 1:1', async () => {
    const threads: Array<{ inGroup: boolean | undefined }> = [];
    const lane: OffDomainLane = {
      async consider(input) {
        threads.push(input.thread);
        return IN_DOMAIN;
      },
    };
    const h = harness({ offDomain: lane });
    const unsaid = job({ in_group: undefined });

    await routeChannelMessage(h.deps, unsaid);

    expect(threads).toEqual([{ channel: 'sms', providerChatId: null, inGroup: undefined }]);
    expect(threads[0]?.inGroup).toBeUndefined();
  });

  /** A coach turn's reply is not a deflection — no provenance stamp belongs on it. */
  it('leaves the reply source null on a coach answer', async () => {
    const coach = fakeCoach();
    const h = harness({ context: { body: 'what should we do this weekend' }, coach });

    await routeChannelMessage(h.deps, job());

    const sent = ledgerRows(h.fake).filter((r) => r.direction === 'out');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.replySource ?? null).toBeNull();
  });

  it('answers an off-domain text without ever waking the coach', async () => {
    const lane = fakeLane(ANSWERED);
    const coach = fakeCoach();
    const h = harness({ context: { body: "how's the weather" }, offDomain: lane, coach });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('deflected');
    expect(result.lane).toBe('off_domain_general');
    expect(coach.calls).toBe(0);
    expect(h.transport.bodies()).toEqual([ANSWERED.reply]);
  });

  it('hands an in-domain text straight on to the coach', async () => {
    const lane = fakeLane(IN_DOMAIN);
    const coach = fakeCoach();
    const h = harness({ context: { body: 'can you find swim classes' }, offDomain: lane, coach });

    const result = await routeChannelMessage(h.deps, job());

    expect(lane.calls).toBe(1);
    expect(coach.calls).toBe(1);
    expect(result.status).toBe('agent_replied');
    expect(result.lane).toBeNull();
  });

  /** A broken screen must never eat a real request. Every degraded path returns
   * `in_domain` carrying WHY, and the turn proceeds exactly as it did before this stage
   * existed (rule #11). */
  it('falls open to the coach when the screen could not run', async () => {
    const lane = fakeLane({ status: 'in_domain', fallback: 'model_failed' });
    const coach = fakeCoach();
    const h = harness({ offDomain: lane, coach });

    const result = await routeChannelMessage(h.deps, job());

    expect(coach.calls).toBe(1);
    expect(result.status).toBe('agent_replied');
  });

  /** The handlers own consent, receipts and filed facts. None of them may cost a model
   * call to reach, so a claimed message never reaches the screen at all. */
  it('is never consulted for a message a deterministic handler claims', async () => {
    const lane = fakeLane(ANSWERED);
    const h = harness({
      context: { body: 'yes' },
      handlers: [claimingHandler('approval', 'Approved.')],
      offDomain: lane,
    });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('handled');
    expect(lane.calls).toBe(0);
  });

  it('is never consulted once flood control has held the turn', async () => {
    const limiter = new FakeRateLimiter(() => NOW.getTime());
    const lane = fakeLane(ANSWERED);
    const h = harness({ offDomain: lane, limiter });
    for (let i = 0; i < AGENT_TURNS_PER_HOUR; i += 1) {
      await routeChannelMessage(h.deps, nthJob(i));
    }
    const consultedBefore = lane.calls;

    const overflow = await routeChannelMessage(h.deps, nthJob(AGENT_TURNS_PER_HOUR));

    expect(overflow.status).toBe('flood_held');
    expect(lane.calls).toBe(consultedBefore);
  });

  /** The screen reads the ledger body, not the queue payload, and it is stamped against
   * the row that body came from — the same id the router was handed. */
  it('screens the parent words and names the row to stamp', async () => {
    const lane = fakeLane(IN_DOMAIN);
    const h = harness({ context: { body: 'who is the prime minister' }, offDomain: lane });

    await routeChannelMessage(h.deps, job());

    expect(lane.seen).toEqual([
      { text: 'who is the prime minister', channelMessageId: job().channel_message_id },
    ]);
  });

  /** A deflection is a real message: it is threaded, ledgered and audited like any other
   * reply, because rule #6 is about the ACT of texting someone. */
  it('threads, ledgers and audits the deflection', async () => {
    const h = harness({ offDomain: fakeLane(ANSWERED) });

    await routeChannelMessage(h.deps, job());

    expect(messageRows(h.fake).map((r) => [r.role, r.content])).toEqual([
      ['user', 'anything indoors this weekend?'],
      ['assistant', ANSWERED.reply],
    ]);
    expect(ledgerRows(h.fake).filter((r) => r.direction === 'out')).toHaveLength(1);
    expect(auditRows(h.fake).map((r) => r.actionTaken)).toContain('sms_reply_sent');
  });

  /** Every deflect is counted, and counted WITHOUT the words that caused it: the lane
   * enum is the whole of what a log aggregator gets to hold (rule #1). */
  it('logs the lane on every deflect and never the message', async () => {
    const secret = 'is there a walk-in clinic for Mia near Dundas West';
    const h = harness({
      context: { body: secret },
      offDomain: fakeLane({
        status: 'deflected',
        lane: 'provider_access',
        category: 'doctor-access',
        reply: 'Finding you a doctor is not something I can do.',
        replySource: 'fixed',
        medicalSource: null,
        signal: 'recorded',
        pendingAsk: null,
      }),
    });

    await routeChannelMessage(h.deps, job());

    const dump = JSON.stringify(h.logs);
    expect(dump).toContain('provider_access');
    expect(dump).toContain('deflected');
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain('Mia');
  });

  /** A caregiver is answered by M6 and stops. The screen must not see a message from
   * someone we cannot vouch for as a parent — that is a disclosure to a model about a
   * household that never consented to it (rule #1). */
  it('never screens a caregiver', async () => {
    const lane = fakeLane(ANSWERED);
    const h = harness({ context: { role: 'nanny' }, offDomain: lane });

    await routeChannelMessage(h.deps, job());

    expect(lane.calls).toBe(0);
  });
});

// ── caregivers ───────────────────────────────────────────────────────────────

describe('a caregiver never reaches the agent', () => {
  for (const role of ['grandparent', 'nanny', 'babysitter'] as const) {
    it(`answers a ${role} with M6's scoped line and stops`, async () => {
      const handlers = [passingHandler('approval')];
      const coach = fakeCoach();
      const h = harness({ context: { role, body: 'what time is pickup?' }, handlers, coach });

      const result = await routeChannelMessage(h.deps, job());

      expect(result.status).toBe('not_a_parent');
      expect(coach.calls).toBe(0);
      expect(handlers[0]?.calls).toBe(0);
      expect(h.transport.bodies()).toEqual([scopedReply('Sam')]);
    });
  }

  /** No thread, either: a caregiver's message must not appear in the parents' Ask
   * history, which is what a conversation row would make it do (rule #1). */
  it('opens no conversation for a caregiver', async () => {
    const h = harness({ context: { role: 'nanny' } });
    await routeChannelMessage(h.deps, job());

    expect(conversationRows(h.fake)).toEqual([]);
    expect(messageRows(h.fake)).toEqual([]);
  });

  /** Rule #6 is about the ACT of texting someone, not about which thread it landed in.
   * The one reply that belongs to no conversation still gets its ledger + audit rows. */
  it('still ledgers and audits the line it sent', async () => {
    const h = harness({ context: { role: 'nanny' } });
    await routeChannelMessage(h.deps, job());

    const out = ledgerRows(h.fake).filter((r) => r.direction === 'out');
    expect(out).toHaveLength(1);
    expect(out[0]?.relatedConversationId).toBeNull();
    expect(auditRows(h.fake).map((r) => r.actionTaken)).toContain('sms_reply_sent');
  });

  /** The legacy buckets role-scope.ts gives an empty scope. Anyone we cannot vouch for
   * as a parent is answered as an outsider, never routed. */
  for (const role of ['extended', 'service'] as const) {
    it(`refuses to route a ${role} role`, async () => {
      const coach = fakeCoach();
      const h = harness({ context: { role }, coach });

      expect((await routeChannelMessage(h.deps, job())).status).toBe('not_a_parent');
      expect(coach.calls).toBe(0);
    });
  }

  it('refuses to route when the role cannot be resolved at all', async () => {
    const coach = fakeCoach();
    const h = harness({ context: { role: null }, coach });

    expect((await routeChannelMessage(h.deps, job())).status).toBe('not_a_parent');
    expect(coach.calls).toBe(0);
  });

  it('routes a co-parent like a primary parent', async () => {
    const coach = fakeCoach();
    const h = harness({ context: { role: 'co_parent' }, coach });

    expect((await routeChannelMessage(h.deps, job())).status).toBe('agent_replied');
    expect(coach.calls).toBe(1);
  });
});

// ── flood control ────────────────────────────────────────────────────────────

describe('flood control', () => {
  function flooded(): FakeRateLimiter {
    return new FakeRateLimiter(() => NOW.getTime());
  }

  it(`holds the agent after ${AGENT_TURNS_PER_HOUR} turns in the hour and says so gently`, async () => {
    const limiter = flooded();
    const coach = fakeCoach();
    const h = harness({ coach, limiter });

    for (let i = 0; i < AGENT_TURNS_PER_HOUR; i += 1) {
      expect((await routeChannelMessage(h.deps, nthJob(i))).status).toBe('agent_replied');
    }

    const overflow = await routeChannelMessage(h.deps, nthJob(AGENT_TURNS_PER_HOUR));
    expect(overflow.status).toBe('flood_held');
    expect(coach.calls).toBe(AGENT_TURNS_PER_HOUR);
    expect(h.transport.bodies().at(-1)).toBe('A lot came in at once.');
  });

  it('sends the flood line 1:1 on a family-group turn, never into the group', async () => {
    const groupRoute: ReplyRoute = {
      channel: 'imessage',
      to: PHONE,
      chatId: 'chat-family-group',
      replyToMessageId: 'in-1',
    };
    const spent = async (inGroup: boolean) => {
      const limiter = flooded();
      for (let i = 0; i < AGENT_TURNS_PER_HOUR; i += 1) {
        await limiter.check(PARENT, 'sms-agent-turn', {
          limit: AGENT_TURNS_PER_HOUR,
          windowSec: 3600,
        });
      }
      const coach = fakeCoach();
      const h = harness({ coach, limiter, context: { reply: groupRoute, inGroup } });
      const result = await routeChannelMessage(h.deps, job());
      return { result, coach, h };
    };

    const group = await spent(true);
    expect(group.result.status).toBe('flood_held');
    expect(group.coach.calls).toBe(0);
    expect(group.h.transport.sent).toEqual([{ route: SMS_ROUTE, body: 'A lot came in at once.' }]);

    // Positive control: the same over-budget turn outside the group answers where it came from.
    const direct = await spent(false);
    expect(direct.result.status).toBe('flood_held');
    expect(direct.h.transport.sent).toEqual([
      { route: groupRoute, body: 'A lot came in at once.' },
    ]);
  });

  /**
   * The cap is on AGENT turns, so a deterministic answer is never held. A parent whose
   * hour is spent must still be able to approve, decline, or say "done" — those cost
   * nothing and are the messages it matters most not to drop.
   */
  it('never holds a deterministic handler', async () => {
    const limiter = flooded();
    const coach = fakeCoach();
    const h = harness({ coach, limiter });
    for (let i = 0; i < AGENT_TURNS_PER_HOUR; i += 1) {
      await routeChannelMessage(h.deps, nthJob(i));
    }

    const claiming = claimingHandler('approval', 'Approved — add to your calendar.');
    const held = harness({
      context: { body: 'yes' },
      handlers: [claiming],
      coach,
      limiter,
    });
    const result = await routeChannelMessage(held.deps, job());

    expect(result.status).toBe('handled');
    expect(held.transport.bodies()).toEqual(['Approved — add to your calendar.']);
  });

  it('still threads the held turn — the parent said something and it is kept', async () => {
    const limiter = flooded();
    const h = harness({ limiter });
    for (let i = 0; i < AGENT_TURNS_PER_HOUR; i += 1) {
      await routeChannelMessage(h.deps, nthJob(i));
    }
    const before = messageRows(h.fake).length;

    await routeChannelMessage(h.deps, nthJob(AGENT_TURNS_PER_HOUR));
    expect(messageRows(h.fake).length).toBeGreaterThan(before);
  });
});

// ── the full-plan offer ──────────────────────────────────────────────────────

describe('an offered full plan', () => {
  function offeringCoach(): ChannelCoachRuntime {
    return {
      async respond() {
        return {
          reply: 'Most 2-year-olds wake once or twice. Want me to send the full plan?',
          activityPromise: null,
          spotWatch: null,
          planOffer: {
            topic: 'sleep',
            childId: null,
            sentence: 'Want me to send the full plan?',
          },
        };
      },
    };
  }

  it('is written down against the ledger row that actually carried it', async () => {
    const offers: Array<{ channelMessageId: string | null; offer: unknown }> = [];
    const h = harness({
      coach: offeringCoach(),
      recordPlanOffer: async (_db, input) => {
        offers.push({ channelMessageId: input.channelMessageId, offer: input.offer });
        return { status: 'recorded' as const };
      },
    });

    await routeChannelMessage(h.deps, job());

    // The MEM-10 send-time discipline: the promise points at the outbound row, so the
    // receipts surface can show the parent the message rather than Hale's word for it.
    const outbound = ledgerRows(h.fake).filter((row) => row.direction === 'out');
    expect(outbound).toHaveLength(1);
    expect(offers).toEqual([
      {
        channelMessageId: outbound[0]?.id,
        offer: {
          topic: 'sleep',
          childId: null,
          sentence: 'Want me to send the full plan?',
        },
      },
    ]);
  });

  it('is not written when the turn failed before anything was sent', async () => {
    const offers: unknown[] = [];
    const failing: ChannelCoachRuntime = {
      async respond() {
        throw new Error('provider timeout');
      },
    };
    const h = harness({
      coach: failing,
      recordPlanOffer: async (_db, input) => {
        offers.push(input);
        return { status: 'recorded' as const };
      },
    });

    const result = await routeChannelMessage(h.deps, job());

    // Nobody was offered anything, so nobody is owed anything. A debt minted here would
    // sit in the founder's overdue column for a sentence that never existed.
    expect(result.status).toBe('agent_failed');
    expect(offers).toEqual([]);
  });

  it('costs the parent nothing when the coach promised nothing', async () => {
    const offers: unknown[] = [];
    const h = harness({
      coach: fakeCoach(),
      recordPlanOffer: async (_db, input) => {
        offers.push(input);
        return { status: 'recorded' as const };
      },
    });

    await routeChannelMessage(h.deps, job());

    // The overwhelmingly common turn. `planOffer: null` means one thing and the router
    // must not translate it into a query, a row, or a write.
    expect(offers).toEqual([]);
  });
});

// ── slow turns and failures ──────────────────────────────────────────────────

describe('slow turns', () => {
  /** A deferred coach + an already-elapsed timer is the only deterministic way to
   * describe "the agent is taking too long" without sleeping in a test. */
  function deferredCoach(): ChannelCoachRuntime & { release: (reply: string) => void } {
    let resolve!: (value: ChannelTurnResult) => void;
    const pending = new Promise<ChannelTurnResult>((r) => {
      resolve = r;
    });
    return {
      respond: () => pending,
      release: (reply: string) =>
        resolve({ reply, planOffer: null, activityPromise: null, spotWatch: null }),
    };
  }

  it('a slow turn sends exactly one message: the answer', async () => {
    // The ack died 2026-08-13 (founder decision): silence, then the answer. The
    // positive control is the released reply itself — this test cannot pass vacuously.
    const coach = deferredCoach();
    const h = harness({
      coach,
    });

    const run = routeChannelMessage(h.deps, job());
    expect(h.transport.bodies()).toEqual([]);
    coach.release('Saturday is dry — the splash pad is open.');

    expect((await run).status).toBe('agent_replied');
    expect(h.transport.bodies()).toEqual(['Saturday is dry — the splash pad is open.']);
  });
});

/**
 * A turn that broke on a BUG, with the provider up the whole time — the `defect` branch.
 *
 * The twelve-word constant that used to answer every one of these is gone from this path
 * (founder doctrine, 2026-08-12: no preset bodies). What goes out is composed by a model
 * that is demonstrably reachable, because that is exactly what `defect` means: the coach
 * broke on something that was not the provider being absent.
 */
describe('failure honesty', () => {
  const throwingCoach: ChannelCoachRuntime = {
    respond: async () => {
      throw new Error('cannot read properties of undefined');
    },
  };

  it('sends the composed apology, not a stock sentence', async () => {
    const apology = fakeApology();
    const h = harness({ coach: throwingCoach, apology });
    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('agent_failed');
    expect(apology.calls).toBe(1);
    expect(h.transport.bodies()).toEqual([APOLOGY]);
  });

  /** The line this replaced. Its own module still exports it for the approvals conflict
   * path, so the guarantee has to be about the FAILED TURN, not about the function. */
  it('never recites the old preset on a failed turn', async () => {
    const h = harness({ coach: throwingCoach });
    await routeChannelMessage(h.deps, job());

    expect(h.transport.bodies()).not.toContain(
      'Something went wrong on my end - nothing was changed. Try me again in a minute.',
    );
  });

  it('never leaves the parent with silence OR a fabricated success', async () => {
    const h = harness({ coach: throwingCoach });
    await routeChannelMessage(h.deps, job());

    const assistantTurns = messageRows(h.fake).filter((r) => r.role === 'assistant');
    expect(assistantTurns).toHaveLength(1);
    expect(assistantTurns[0]?.content).toBe(APOLOGY);
  });

  it('still answers after an ack has already gone out', async () => {
    const h = harness({
      coach: throwingCoach,
    });
    await routeChannelMessage(h.deps, job());

    expect(h.transport.bodies().at(-1)).toBe(APOLOGY);
  });

  /**
   * The composer is the LAST thing that can speak, so a composer that cannot speak must
   * not leave the parent with a stock sentence — there isn't one any more. The turn goes
   * back to the queue instead, and the re-drive may well not need an apology at all.
   */
  it.each([
    ['the model went down mid-apology', { status: 'unreachable' } as const, 'model_unreachable'],
    [
      'the gates refused every attempt',
      { status: 'unavailable', reason: 'gate_exhausted' } as const,
      'gate_exhausted',
    ],
    [
      'no client to compose with',
      { status: 'unavailable', reason: 'client_unavailable' } as const,
      'client_unavailable',
    ],
  ])('defers the turn when %s', async (_name, outcome, reason) => {
    const h = harness({ coach: throwingCoach, apology: fakeApology(outcome) });

    await expect(routeChannelMessage(h.deps, job())).rejects.toBeInstanceOf(TurnDeferred);
    expect(h.transport.bodies()).toEqual([]);
    expect(JSON.stringify(h.logs)).toContain(reason);
  });

  /**
   * VIL-260 · WS4 — the turn broke AFTER the drafts were committed. "Nothing was
   * changed" is then a false statement about rows already sitting in the approvals
   * queue, and it leaves them orphaned: the parent does not know they exist, so the
   * next unrelated "yes" is what finds them.
   */
  describe('when the turn failed AFTER it drafted', () => {
    function draftingThenFailingCoach(count: number): ChannelCoachRuntime {
      return {
        respond: async () => {
          throw new ChannelTurnFailed('channel coach: agent hit maxSteps without an answer', {
            cause: new Error('maxSteps'),
            draftedActionIds: Array.from({ length: count }, (_, i) => `action-${i + 1}`),
          });
        },
      };
    }

    /**
     * The parent sees whatever the consent writer returns from the count. This
     * harness writer is a double, so the assertion is that the router sends that
     * return value and does not also apologize. Production writes with the model.
     */
    it('names the drafts that are waiting instead of claiming nothing changed', async () => {
      const apology = fakeApology();
      const h = harness({ coach: draftingThenFailingCoach(2), apology });

      const result = await routeChannelMessage(h.deps, job());

      expect(result.status).toBe('agent_failed');
      expect(h.transport.bodies()).toEqual([
        writtenAsk({ kind: 'partial_failure', draftCount: 2 }),
      ]);
      expect(apology.calls).toBe(0);
      expect(writtenAsk({ kind: 'partial_failure', draftCount: 2 })).toMatch(/2 changes/);
      expect(writtenAsk({ kind: 'partial_failure', draftCount: 2 })).not.toMatch(
        /nothing was changed/i,
      );
      expect(writtenAsk({ kind: 'partial_failure', draftCount: 1 })).toMatch(/1 change\b/);
    });

    /** The longest line the router sends. A typographic dash in it would flip the
     * message to UCS-2 (70 chars a segment) and cost three segments instead of one —
     * the same rule the coach skill states, and the reason this copy is plain ASCII. */
    it('costs one GSM-7 segment', () => {
      const body = writtenAsk({ kind: 'partial_failure', draftCount: 2 });
      expect(smsEncoding(body)).toBe('gsm7');
      expect(smsSegments(body)).toBe(1);
    });

    it('composes the apology when the turn drafted nothing', async () => {
      const apology = fakeApology();
      const h = harness({ coach: draftingThenFailingCoach(0), apology });
      await routeChannelMessage(h.deps, job());

      expect(h.transport.bodies()).toEqual([APOLOGY]);
      expect(apology.calls).toBe(1);
    });
  });
});

/**
 * VIL-524. A withheld or unjudged find draft throws into this same path. The
 * parent hears a model written from facts (the situation, or a draft count),
 * and a writer that cannot write sends nothing. The withheld draft is not a
 * fact on that request.
 */
describe('a withheld find on the failed-turn path (VIL-524)', () => {
  const FIND_TOKEN = 'storytime-9f3a';
  const WITHHELD_DRAFT = `All three finds share one page. EarlyON at the library, ref ${FIND_TOKEN}.`;
  const parentBody = `what's on this weekend near ${FIND_TOKEN}`;
  const APOLOGY_BODY = 'Hale dropped that one and nothing changed.';
  const RECEIPT_BODY = 'Holding the drafts until you say which.';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function quiet() {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  }

  function findCoach(input: {
    gate: FindReplyGate;
    draftIds?: readonly string[];
  }): ChannelCoachRuntime {
    const skill: Skill = {
      meta: { name: 'coach-channel-sms', whenToUse: 'x', task: 'converse', tools: [] },
      instructions: 'be terse',
    };
    return channelCoachRuntime({
      loadSkill: async () => skill,
      loadTranscript: async () => [],
      loadContext: async (ctx) =>
        ({
          question: ctx.question,
          transcript: ctx.transcript,
          memoryFacts: [],
          location: { city: null, province: null, country: 'Canada' },
        }) as never,
      loadChildren: async () => [],
      loadRegistrationWindows: async () => [],
      buildTools: (_turn, onDraft) => {
        for (const id of input.draftIds ?? []) onDraft(id);
        return [] as RegisteredTool[];
      },
      nearbySaid: async () => null,
      guardDeps: { async writeAudit() {} },
      client: () => ({ messages: {} }) as AgentClient,
      readFindTurn: async () => ({ findTurn: true }),
      judgeFindReply: async () => input.gate,
      runAgent: async () => ({
        answer: WITHHELD_DRAFT,
        steps: 1,
        hitMaxSteps: false,
        truncatedRetries: 0,
        truncated: false,
        usage: {
          promptTokens: 10,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          completionTokens: 5,
        },
      }),
      recordRun: async () => {},
      now: () => NOW,
    });
  }

  interface Captured {
    system?: unknown;
    messages?: Array<{ role: string; content: string }>;
  }

  function recordingClient(payload: Record<string, string>, seen: Captured[]): () => AgentClient {
    return () =>
      ({
        messages: {
          async create(request: Captured) {
            seen.push({ system: request.system, messages: request.messages });
            return {
              content: [{ type: 'text', text: JSON.stringify(payload) }],
              usage: { input_tokens: 10, output_tokens: 5 },
              stop_reason: 'end_turn',
            };
          },
        },
      }) as unknown as AgentClient;
  }

  function failingClient(): () => AgentClient {
    return () =>
      ({
        messages: {
          create: async () => {
            throw new Error('writer down');
          },
        },
      }) as unknown as AgentClient;
  }

  function userFacts(seen: Captured[]): unknown[] {
    return seen.map((call) => JSON.parse(call.messages?.[0]?.content ?? 'null'));
  }

  /** The whole request the writer sent, system and user. Facts, not the reply. */
  function assertNoFindFacts(seen: Captured[]) {
    const raw = JSON.stringify(seen);
    expect(raw).not.toContain(FIND_TOKEN);
    expect(raw).not.toContain(WITHHELD_DRAFT);
    expect(raw).not.toContain('find_reasoning');
    expect(raw).not.toContain('judge_failed');
  }

  const gates: FindReplyGate[] = [
    { verdict: 'withhold' },
    { verdict: 'unjudged', reason: 'judge_failed' },
  ];

  it.each(gates)('apology writer input is only the situation (%j)', async (gate) => {
    quiet();
    const seen: Captured[] = [];
    const asks: unknown[] = [];
    const h = harness({
      context: { body: parentBody },
      coach: findCoach({ gate }),
      apology: createTurnApology(recordingClient({ apology: APOLOGY_BODY }, seen)),
      consentAsk: {
        write: async (ask) => {
          asks.push(ask);
          return RECEIPT_BODY;
        },
      },
    });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('agent_failed');
    expect(h.transport.bodies()).toEqual([APOLOGY_BODY]);
    expect(asks).toEqual([]);
    expect(userFacts(seen)).toEqual([{ situation: 'turn_failed_nothing_changed' }]);
    assertNoFindFacts(seen);
  });

  it.each(gates)('drafts receipt writer input is only the count (%j)', async (gate) => {
    quiet();
    const seen: Captured[] = [];
    const apology = fakeApology();
    const h = harness({
      context: { body: parentBody },
      coach: findCoach({
        gate,
        draftIds: [`draft-${FIND_TOKEN}-1`, `draft-${FIND_TOKEN}-2`],
      }),
      apology,
      consentAsk: createConsentAskWriter(recordingClient({ text: RECEIPT_BODY }, seen)),
    });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('agent_failed');
    expect(h.transport.bodies()).toEqual([RECEIPT_BODY]);
    expect(apology.calls).toBe(0);
    expect(userFacts(seen)).toEqual([{ kind: 'partial_failure', draftCount: 2 }]);
    assertNoFindFacts(seen);
  });

  it('sends nothing when the apology writer fails', async () => {
    quiet();
    const h = harness({
      context: { body: parentBody },
      coach: findCoach({ gate: { verdict: 'withhold' } }),
      apology: createTurnApology(failingClient()),
    });

    await expect(routeChannelMessage(h.deps, job())).rejects.toBeInstanceOf(TurnDeferred);
    expect(h.transport.bodies()).toEqual([]);
    expect(messageRows(h.fake).filter((row) => row.role === 'assistant')).toEqual([]);
  });

  it('sends nothing when the drafts receipt writer fails', async () => {
    quiet();
    const apology = fakeApology();
    const h = harness({
      context: { body: parentBody },
      coach: findCoach({
        gate: { verdict: 'unjudged', reason: 'judge_failed' },
        draftIds: [`draft-${FIND_TOKEN}`],
      }),
      apology,
      consentAsk: createConsentAskWriter(failingClient()),
    });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('agent_failed');
    expect(apology.calls).toBe(0);
    expect(h.transport.bodies()).toEqual([]);
    expect(messageRows(h.fake).filter((row) => row.role === 'assistant')).toEqual([]);
    expect(JSON.stringify(h.logs)).toContain('unwritten');
  });
});

// ── defer and re-drive ───────────────────────────────────────────────────────

/**
 * THE ARC. When the model API is unreachable, the parent gets NOTHING now and the real
 * composed reply when it comes back — rather than an apology that is punctual, canned,
 * and about a question Hale never read.
 *
 * The mechanism is the queue's, not this module's: the turn is thrown back so the drain
 * fails rather than completes the job (lib/cron/drain.ts), and pg-boss re-drives it with
 * exponential backoff up to a bounded ceiling (lib/channel/config.ts). What is asserted
 * here is the router's half — that it says nothing, throws, and does not spend the
 * parent's budget or thread twice on the way.
 */
describe('deferring a turn the provider cannot answer', () => {
  function outageCoach(): ChannelCoachRuntime {
    return {
      respond: async () => {
        throw new ChannelTurnFailed('channel coach: agent loop failed', {
          cause: new Anthropic.APIConnectionError({ message: 'Connection error.' }),
          draftedActionIds: [],
        });
      },
    };
  }

  it('sends nothing and hands the job back to the queue', async () => {
    const apology = fakeApology();
    const h = harness({ coach: outageCoach(), apology });

    await expect(routeChannelMessage(h.deps, job())).rejects.toBeInstanceOf(TurnDeferred);

    expect(h.transport.sent).toEqual([]);
    expect(messageRows(h.fake).filter((r) => r.role === 'assistant')).toEqual([]);
    // No apology is even attempted: there is no model up to write one.
    expect(apology.calls).toBe(0);
  });

  it('names the deferral on the log without carrying the body (rule #1, #11)', async () => {
    const secret = 'Mia has a therapy appointment on Thursday';
    const h = harness({ context: { body: secret }, coach: outageCoach() });

    await expect(routeChannelMessage(h.deps, job())).rejects.toThrow();

    const dump = JSON.stringify(h.logs);
    expect(dump).toContain('model_unreachable');
    expect(dump).not.toContain(secret);
  });

  it('records the deferral so the re-drive knows what it already paid for', async () => {
    const h = harness({ coach: outageCoach() });

    await expect(routeChannelMessage(h.deps, job())).rejects.toThrow();

    expect(h.turns.deferred).toEqual([job().channel_message_id]);
    expect(h.turns.answered).toEqual([]);
  });

  /**
   * A 400 credit-balance failure is not `model_unreachable` (that list is 5xx
   * and a dropped connection). The turn is deferred as model_failed, nothing
   * is sent, and the ledger carries the billing class so #ops can page it.
   * The provider's sentence stays off the log and off the ledger.
   */
  it('records a billing failure on the deferral and sends nothing', async () => {
    const secret = 'the secret phrase about nap time';
    const credit =
      'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';
    const h = harness({
      context: { body: secret },
      coach: {
        respond: async () => {
          throw new ChannelTurnFailed('channel coach: agent loop failed', {
            cause: Anthropic.APIError.generate(
              400,
              {
                type: 'error',
                error: { type: 'invalid_request_error', message: credit },
              },
              undefined,
              {},
            ),
            draftedActionIds: [],
          });
        },
      },
      apology: fakeApology({ status: 'unavailable', reason: 'model_failed' }),
    });

    await expect(routeChannelMessage(h.deps, job())).rejects.toBeInstanceOf(TurnDeferred);

    expect(h.transport.sent).toEqual([]);
    expect(h.turns.deferredReasons).toEqual([
      expect.objectContaining({
        channelMessageId: job().channel_message_id,
        providerFailure: 'billing',
      }),
    ]);
    const dump = JSON.stringify(h.logs);
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain(credit);
    expect(dump).not.toContain('credit balance');
  });

  /**
   * The parent's words go into the thread ONCE, however many times the outage hands the
   * turn back. Nine copies of the same question is a transcript that lies to the coach
   * that reads it on the attempt that finally works.
   */
  it("does not thread the parent's message again on a re-drive", async () => {
    const turns = fakeTurnLedger();
    const h = harness({ coach: outageCoach(), turns });

    await expect(routeChannelMessage(h.deps, job())).rejects.toThrow();
    await expect(routeChannelMessage(h.deps, job())).rejects.toThrow();
    await expect(routeChannelMessage(h.deps, job())).rejects.toThrow();

    expect(messageRows(h.fake).filter((r) => r.role === 'user')).toHaveLength(1);
  });

  /**
   * Nor does it spend the hourly agent budget again. `limiter.check` COUNTS as it
   * decides, so a turn deferred eight times would eat almost half a parent's hour — and
   * the reply they were waiting for would arrive as the flood line.
   */
  it('does not spend the hourly budget again on a re-drive', async () => {
    const limiter = countingLimiter();
    const h = harness({ coach: outageCoach(), limiter });

    for (let i = 0; i < 3; i += 1) {
      await expect(routeChannelMessage(h.deps, job())).rejects.toThrow();
    }

    expect(limiter.checks).toBe(1);
  });

  /**
   * The screen, by contrast, DOES run again — deliberately. It fails open during an
   * outage (off-domain/screen.ts), so the deterministic safety lane never got to
   * classify; re-running the whole pipeline is what lets that classification self-heal
   * the moment the provider comes back.
   */
  it('re-runs the off-domain screen on the re-drive so safety classification self-heals', async () => {
    const lane = fakeLane(IN_DOMAIN);
    const h = harness({ coach: outageCoach(), offDomain: lane });

    await expect(routeChannelMessage(h.deps, job())).rejects.toThrow();
    await expect(routeChannelMessage(h.deps, job())).rejects.toThrow();

    expect(lane.calls).toBe(2);
  });

  /** The re-drive that finally lands: the model is back, the coach answers, and what the
   * parent gets is the real reply to the text they sent two hours ago. */
  it('answers for real once the provider returns', async () => {
    const turns = fakeTurnLedger();
    const down = harness({ coach: outageCoach(), turns });
    await expect(routeChannelMessage(down.deps, job())).rejects.toThrow();

    const up = harness({ coach: fakeCoach('Saturday is dry - the splash pad is open.'), turns });
    const result = await routeChannelMessage(up.deps, job());

    expect(result.status).toBe('agent_replied');
    expect(up.transport.bodies()).toEqual(['Saturday is dry - the splash pad is open.']);
  });
});

// ── at most one answer per text ──────────────────────────────────────────────

/**
 * At-least-once TURNS, at-most-once ANSWERS.
 *
 * The drain hands the same job back after any crash, and the defer arc means it does so
 * routinely rather than rarely. Every path out of this router therefore claims the
 * answer the instant the transport accepts it, and the claim is read before anything
 * else happens.
 */
describe('back-to-back texts read as one turn', () => {
  const IMESSAGE: ReplyRoute = {
    channel: 'imessage',
    to: PHONE,
    chatId: 'chat-1',
    replyToMessageId: 'SM1',
  };
  const ANCHOR_ID = job().channel_message_id;
  const photo = { kind: 'image' as const, url: 'https://example.test/p.jpg', mime: 'image/jpeg' };
  const members: BurstMember[] = [
    {
      channelMessageId: ANCHOR_ID,
      providerMessageId: 'SM1',
      body: '$600 budget for a fall program',
      media: [],
      createdAt: NOW,
    },
    {
      channelMessageId: '33333333-3333-4333-8333-000000000002',
      providerMessageId: 'SM2',
      body: '$900',
      media: [photo],
      createdAt: NOW,
    },
  ];
  const anchorPlan = (
    overrides: Partial<Extract<BurstPlan, { kind: 'anchor' }>> = {},
  ): BurstPlan => ({
    kind: 'anchor',
    members,
    replyTo: members[1] as BurstMember,
    waitedMs: 0,
    read: 'read',
    ...overrides,
  });

  function capturingCoach(reply = 'Looking within $900.') {
    const turns: ChannelTurn[] = [];
    const coach: ChannelCoachRuntime = {
      async respond(turn) {
        turns.push(turn);
        return { reply, planOffer: null, activityPromise: null, spotWatch: null };
      },
    };
    return { coach, turns };
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('a text an earlier turn already read stops at GATE 0: nothing threaded, counted or sent', async () => {
    const turns = fakeTurnLedger();
    turns.folded.push(ANCHOR_ID);
    const limiter = countingLimiter();
    const burst = fakeBurst(anchorPlan());
    const { coach, turns: coached } = capturingCoach();
    const h = harness({ turns, limiter, burst, coach });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('folded');
    expect(messageRows(h.fake)).toEqual([]);
    expect(limiter.checks).toBe(0);
    expect(h.transport.sent).toEqual([]);
    expect(coached).toEqual([]);
    expect(burst.stages).toEqual([]);
  });

  it('positive control: the turn that read them counts the limiter once and answers once', async () => {
    const limiter = countingLimiter();
    const h = harness({ limiter, burst: fakeBurst(anchorPlan()), context: { reply: IMESSAGE } });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('agent_replied');
    expect(limiter.checks).toBe(1);
    expect(h.transport.sent).toHaveLength(1);
  });

  it('every gate and the coach read the whole burst, and the answer threads under the latest text', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('LINQ_MESSAGE_EDIT_ENABLED', 'true');
    const handler = passingHandler('watcher');
    const lane = fakeLane(IN_DOMAIN);
    const { coach, turns } = capturingCoach();
    const h = harness({
      burst: fakeBurst(anchorPlan()),
      handlers: [handler],
      offDomain: lane,
      coach,
      context: { body: '$600 budget for a fall program', reply: IMESSAGE },
    });

    await routeChannelMessage(h.deps, job());

    expect(handler.bodies).toEqual(['$600 budget for a fall program\n$900']);
    expect(lane.seen.map((seen) => seen.text)).toEqual(['$600 budget for a fall program\n$900']);
    expect(turns[0]?.body).toBe('$600 budget for a fall program\n$900');
    expect(turns[0]?.inboundMedia).toEqual([photo]);
    expect(turns[0]?.burstSize).toBe(2);
    expect(h.transport.sent[0]?.route).toEqual({ ...IMESSAGE, replyToMessageId: 'SM2' });
    // One thread row per text, in order, each with its own bubble id; never the joined body.
    expect(
      messageRows(h.fake)
        .filter((row) => row.role === 'user')
        .map((row) => [row.content, row.providerMessageId]),
    ).toEqual([
      ['$600 budget for a fall program', 'SM1'],
      ['$900', 'SM2'],
    ]);
  });

  it('a lone text keeps today’s turn: one thread row, no burst size for the coach', async () => {
    const { coach, turns } = capturingCoach();
    const burst = fakeBurst({ kind: 'lone', waitedMs: 0, why: 'alone' });
    const h = harness({ burst, coach });

    await routeChannelMessage(h.deps, job());

    expect(burst.stages).toEqual(['fresh']);
    expect(turns[0]).not.toHaveProperty('burstSize');
    expect(
      messageRows(h.fake)
        .filter((row) => row.role === 'user')
        .map((row) => row.content),
    ).toEqual(['anything indoors this weekend?']);
  });

  it('a re-driven anchor asks for its earlier burst and threads none of it again', async () => {
    const turns = fakeTurnLedger();
    turns.deferred.push(ANCHOR_ID);
    const limiter = countingLimiter();
    const burst = fakeBurst(anchorPlan({ read: 'decided_earlier' }));
    const { coach, turns: coached } = capturingCoach();
    const h = harness({ turns, limiter, burst, coach });

    await routeChannelMessage(h.deps, job());

    expect(burst.stages).toEqual(['deferred']);
    expect(messageRows(h.fake).filter((row) => row.role === 'user')).toEqual([]);
    expect(limiter.checks).toBe(0);
    expect(coached[0]?.body).toBe('$600 budget for a fall program\n$900');
  });

  it('logs the plan with ids and enums only', async () => {
    const h = harness({ burst: fakeBurst(anchorPlan({ waitedMs: 1_200 })) });

    await routeChannelMessage(h.deps, job());

    const line = h.logs.find((entry) => (entry as unknown[])[1] === 'channel router: burst') as
      | [Record<string, unknown>, string]
      | undefined;
    expect(line?.[0]).toMatchObject({
      channelMessageId: ANCHOR_ID,
      burstSize: 2,
      settleWaitMs: 1_200,
      readOutcome: 'read',
    });
    expect(typeof line?.[0].pickupMs).toBe('number');
    expect(JSON.stringify(h.logs)).not.toContain('$900');
  });

  describe('the holding line waits the same from the parent’s side', () => {
    function slowCoach(ms: number): ChannelCoachRuntime {
      return {
        async respond() {
          await new Promise((resolve) => setTimeout(resolve, ms));
          return { reply: 'the answer', planOffer: null, activityPromise: null, spotWatch: null };
        },
      };
    }

    beforeEach(() => {
      vi.stubEnv(HOLDING_LINE_ENABLED_ENV, 'true');
    });

    it.each([
      // base 300ms: a turn that settled 260ms owes the line 40ms in, before a 150ms coach.
      ['a settled turn arms it for what is left of the wait', 260, ["I'm on it.", 'the answer']],
      // nothing settled: 300ms is past the 150ms coach, so the answer comes first.
      ['a turn that settled nothing keeps the whole wait', 0, ['the answer']],
      // past the base: floored at 0, never negative.
      ['a settle longer than the wait floors it at 0', 5_000, ["I'm on it.", 'the answer']],
    ])('%s', async (_name, waitedMs, bodies) => {
      const h = harness({
        burst: fakeBurst({ kind: 'lone', waitedMs, why: 'alone' }),
        coach: slowCoach(150),
        holdingLine: fakeHoldingLine("I'm on it."),
        holdingLineAfterMs: 300,
        context: { reply: IMESSAGE },
      });

      await routeChannelMessage(h.deps, job());

      expect(h.transport.bodies()).toEqual(bodies);
    });
  });
});

describe('a re-driven turn never answers twice', () => {
  it('does nothing at all when this text has already been answered', async () => {
    const turns = fakeTurnLedger();
    const coach = fakeCoach('Splash pad opens at 10.');
    const first = harness({ coach, turns });

    expect((await routeChannelMessage(first.deps, job())).status).toBe('agent_replied');

    const second = harness({ coach, turns });
    const result = await routeChannelMessage(second.deps, job());

    expect(result.status).toBe('already_answered');
    expect(second.transport.sent).toEqual([]);
    expect(coach.calls).toBe(1);
    expect(messageRows(second.fake)).toEqual([]);
  });

  /**
   * The hazard the claim exists for, played out: the turn answers, then dies on a
   * bookkeeping write. Without the claim it answers AGAIN in the same turn (the catch
   * would compose an apology for a text the parent already has) and AGAIN on the
   * re-drive — three of Hale's messages for one of theirs.
   *
   * The claim is written between the transport accepting and the first record for
   * exactly this reason: the send is the irreversible act, and everything after it is
   * bookkeeping that a missing row makes reconcilable rather than a second text, which
   * nothing makes reconcilable. The gap is logged rather than swallowed.
   */
  it('sends exactly one reply when the turn crashes AFTER the send', async () => {
    const turns = fakeTurnLedger();
    const coach = fakeCoach('Splash pad opens at 10.');

    const crashed = harness({ coach, turns });
    // The audit row (rule #6) is written AFTER the transport has accepted the reply, so
    // a failure there is a turn that has already texted the parent.
    const realDb = crashed.deps.database;
    const realInsert = realDb.insert.bind(realDb);
    crashed.deps.database = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop !== 'insert') return Reflect.get(target, prop, receiver);
        return (table: Parameters<typeof realInsert>[0]) => {
          if (table === schema.auditLog) throw new Error('audit insert failed');
          return realInsert(table);
        };
      },
    });

    await routeChannelMessage(crashed.deps, job());
    expect(crashed.transport.bodies()).toEqual(['Splash pad opens at 10.']);
    expect(JSON.stringify(crashed.logs)).toContain('brokeAfterAnswering');

    const redriven = harness({ coach, turns });
    const result = await routeChannelMessage(redriven.deps, job());

    expect(result.status).toBe('already_answered');
    expect(redriven.transport.sent).toEqual([]);
  });

  /**
   * The claim itself is the transaction. When that transaction throws after the
   * carrier has accepted the reply (UNSAFE_TRANSACTION, every turn, while
   * max_pipeline was 0), the turn used to die in disposeOfFailedTurn as
   * broke_after_answering before the outbound row and the assistant thread row
   * existed. Hale had texted, and then could not see its own reply. The ledger
   * failure is logged; the receipt is still written, outside that transaction.
   */
  it('keeps the outbound row and the assistant message when the answer ledger throws after the send', async () => {
    const turns = fakeTurnLedger();
    turns.recordAnswered = async () => {
      throw new Error('UNSAFE_TRANSACTION');
    };
    const coach = fakeCoach('Splash pad opens at 10.');
    const h = harness({ coach, turns });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('agent_replied');
    expect(h.transport.bodies()).toEqual(['Splash pad opens at 10.']);
    expect(ledgerRows(h.fake).filter((row) => row.direction === 'out')).toHaveLength(1);
    expect(messageRows(h.fake).map((row) => [row.role, row.content])).toEqual([
      ['user', 'anything indoors this weekend?'],
      ['assistant', 'Splash pad opens at 10.'],
    ]);
    expect(JSON.stringify(h.logs)).toContain('the reply landed; the answer ledger did not');
    expect(JSON.stringify(h.logs)).not.toContain('brokeAfterAnswering');
  });

  it('#973: an empty coach turn is claimed answered, sends nothing, and a redelivery never reruns the coach', async () => {
    const turns = fakeTurnLedger();
    const coach = fakeCoach('');
    const first = harness({ coach, turns });
    expect((await routeChannelMessage(first.deps, job())).status).toBe('agent_silent');
    expect(first.transport.sent).toEqual([]);

    const rerun = fakeCoach('should never run');
    const second = harness({ coach: rerun, turns });
    expect((await routeChannelMessage(second.deps, job())).status).toBe('already_answered');
    expect(second.transport.sent).toEqual([]);
  });

  it('claims the caregiver line too — it is an answer like any other', async () => {
    const turns = fakeTurnLedger();
    const first = harness({ context: { role: 'nanny' }, turns });
    expect((await routeChannelMessage(first.deps, job())).status).toBe('not_a_parent');
    expect(first.transport.sent).toHaveLength(1);

    const second = harness({ context: { role: 'nanny' }, turns });
    expect((await routeChannelMessage(second.deps, job())).status).toBe('already_answered');
    expect(second.transport.sent).toEqual([]);
  });

  /**
   * An outage turn sends NOTHING (the ack is gone), defers with the claim unwritten,
   * and the re-drive that finally works answers for real.
   */
  it('an outage turn defers in silence, claiming nothing', async () => {
    const turns = fakeTurnLedger();
    let reject!: (err: unknown) => void;
    const h = harness({
      turns,
      coach: {
        respond: () =>
          new Promise<ChannelTurnResult>((_, r) => {
            reject = r;
          }),
      },
    });

    const run = routeChannelMessage(h.deps, job());
    // respond() is only invoked once the router reaches the coach, so wait for it.
    await vi.waitFor(() => expect(typeof reject).toBe('function'));
    reject(
      new ChannelTurnFailed('channel coach: agent loop failed', {
        cause: new Anthropic.APIConnectionError({ message: 'Connection error.' }),
        draftedActionIds: [],
      }),
    );

    await expect(run).rejects.toBeInstanceOf(TurnDeferred);
    expect(h.transport.bodies()).toEqual([]);
    expect(turns.answered).toEqual([]);
    expect(turns.deferred).toEqual([job().channel_message_id]);
  });
});

describe('a receipt sent as several bubbles', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A handler whose receipt is two bubbles, recording each afterSend call. */
  function twoBubbles() {
    const after: string[] = [];
    const handler: DeterministicHandler = {
      name: 'two_bubbles',
      handle: async () => ({
        claimed: true,
        outcome: 'asked',
        reply: 'Swim opens at 7.',
        replies: ['Swim opens at 7.', 'https://example.test/l/abc'],
        afterSend: async (channelMessageId: string) => {
          after.push(channelMessageId);
        },
      }),
    };
    return { handler, after };
  }

  it('runs afterSend once the first bubble reached the parent, though a later one fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { handler, after } = twoBubbles();
    const h = harness({ context: { body: 'yes' }, handlers: [handler] });
    const send = h.transport.send.bind(h.transport);
    h.transport.send = async (input) => {
      if (input.body.startsWith('https://')) throw new Error('carrier refused');
      return send(input);
    };

    await routeChannelMessage(h.deps, job()).catch(() => undefined);

    expect(h.transport.bodies()).toEqual(['Swim opens at 7.']);
    const outbound = h.fake
      .rows(schema.channelMessages)
      .filter((row) => row.direction === 'out')
      .map((row) => row.id);
    expect(outbound).toHaveLength(1);
    expect(after).toEqual(outbound);
  });

  it('runs afterSend once, for the first bubble, when every bubble goes', async () => {
    const { handler, after } = twoBubbles();
    const h = harness({ context: { body: 'yes' }, handlers: [handler] });

    await routeChannelMessage(h.deps, job());

    expect(h.transport.bodies()).toEqual(['Swim opens at 7.', 'https://example.test/l/abc']);
    const [first] = h.fake
      .rows(schema.channelMessages)
      .filter((row) => row.direction === 'out')
      .map((row) => row.id);
    expect(after).toEqual([first]);
  });
});

// ── the outage smoke alarm ───────────────────────────────────────────────────

/**
 * The ONE thing Hale says without a model, and only when there is no model to say it
 * with (founder-approved 2026-08-12).
 *
 * The hole it covers is specific and it is not the obvious one. The off-domain screen
 * FAILS OPEN (screen.ts openTheGate) — so during an Anthropic outage the deterministic
 * `safety_critical` lane never gets to classify anything, and "she's not breathing"
 * falls through to a coach that is also down. What that parent gets today is
 * failureReply(): "Something went wrong on my end - nothing was changed." The outage
 * disables the exact path built for that message, and this is what stands in its place.
 *
 * It is deliberately not a fallback for the LLM. Both conditions are required, the list
 * of tokens is short and fixed, and every other failed turn keeps the honesty line it
 * has always had.
 */
describe('the outage smoke alarm', () => {
  const EMERGENCY = 'she is not breathing what do I do';

  /** How an Anthropic outage actually arrives: the coach wraps the provider error and
   * rethrows (channel/coach/runtime.ts), so the router's catch sees the wrapper. */
  function outageCoach(): ChannelCoachRuntime {
    return {
      respond: async () => {
        throw new ChannelTurnFailed('channel coach: agent loop failed', {
          cause: new Anthropic.APIConnectionError({ message: 'Connection error.' }),
          draftedActionIds: [],
        });
      },
    };
  }

  it('holds an outage crisis instead of paging from the words', async () => {
    const h = harness({ context: { body: EMERGENCY }, coach: outageCoach() });

    await expect(routeChannelMessage(h.deps, job())).rejects.toBeInstanceOf(TurnDeferred);
    expect(h.transport.bodies()).toEqual([]);
  });

  it('writes no outbound row for it: nothing was sent', async () => {
    const h = harness({ context: { body: EMERGENCY }, coach: outageCoach() });

    await expect(routeChannelMessage(h.deps, job())).rejects.toBeInstanceOf(TurnDeferred);

    expect(ledgerRows(h.fake).filter((r) => r.direction === 'out')).toHaveLength(0);
  });

  it('does not claim a smoke alarm from the words', async () => {
    const claim = fakeSmokeAlarmClaim();
    const h = harness({ context: { body: EMERGENCY }, coach: outageCoach(), smokeAlarm: claim });

    await expect(routeChannelMessage(h.deps, job())).rejects.toBeInstanceOf(TurnDeferred);
    expect(claim.fired).toEqual([]);
    expect(h.transport.bodies()).toEqual([]);
  });

  it("holds the parent's next text the same way", async () => {
    const claim = fakeSmokeAlarmClaim();
    const h = harness({ context: { body: EMERGENCY }, coach: outageCoach(), smokeAlarm: claim });

    await expect(routeChannelMessage(h.deps, job())).rejects.toBeInstanceOf(TurnDeferred);
    await expect(
      routeChannelMessage(
        h.deps,
        job({ channel_message_id: '44444444-4444-4444-8444-444444444444' }),
      ),
    ).rejects.toBeInstanceOf(TurnDeferred);

    expect(h.transport.bodies()).toEqual([]);
    expect(claim.fired).toEqual([]);
  });

  // ── the non-triggers ───────────────────────────────────────────────────────

  it('is never consulted while the model is answering', async () => {
    const claim = fakeSmokeAlarmClaim();
    const coach = fakeCoach('Splash pad opens at 10.');
    const h = harness({ context: { body: EMERGENCY }, coach, smokeAlarm: claim });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('agent_replied');
    expect(claim.reads).toEqual([]);
    expect(claim.fired).toEqual([]);
    expect(h.transport.bodies()).toEqual(['Splash pad opens at 10.']);
  });

  /** An ordinary text during the same outage. The alarm stays quiet — and, since the
   * defer arc, so does everything else: that parent is owed a real answer, and the queue
   * is holding their turn until there is a model to write one. */
  it('leaves an ordinary text during an outage to the defer arc', async () => {
    const claim = fakeSmokeAlarmClaim();
    const h = harness({
      context: { body: 'anything indoors this weekend?' },
      coach: outageCoach(),
      smokeAlarm: claim,
    });

    await expect(routeChannelMessage(h.deps, job())).rejects.toBeInstanceOf(TurnDeferred);

    expect(h.transport.sent).toEqual([]);
    expect(claim.fired).toEqual([]);
  });

  /** A turn that ran out of steps, or broke on a tool, or hit a bug: the model was
   * reachable the whole time. A siren here would be the alarm becoming a general
   * fallback for the LLM, which is the one thing it must never be — and because the
   * provider IS up, the apology is composed rather than deferred. */
  it('leaves a non-outage failure alone even on the worst possible text', async () => {
    const claim = fakeSmokeAlarmClaim();
    const h = harness({
      context: { body: EMERGENCY },
      coach: {
        respond: async () => {
          throw new ChannelTurnFailed('channel coach: agent hit maxSteps without an answer', {
            draftedActionIds: [],
          });
        },
      },
      smokeAlarm: claim,
    });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('agent_failed');
    expect(h.transport.bodies()).toEqual([APOLOGY]);
    expect(claim.fired).toEqual([]);
  });

  /** The lane that deflects a screened symptom is upstream of the coach and untouched:
   * when the screen CAN run, the safety line comes from there and the alarm is never
   * reached. Same words, different door, and the outcome says which. */
  it('does not displace the screened safety deflection', async () => {
    const claim = fakeSmokeAlarmClaim();
    const h = harness({
      context: { body: EMERGENCY },
      offDomain: fakeLane({
        status: 'deflected',
        lane: 'safety_critical',
        category: 'other',
        reply: 'the lane wrote this',
        replySource: 'composed',
        medicalSource: null,
        signal: 'recorded',
        pendingAsk: null,
      }),
      coach: outageCoach(),
      smokeAlarm: claim,
    });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('deflected');
    expect(claim.reads).toEqual([]);
    expect(h.transport.bodies()).toEqual(['the lane wrote this']);
  });

  it('defers an unwritten moment and answers it once on the re-drive', async () => {
    let calls = 0;
    const lane = {
      async consider() {
        calls += 1;
        if (calls === 1) {
          return {
            status: 'unwritten' as const,
            moment: 'emergency' as const,
            reason: 'model_failed',
            lane: 'safety_critical' as const,
            category: 'emergency' as const,
          };
        }
        return {
          status: 'deflected' as const,
          lane: 'safety_critical' as const,
          category: 'emergency' as const,
          reply: 'Get help where you are.',
          replySource: 'composed' as const,
          medicalSource: null,
          signal: 'recorded' as const,
          pendingAsk: null,
        };
      },
    };
    const h = harness({ offDomain: lane });

    await expect(routeChannelMessage(h.deps, job())).rejects.toMatchObject({
      name: 'TurnDeferred',
      reason: 'moment_unwritten',
    });
    expect(h.transport.bodies()).toEqual([]);

    const again = await routeChannelMessage(h.deps, job());
    expect(again.status).toBe('deflected');
    expect(h.transport.bodies()).toEqual(['Get help where you are.']);
    expect(calls).toBe(2);
  });

  it('a crisis moment nobody could write pages #ops at once, then defers as before', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const unwritten = (
      moment: 'mental_crisis' | 'emergency' | 'could_not_answer',
      reason: string,
    ): OffDomainLane => ({
      async consider() {
        return {
          status: 'unwritten' as const,
          moment,
          reason,
          lane: 'safety_critical' as const,
          category: 'other' as const,
        };
      },
    });
    const crisis = recordingCrisisPager();
    const turn = job();

    for (const [moment, reason] of [
      ['mental_crisis', 'model_failed'],
      ['emergency', 'client_unavailable'],
    ] as const) {
      const h = harness({ offDomain: unwritten(moment, reason), crisisPager: crisis.pager });
      await expect(routeChannelMessage(h.deps, turn)).rejects.toMatchObject({
        name: 'TurnDeferred',
        reason: 'moment_unwritten',
      });
      expect(h.transport.bodies()).toEqual([]);
    }

    const at = {
      where: 'router moment',
      inboundId: turn.provider_message_id,
      familyId: turn.family_id,
      parentUserId: turn.parent_user_id,
    };
    expect(crisis.paged).toEqual([
      { kind: 'mental', reason: 'model_failed', writes: 2, ...at },
      { kind: 'emergency', reason: 'client_unavailable', writes: 0, ...at },
    ]);
    expect(crisis.recorded).toEqual(crisis.paged);

    // Positive control: a could-not-answer moment is not a crisis. It defers and pages nobody.
    const plain = harness({
      offDomain: unwritten('could_not_answer', 'model_failed'),
      crisisPager: crisis.pager,
    });
    await expect(routeChannelMessage(plain.deps, turn)).rejects.toMatchObject({
      reason: 'moment_unwritten',
    });
    expect(crisis.paged).toHaveLength(2);
  });

  it('names the outcome on the failure log without carrying the body (rule #1, #11)', async () => {
    const h = harness({ context: { body: EMERGENCY }, coach: outageCoach() });

    await expect(routeChannelMessage(h.deps, job())).rejects.toBeInstanceOf(TurnDeferred);

    const dump = JSON.stringify(h.logs);
    expect(dump).toContain('model_unreachable');
    expect(dump).not.toContain('not breathing');
  });
});

// ── refusals ─────────────────────────────────────────────────────────────────

describe('refusals', () => {
  it('does nothing at all when the ledger row is gone', async () => {
    const coach = fakeCoach();
    const h = harness({ context: null, coach });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('unknown_message');
    expect(coach.calls).toBe(0);
    expect(h.transport.sent).toEqual([]);
    expect(conversationRows(h.fake)).toEqual([]);
  });

  /** No active verified channel means the number is revoked or gone. Texting it would
   * be a CASL failure, so the turn stops before anything is sent (rule #1). */
  it('sends nothing when there is no reachable channel', async () => {
    const coach = fakeCoach();
    const h = harness({ context: { reply: null }, coach });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('unreachable');
    expect(h.transport.sent).toEqual([]);
    expect(coach.calls).toBe(0);
  });
});

// ── privacy ──────────────────────────────────────────────────────────────────

describe('logs carry no bodies', () => {
  it('never logs what the parent wrote or what Hale answered', async () => {
    const secret = 'Mia has a therapy appointment on Thursday';
    const h = harness({ context: { body: secret }, coach: fakeCoach('Booked — Thursday 4pm') });

    await routeChannelMessage(h.deps, job());

    const dump = JSON.stringify(h.logs);
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain('Booked — Thursday 4pm');
    expect(dump).not.toContain(PHONE);
  });

  it('logs the failure without the body either', async () => {
    const secret = 'Mia has a therapy appointment on Thursday';
    const h = harness({
      context: { body: secret },
      coach: {
        respond: async () => {
          throw new Error('boom');
        },
      },
    });

    await routeChannelMessage(h.deps, job());

    expect(JSON.stringify(h.logs)).not.toContain(secret);
  });

  /** The apology composer is BLIND (apology.ts): it never receives the parent's words,
   * so no bug in it can put them back on the wire. Asserted through the router because
   * this is the seam where the words are in scope and could be passed by mistake. */
  it("never hands the parent's words to the apology composer", async () => {
    const secret = 'Mia has a therapy appointment on Thursday';
    const seen: unknown[] = [];
    const h = harness({
      context: { body: secret },
      coach: {
        respond: async () => {
          throw new Error('boom');
        },
      },
      apology: {
        compose: async (...args: unknown[]) => {
          seen.push(args);
          return { status: 'composed' as const, reply: APOLOGY };
        },
      },
    });

    await routeChannelMessage(h.deps, job());

    expect(JSON.stringify(seen)).not.toContain('Mia');
  });
});

// ── the coach seam ───────────────────────────────────────────────────────────

describe('the C2 seam', () => {
  /** The stub is no longer what production wires (VIL-221 · C2 is), but it stays as the
   * degraded runtime: any deployment without a model still answers with the
   * Conversation Design's honest boundary rather than with silence. */
  it('still answers with the Conversation Design capability reply when it is the runtime', async () => {
    const { capabilityStubRuntime } = await import('./coach-runtime');
    const h = harness({ coach: capabilityStubRuntime() });

    await routeChannelMessage(h.deps, job());

    // VIL-504 · stub sends nothing (absolute-zero fixed copy).
    expect(h.transport.bodies()).toEqual([]);
  });
});

/**
 * The deterministic chain built from the REAL adapters, in the order production ships
 * them, driven through the real router against the real coach stub.
 *
 * The unit tests above prove each handler's verdict in isolation; this proves the thing
 * a parent actually experiences — that a registration report is answered without a model
 * ever being asked, and that the reply they get is M7's, not the stub's.
 */
describe('the shipped chain, end to end', () => {
  const CHILD = '44444444-4444-4444-8444-444444444444';

  function realChain(options: { pending?: Array<{ actionId: string; actionType: string }> } = {}) {
    const approved: string[] = [];
    const spine = {
      listPending: async () => options.pending ?? [],
      latestUndoable: async () => null,
      approve: async (_db: unknown, args: { actionId: string }) => {
        approved.push(args.actionId);
        return true;
      },
      decline: async () => true,
      undo: async () => true,
    };
    const health = {
      loadLastCheckpointRef: async () => ({
        ref: `dental_school_screening:${CHILD}:1`,
        toldAt: new Date(0),
      }),
      recordDone: async () => {},
      draftCheckup: async () => ({ actionId: 'drafted-1' }),
    };
    const recorded: Array<{ outcome: string; position: number | null }> = [];
    const sequence = {
      loadAwaitingSequence: async () => ({
        sequenceId: 'seq-1',
        familyId: FAMILY,
        parentUserId: PARENT,
        state: {
          openAt: new Date('2026-07-29T11:00:00.000Z'),
          timeZone: 'America/Toronto',
          optIn: 'opted_in' as const,
          outcome: null,
          waitlistStartedAt: null,
          waitlistResponseHours: 36,
        },
        shortlist: {
          windowRef: {
            id: 'win-1',
            municipality: 'Markham',
            programDomain: 'swim' as const,
            cycleLabel: 'Fall 2026',
          },
          cyclePhrase: 'Fall 2026 swim lessons',
          opensForFamilyAt: new Date('2026-07-29T11:00:00.000Z'),
          sourceUrl: 'https://example.invalid/register',
          isResidentWindow: true,
          residentPriorityDays: null,
          waitlistResponseHours: 36,
          fitNotes: [],
          ageApproximate: false,
        },
        reaskedAt: null,
      }),
      recordOutcome: async (_db: unknown, input: { outcome: string; position: number | null }) => {
        recorded.push({ outcome: input.outcome, position: input.position });
      },
      recordReask: async () => {},
      // The composer seam (VIL-543): the note's kind stands in for the model's text.
      writeNote: async (_db: unknown, _familyId: string, facts: { kind: string }) =>
        `note:${facts.kind}`,
    };
    return {
      recorded,
      approved,
      // The production order (wiring.defaultHandlers): narrow claimers, then the broad one.
      handlers: [
        approvalHandler(spine as never),
        healthReplyHandler(health as never),
        // The pre-open branch reads nothing while F14 is dark for this family, which
        // every case in this file is (VIL-338).
        sequenceReplyHandler(sequence as never, {} as never),
      ],
    };
  }

  it('answers "waitlisted #3" without ever reaching the agent', async () => {
    const chain = realChain();
    const coach = fakeCoach();
    const h = harness({ context: { body: 'waitlisted #3' }, handlers: chain.handlers, coach });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('handled');
    expect(result.handler).toBe('registration');
    expect(coach.calls).toBe(0);
    expect(chain.recorded).toEqual([{ outcome: 'waitlisted', position: 3 }]);
    // The parent is told the clock started — the written note, not the stub's boundary line.
    expect(h.transport.bodies()).toEqual(['note:outcome_waitlisted']);
  });

  it('answers "done" from the health handler, not the registration re-ask', async () => {
    const chain = realChain();
    const coach = fakeCoach();
    const h = harness({ context: { body: 'done' }, handlers: chain.handlers, coach });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.handler).toBe('health');
    expect(coach.calls).toBe(0);
    expect(chain.recorded).toEqual([]);
  });

  it('approves the drafted action when the model reads a yes', async () => {
    const chain = realChain({ pending: [{ actionId: 'a-1', actionType: 'calendar_add' }] });
    const coach = fakeCoach();
    const h = harness({
      context: { body: 'sounds good' },
      handlers: chain.handlers,
      coach,
      questions: fakeQuestions([
        {
          id: 'a-1',
          kind: 'approval',
          description: 'Add to your calendar',
          subject: 'add to your calendar',
          answerable: { yes: true, no: true },
          askedAt: null,
          solicited: false,
        },
      ]),
      replyResolver: fakeResolver({
        status: 'resolved',
        questionId: 'a-1',
        kind: 'approval',
        polarity: 'yes',
        confidence: 'high',
      }),
    });

    expect((await routeChannelMessage(h.deps, job())).handler).toBe('approval');
    expect(chain.approved).toEqual(['a-1']);
    expect(coach.calls).toBe(0);
  });

  for (const body of ['yes', 'sounds good', 'do it', '👍']) {
    it(`does not approve from the word ${JSON.stringify(body)} alone`, async () => {
      const chain = realChain({ pending: [{ actionId: 'a-1', actionType: 'calendar_add' }] });
      const coach = fakeCoach();
      const h = harness({ context: { body }, handlers: chain.handlers, coach });

      expect((await routeChannelMessage(h.deps, job())).handler).not.toBe('approval');
      expect(chain.approved).toEqual([]);
      expect(coach.calls).toBe(1);
    });
  }

  /**
   * The checkmark is M8's "I filed the paperwork" AND, now, an approval. The ownership
   * rule is what keeps that from stealing it: with nothing drafted the approval handler
   * declines and the health handler gets its own answer — exactly as it already does for
   * the bare "yes" both have always shared.
   */
  it('leaves ✅ to the health handler when there is nothing drafted to approve', async () => {
    const chain = realChain();
    const coach = fakeCoach();
    const h = harness({ context: { body: '✅' }, handlers: chain.handlers, coach });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.handler).toBe('health');
    expect(chain.approved).toEqual([]);
    expect(coach.calls).toBe(0);
  });

  /**
   * The widening's own guardrail. An affirmative HEAD with a real tail is not a bare
   * affirmative — the parent is still asking for something, and approving on the head
   * would execute a calendar write while their actual question went unanswered.
   */
  it('sends an affirmative carrying a second instruction to the coach, approving nothing', async () => {
    const chain = realChain({ pending: [{ actionId: 'a-1', actionType: 'calendar_add' }] });
    const coach = fakeCoach();
    const h = harness({
      context: { body: 'sounds good but can we do Thursday instead' },
      handlers: chain.handlers,
      coach,
    });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('agent_replied');
    expect(chain.approved).toEqual([]);
    expect(coach.calls).toBe(1);
  });

  /**
   * VIL-221 · C2 took this branch over, which is what M7's own module note said should
   * happen once a conversational layer existed. An open registration window no longer
   * turns a readable question into the check-in menu: "anything indoors this weekend?"
   * is a question the coach can actually answer, and answering it with "how did
   * registration go?" was only ever the best available reply, never a good one.
   *
   * M7 keeps everything that is genuinely its: the three certainties it CAN read
   * ("waitlisted #3" above), the window bookkeeping, and the re-ask stamp.
   */
  it('sends an unreadable message inside an open window to the coach, not the re-ask', async () => {
    const chain = realChain();
    const coach = fakeCoach();
    const h = harness({
      context: { body: 'anything indoors this weekend?' },
      handlers: chain.handlers,
      coach,
    });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('agent_replied');
    expect(result.handler).toBeNull();
    expect(coach.calls).toBe(1);
  });
});

/**
 * GATE 2b — natural reply resolution, through the real router.
 *
 * The arc's whole claim is that a parent never has to learn a keyword. What that means
 * concretely is asserted here: the free readers still win, the stage costs nothing when
 * Hale is waiting on nothing, and a reply the vocabularies cannot read reaches the
 * handler that owns the question anyway — with the parent's own words intact.
 */
describe('natural reply resolution', () => {
  const ACTION = 'aaaa1111-1111-4111-8111-111111111111';

  function approvalQuestion(): OpenQuestion {
    return {
      id: ACTION,
      kind: 'approval',
      description: 'Reschedule on your calendar',
      subject: 'reschedule on your calendar',
      answerable: { yes: true, no: true },
      askedAt: null,
      solicited: false,
    };
  }

  function introQuestion(): OpenQuestion {
    return {
      id: 'proposal-1',
      kind: 'intro_proposal',
      description: 'Whether to meet one nearby Hale family',
      subject: 'meeting the family nearby',
      answerable: { yes: true, no: true },
      askedAt: null,
      solicited: false,
    };
  }

  /** A handler that claims only when the router hands it a resolved answer — the second
   * pass, and nothing else. */
  function owningHandler(kind: OpenQuestion['kind']) {
    const seen: Array<{ body: string; resolved: unknown }> = [];
    return {
      seen,
      handler: {
        name: `owner_${kind}`,
        resolves: new Set([kind]),
        async handle(_db: unknown, ctx: { body: string; resolved: unknown }) {
          seen.push({ body: ctx.body, resolved: ctx.resolved });
          if (!ctx.resolved) return { claimed: false };
          return { claimed: true, outcome: 'acted', reply: 'Done.' };
        },
      } as unknown as DeterministicHandler,
    };
  }

  it('costs nothing at all when Hale is waiting on nothing', async () => {
    const questions = fakeQuestions([]);
    const resolver = fakeResolver({ status: 'unresolved', reason: 'no_target' });
    const h = harness({ context: { body: 'yeah go ahead' }, questions, replyResolver: resolver });

    const result = await routeChannelMessage(h.deps, job());

    expect(questions.calls).toBe(1);
    // The precondition that makes this stage affordable on every inbound text.
    expect(resolver.calls).toBe(0);
    expect(result.status).toBe('agent_replied');
  });

  it('never runs when a deterministic handler already claimed the message', async () => {
    const questions = fakeQuestions([approvalQuestion()]);
    const resolver = fakeResolver({ status: 'unresolved', reason: 'no_target' });
    const claiming: DeterministicHandler = {
      name: 'claims_everything',
      handle: async () => ({ claimed: true, outcome: 'ok', reply: 'Filed.' }),
    };
    const h = harness({
      context: { body: 'done' },
      handlers: [claiming],
      questions,
      replyResolver: resolver,
    });

    expect((await routeChannelMessage(h.deps, job())).status).toBe('handled');
    // The model reads first. A handler that still claims does so after that read.
    expect(questions.calls).toBe(1);
    expect(resolver.calls).toBe(1);
  });

  it('hands a resolved answer to the handler that owns that kind, with the parents own words', async () => {
    const owner = owningHandler('approval');
    const h = harness({
      context: { body: 'yeah go ahead with the swim move' },
      handlers: [owner.handler],
      questions: fakeQuestions([approvalQuestion()]),
      replyResolver: fakeResolver({
        status: 'resolved',
        questionId: ACTION,
        kind: 'approval',
        polarity: 'yes',
        confidence: 'high',
      }),
    });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('resolved');
    expect(result.handler).toBe('owner_approval');
    // One pass: the model placed it, and the owner sees the sentence the parent sent.
    expect(owner.seen).toEqual([
      {
        body: 'yeah go ahead with the swim move',
        resolved: {
          kind: 'approval',
          questionId: ACTION,
          polarity: 'yes',
          confidence: 'high',
        },
      },
    ]);
    expect(h.transport.bodies()).toEqual(['Done.']);
  });

  it('runs ONLY the owning handler on the resolved pass', async () => {
    // The registration handler writes `reasked_at` on the way past. A second full sweep
    // of the chain would spend that stamp twice for one text.
    const owner = owningHandler('approval');
    let otherCalls = 0;
    const other: DeterministicHandler = {
      name: 'not_the_owner',
      handle: async () => {
        otherCalls += 1;
        return { claimed: false };
      },
    };
    const h = harness({
      context: { body: 'go on then' },
      handlers: [other, owner.handler],
      questions: fakeQuestions([approvalQuestion()]),
      replyResolver: fakeResolver({
        status: 'resolved',
        questionId: ACTION,
        kind: 'approval',
        polarity: 'yes',
        confidence: 'high',
      }),
    });

    await routeChannelMessage(h.deps, job());

    // The resolved pass calls the owner only. The rest of the chain is not swept.
    expect(otherCalls).toBe(0);
  });

  /**
   * An answer Hale cannot place goes to the COACH, with the candidates.
   *
   * It used to be a fixed sentence sent from the router, and on 2026-08-20 a parent got
   * "Which one - add to your calendar, or meeting the family nearby?" in reply to an
   * offer Hale had made them and never written down. Both halves were wrong: the list,
   * and a machine reading its own option labels back at someone. The coach has the
   * thread; what it was missing was what Hale was holding, and now it is handed it.
   */
  it('hands an unplaceable answer to the coach, with the candidates', async () => {
    const coach = fakeCoach('which of those did you mean?');
    const h = harness({
      context: { body: 'sounds good' },
      coach,
      questions: fakeQuestions([approvalQuestion(), introQuestion()]),
      replyResolver: fakeResolver({ status: 'unresolved', reason: 'ambiguous' }),
    });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('agent_replied');
    expect(coach.standingQuestions).toEqual([
      ['reschedule on your calendar', 'meeting the family nearby'],
    ]);
    expect(h.transport.bodies()).toEqual(['which of those did you mean?']);
  });

  /** Every coach turn is told what Hale is waiting on, not only the unplaceable ones —
   * the coach used to say "I don't have a draft waiting for your YES right now" while
   * one was pending (the prod failure the resolver eval's first fixture records). */
  it('tells the coach what is standing even on an ordinary turn', async () => {
    const coach = fakeCoach();
    const h = harness({
      context: { body: 'what time is storytime on saturday' },
      coach,
      questions: fakeQuestions([approvalQuestion()]),
      replyResolver: fakeResolver({ status: 'unresolved', reason: 'no_target' }),
    });

    await routeChannelMessage(h.deps, job());

    expect(coach.standingQuestions).toEqual([['reschedule on your calendar']]);
  });

  it('sends no canned choice sentence when the coach cannot run', async () => {
    const h = harness({
      context: { body: 'sounds good' },
      coach: brokenCoach(),
      questions: fakeQuestions([approvalQuestion(), introQuestion()]),
      replyResolver: fakeResolver({ status: 'unresolved', reason: 'ambiguous' }),
    });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('agent_failed');
    // VIL-504 · no canned which-one skeleton: the model's apology, never fixed copy.
    expect(h.transport.bodies()).toHaveLength(1);
    expect(h.transport.bodies()[0]).not.toMatch(/Which one -/);
  });

  it('does not offer numbers when no menu was written down', async () => {
    // The mint only happens when the free vocabulary could read a yes or a no off the
    // reply; when it could not, NOTHING is recorded — and "Reply 1 or 2" would then be
    // inviting a digit no menu is standing behind, which the approvals queue's own
    // numbering would answer instead. The copy has to match what exists.
    const h = harness({
      context: { body: 'the second thing i guess' },
      coach: brokenCoach(),
      questions: fakeQuestions([approvalQuestion(), introQuestion()]),
      replyResolver: fakeResolver({ status: 'unresolved', reason: 'ambiguous' }),
    });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('agent_failed');
    expect((h.deps.disambiguation as unknown as { minted: number }).minted).toBe(0);
    const sent = h.transport.bodies()[0] as string;
    // VIL-504 · no canned which-one skeleton on a coach-down turn.
    expect(sent).not.toMatch(/Which one -/);
    expect(sent).not.toContain('1)');
    expect(sent).not.toMatch(/Reply 1/);
  });

  it('does not send the choice sentence for an ordinary broken turn', async () => {
    // The apology composer owns that turn. Answering "which one did you mean?" to a
    // parent who asked a question would be Hale inventing a decision they never made.
    const h = harness({
      context: { body: 'what time is storytime on saturday' },
      coach: brokenCoach(),
      questions: fakeQuestions([approvalQuestion(), introQuestion()]),
      replyResolver: fakeResolver({ status: 'unresolved', reason: 'no_target' }),
    });

    await routeChannelMessage(h.deps, job());

    expect(h.transport.bodies()[0]).not.toMatch(/Which one/i);
  });

  it('does not ask when only one thing is open - it just hands the turn to the coach', async () => {
    const coach = fakeCoach();
    const h = harness({
      context: { body: 'sounds good' },
      coach,
      questions: fakeQuestions([approvalQuestion()]),
      replyResolver: fakeResolver({ status: 'unresolved', reason: 'ambiguous' }),
    });

    expect((await routeChannelMessage(h.deps, job())).status).toBe('agent_replied');
    expect(coach.calls).toBe(1);
  });

  it('sends an ordinary message to the coach even with questions open', async () => {
    // The failure this avoids: a parent asks "what time is storytime" while a draft is
    // pending, and gets "which one did you mean?".
    const coach = fakeCoach();
    const h = harness({
      context: { body: 'what time is storytime on saturday' },
      coach,
      questions: fakeQuestions([approvalQuestion(), introQuestion()]),
      replyResolver: fakeResolver({ status: 'unresolved', reason: 'no_target' }),
    });

    expect((await routeChannelMessage(h.deps, job())).status).toBe('agent_replied');
    expect(coach.calls).toBe(1);
    expect(h.transport.bodies()).toEqual(['coach says hi']);
  });

  it('falls through to the coach when the owning handler declines a resolution', async () => {
    // The co-parent answered it in the app between the two reads. Never silence.
    const coach = fakeCoach();
    const declining: DeterministicHandler = {
      name: 'owner_approval',
      resolves: new Set(['approval']),
      handle: async () => ({ claimed: false }),
    };
    const h = harness({
      context: { body: 'go ahead' },
      handlers: [declining],
      coach,
      questions: fakeQuestions([approvalQuestion()]),
      replyResolver: fakeResolver({
        status: 'resolved',
        questionId: ACTION,
        kind: 'approval',
        polarity: 'yes',
        confidence: 'high',
      }),
    });

    expect((await routeChannelMessage(h.deps, job())).status).toBe('agent_replied');
    expect(coach.calls).toBe(1);
  });

  it('falls through to the coach when no handler owns the resolved kind', async () => {
    const coach = fakeCoach();
    const h = harness({
      context: { body: 'go ahead' },
      handlers: [],
      coach,
      questions: fakeQuestions([approvalQuestion()]),
      replyResolver: fakeResolver({
        status: 'resolved',
        questionId: ACTION,
        kind: 'approval',
        polarity: 'yes',
        confidence: 'high',
      }),
    });

    expect((await routeChannelMessage(h.deps, job())).status).toBe('agent_replied');
    expect(coach.calls).toBe(1);
    expect(JSON.stringify(h.logs)).toContain('no handler owns');
  });

  it('answers a resolved yes even when the parents hour is spent', async () => {
    // It sits above flood control for the reason the handlers do: "yeah go ahead" is the
    // same act as "yes", and a parent who is texting fast is usually stressed.
    const owner = owningHandler('approval');
    const h = harness({
      context: { body: 'yeah do it' },
      handlers: [owner.handler],
      limiter: { check: async () => ({ allowed: false, remaining: 0 }) } as unknown as RateLimiter,
      questions: fakeQuestions([approvalQuestion()]),
      replyResolver: fakeResolver({
        status: 'resolved',
        questionId: ACTION,
        kind: 'approval',
        polarity: 'yes',
        confidence: 'high',
      }),
    });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('resolved');
    expect(h.transport.bodies()).toEqual(['Done.']);
  });
});

/**
 * THE 09:47 SEQUENCE, end to end through the real intro lane.
 *
 * From the founder's live test on 2026-08-13, and the reason this arc exists. Hale asked
 * at 08:01; at 09:47:48 the parent replied "Yes"; at 09:47:59, having been answered about
 * an unrelated calendar draft, they retyped "Yes intros". They got two contradictory
 * replies eleven seconds apart.
 *
 * Both halves are asserted here because they fail in opposite directions: the first text
 * must be UNDERSTOOD, and the second must NOT be treated as a new decision.
 */
describe('the 09:47 sequence', () => {
  const OPT_IN: OpenQuestion = {
    id: `intro_optin:${FAMILY}`,
    kind: 'intro_optin',
    description: 'Whether to be introduced to other Hale families nearby',
    subject: 'introductions to other Hale families nearby',
    answerable: { yes: true, no: true },
    askedAt: null,
    solicited: false,
  };

  /** The real lane, over spies. `standing` is what the ledger already holds. */
  const line = (situation: IntroReplySituation) =>
    `model:${INTRO_REPLY_FACTS[situation].situation}`;

  function introChain(standing: 'unanswered' | 'granted') {
    const written: boolean[] = [];
    const deps: VillageIntroReplyDeps = {
      consent: {
        read: async ({ text }) => {
          const folded = text.trim().toLowerCase();
          if (folded === 'yes intros') return { verdict: 'yes', target: 'discoverability' };
          if (folded === 'no intros') return { verdict: 'no', target: 'discoverability' };
          return null;
        },
      },
      recordDiscoverability: async (_db, input) => {
        written.push(input.granted);
      },
      discoverabilityStanding: async () => standing,
      answerableProposal: async () => null,
      recordDecision: async () => {},
      cancelOpenProposals: async () => {},
      // Stands in for the model (said-line): never a paid call.
      saidLine: { write: async (input) => `model:${String(input.facts.situation)}` },
    };
    return { written, handlers: [villageIntroHandler(deps)] };
  }

  it('understands the bare "Yes" - one reply, consent recorded, no coach turn', async () => {
    const chain = introChain('unanswered');
    const coach = fakeCoach();
    const h = harness({
      context: { body: 'Yes' },
      handlers: chain.handlers,
      coach,
      questions: fakeQuestions([OPT_IN]),
      replyResolver: fakeResolver({
        status: 'resolved',
        questionId: OPT_IN.id,
        kind: 'intro_optin',
        polarity: 'yes',
        confidence: 'high',
      }),
    });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('resolved');
    expect(chain.written).toEqual([true]);
    // ONE message. What happened live was a coach turn about a stale calendar draft.
    expect(h.transport.bodies()).toEqual([line('discoverability_on')]);
    expect(coach.calls).toBe(0);
  });

  it('does not answer the retyped "Yes intros" as a second decision', async () => {
    // Eleven seconds later, the answer already recorded. A parent who texts twice because
    // they think the first one did not land is not making a second choice.
    const chain = introChain('granted');
    const h = harness({
      context: { body: 'Yes intros' },
      handlers: chain.handlers,
      // The question is closed now, so nothing is open and the resolver never runs.
      questions: fakeQuestions([]),
    });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.handler).toBe('village_intro');
    expect(chain.written).toEqual([]);
    expect(h.transport.bodies()).toEqual([line('discoverability_already_on')]);
    // Not the full acknowledgement a second time.
    expect(h.transport.bodies()[0]).not.toBe(line('discoverability_on'));
  });

  it('still honours a revocation seconds after the grant', async () => {
    // The one thing the shortcut may never swallow.
    const chain = introChain('granted');
    const h = harness({
      context: { body: 'no intros' },
      handlers: chain.handlers,
      questions: fakeQuestions([]),
    });

    await routeChannelMessage(h.deps, job());

    expect(chain.written).toEqual([false]);
    expect(h.transport.bodies()).toEqual([line('discoverability_off')]);
  });
});

/**
 * D3 — AN APOLOGY IS NOT AN ANSWERED TURN.
 *
 * 2026-08-22, 17:41 UTC. A coach turn ran for 49,889 ms, came back `status=failed`, and
 * the parent got "I couldn't get that done for you, and nothing changed on your end."
 * The family's whole audit trail for that text was `sms_reply_received` →
 * `sms_turn_answered` → `sms_reply_sent`: three rows that read as a turn that worked.
 * There was no failure action of any kind in the history, and no rate anywhere.
 *
 * The answered claim is CORRECT and stays — the parent has their text and a re-drive
 * must not send a second one. What was missing is the other half.
 */
describe('a failed turn is recorded as a failure', () => {
  const throwing: ChannelCoachRuntime = {
    respond: async () => {
      throw new Error('cannot read properties of undefined');
    },
  };

  it('writes the typed failure BESIDE the answered claim, not instead of it', async () => {
    const h = harness({ coach: throwing });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('agent_failed');
    // Both, and they answer different questions: one stops a second reply, one says the
    // turn did not work.
    expect(h.turns.answered).toEqual([job().channel_message_id]);
    expect(h.turns.failed).toEqual([
      { channelMessageId: job().channel_message_id, reason: 'apology_sent' },
    ]);
  });

  it('names the drafts-receipt branch as its own failure class', async () => {
    const h = harness({
      coach: {
        respond: async () => {
          throw new ChannelTurnFailed('channel coach: agent hit maxSteps without an answer', {
            cause: new Error('maxSteps'),
            draftedActionIds: ['action-1', 'action-2'],
          });
        },
      },
    });

    await routeChannelMessage(h.deps, job());

    expect(h.turns.failed).toEqual([
      { channelMessageId: job().channel_message_id, reason: 'drafts_receipt' },
    ]);
  });

  it('POSITIVE CONTROL - a turn that worked writes no failure row', async () => {
    const h = harness();

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('agent_replied');
    expect(h.turns.answered).toEqual([job().channel_message_id]);
    expect(h.turns.failed).toEqual([]);
  });

  it('POSITIVE CONTROL - a DEFERRED turn keeps its own row and writes no failure one', async () => {
    // The deferral already has `sms_turn_deferred` and its own captured rate. A turn
    // that said nothing is a different outcome from one that apologised, and folding
    // them together is what this whole change is against.
    const h = harness({
      coach: {
        respond: async () => {
          throw new ChannelTurnFailed('channel coach: agent loop failed', {
            cause: new Anthropic.APIConnectionError({ message: 'Connection error.' }),
            draftedActionIds: [],
          });
        },
      },
    });

    await expect(routeChannelMessage(h.deps, job())).rejects.toBeInstanceOf(TurnDeferred);

    expect(h.turns.deferred).toEqual([job().channel_message_id]);
    expect(h.turns.failed).toEqual([]);
  });
});

// ── VIL-293 · the reconciliation primitive, replayed against the audit ───────

/**
 * Every body below is a sentence Hale actually sent in the 2026-08-21/22 audit, and every
 * assertion is the thing that did not happen. On main each of these bodies reached the
 * transport verbatim with no row anywhere behind it.
 */
describe('audit replay: a claim reaches the wire only when a row backs it', () => {
  const OPENS = new Date('2026-09-01T11:00:00.000Z');

  /** A coach whose answers are scripted per attempt — the re-ask is the point. */
  function scriptedCoach(
    turns: readonly {
      reply: string;
      activityPromise?: ActivityPromise;
      spotWatch?: SpotWatchIntent;
    }[],
  ): ChannelCoachRuntime & { rejected: string[][] } {
    let attempt = 0;
    const coach = {
      rejected: [] as string[][],
      async respond(_turn: ChannelTurn, rejectedLastAttempt: readonly string[]) {
        coach.rejected.push([...rejectedLastAttempt]);
        const scripted = turns[Math.min(attempt, turns.length - 1)];
        attempt += 1;
        return {
          reply: scripted?.reply ?? '',
          planOffer: null,
          activityPromise: scripted?.activityPromise ?? null,
          spotWatch: scripted?.spotWatch ?? null,
        };
      },
    };
    return coach;
  }

  it('(a) Aug 21 — "I\'m watching that morning" MINTS the watch against the matched window', async () => {
    const minted: unknown[] = [];
    const h = harness({
      coach: fakeCoach("I'm watching that morning and I'll text you before it goes live."),
      reconcileView: async () =>
        emptyReconcileView({ mintableWindow: { town: 'Halton Hills', opensForFamilyAt: OPENS } }),
      recordRegistrationWatch: async (_db, input) => {
        minted.push(input);
        return { status: 'recorded' as const };
      },
    });
    await routeChannelMessage(h.deps, job());

    expect(h.transport.sent.map((m) => m.body)).toEqual([
      "I'm watching that morning and I'll text you before it goes live.",
    ]);
    expect(minted).toHaveLength(1);
    expect(minted[0]).toMatchObject({
      familyId: FAMILY,
      mint: {
        kind: 'registration_watch',
        summary: 'Halton Hills registration: a text before it opens.',
        dueAt: OPENS,
      },
      // Against the row that CARRIED it — the MEM-10 send-time discipline.
      channelMessageId: ledgerRows(h.fake)[0]?.id,
    });
  });

  /** What `watch_for_opening` hands back for the course page the spot fixtures paste. */
  const COURSE_INTENT = {
    url: 'https://cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=15f6af07-39c5-473e-b053-96653f77a406&courseId=85770d4d-bce9-4e53-b969-cf7e88775180',
    host: 'cityofmarkham.perfectmind.com',
    portalLabel: "Markham's portal",
    label: 'Tuesday preschool swim',
    instant: false,
    lastState: 'full' as const,
    sessionStartsAt: null,
    sessionAnchor: null,
  };

  it('(a3) VIL-337 — the watch verb backs its own sentence, and the row is armed after the send', async () => {
    const armed: unknown[] = [];
    const intent = COURSE_INTENT;
    const h = harness({
      coach: scriptedCoach([
        {
          reply: "I'm watching that class and I'll text you when a spot opens.",
          spotWatch: intent,
        },
      ]),
      armWatchedSpot: async (_db, input) => {
        armed.push(input);
        return { status: 'armed' as const, spotId: 'spot-1' };
      },
    });
    await routeChannelMessage(h.deps, job());

    // The sentence goes out AS WRITTEN. Without the `spot_watch` widening in the
    // reconcile view this is an unbacked registration claim, re-asked once and then cut.
    expect(h.transport.sent.map((m) => m.body)).toEqual([
      "I'm watching that class and I'll text you when a spot opens.",
    ]);
    expect(armed).toEqual([
      {
        familyId: FAMILY,
        parentUserId: PARENT,
        intent,
        // Against the row that CARRIED it: a compose that never reached a transport
        // must not leave a household being watched without having been told.
        channelMessageId: ledgerRows(h.fake)[0]?.id,
        now: NOW,
      },
    ]);
  });

  /**
   * THE OTHER END OF THE SAME RULE (VIL-337). The arm is a promise to poll a page for
   * sixty days, and what makes it a promise is the parent being TOLD. When the reconcile
   * cuts the sentence that said so — twice unbacked, so subtracted — the row would be a
   * watch nobody knows about: no text arrives to say it started, and the "I'll text you"
   * it was armed against is not in what the parent read. So the arm is dropped with the
   * sentence, and the drop is a named outcome rather than a quiet nothing (rule #11).
   */
  it('(a4) VIL-337 — a watch whose ack was CUT is not armed behind the parent', async () => {
    const armed: unknown[] = [];
    const h = harness({
      coach: scriptedCoach([
        {
          // The surviving half carries a claim of its OWN — a promise this turn really
          // registered — so what is being asserted is that the WATCH ack survived, not
          // that some sentence did.
          reply:
            "I'll come back to you with options for that class. I'm watching that morning and I'll text you before it goes live.",
          activityPromise: { subject: 'preschool swim nearby', childId: null },
          spotWatch: COURSE_INTENT,
        },
      ]),
      armWatchedSpot: async (_db, input) => {
        armed.push(input);
        return { status: 'armed' as const, spotId: 'spot-1' };
      },
    });
    await routeChannelMessage(h.deps, job());

    // The municipal half is unbacked and goes; the half that answered the parent stays.
    expect(h.transport.sent.map((m) => m.body)).toEqual([
      "I'll come back to you with options for that class.",
    ]);
    expect(armed).toEqual([]);
    expect(h.logs.flat().some((entry) => JSON.stringify(entry).includes('ack_cut'))).toBe(true);
  });

  it('(a5) VIL-337 — a cut somewhere ELSE in the reply still arms the watch it kept', async () => {
    // THE POSITIVE CONTROL for (a4). The rule is about the ack, not about the turn: a
    // reply that loses an unbacked booking line and keeps the sentence that said Hale is
    // watching has told the parent, and the row it promised must exist.
    const armed: unknown[] = [];
    const h = harness({
      coach: scriptedCoach([
        {
          reply:
            "I'm watching that class and I'll text you when a spot opens. Thursday swim is booked at 5:15.",
          spotWatch: COURSE_INTENT,
        },
      ]),
      armWatchedSpot: async (_db, input) => {
        armed.push(input);
        return { status: 'armed' as const, spotId: 'spot-1' };
      },
    });
    await routeChannelMessage(h.deps, job());

    expect(h.transport.sent.map((m) => m.body)).toEqual([
      "I'm watching that class and I'll text you when a spot opens.",
    ]);
    expect(armed).toHaveLength(1);
    expect(armed[0]).toMatchObject({ familyId: FAMILY, intent: COURSE_INTENT });
  });

  it('(a2) refuses the same sentence when no window matched and no ladder runs', async () => {
    const minted: unknown[] = [];
    const h = harness({
      coach: scriptedCoach([
        { reply: "I'm watching that morning and I'll text you before it goes live." },
        { reply: 'Halton Hills has not published a fall date yet.' },
      ]),
      recordRegistrationWatch: async (_db, input) => {
        minted.push(input);
        return { status: 'recorded' as const };
      },
    });
    await routeChannelMessage(h.deps, job());

    expect(minted).toEqual([]);
    expect(h.transport.sent.map((m) => m.body)).toEqual([
      'Halton Hills has not published a fall date yet.',
    ]);
  });

  it('(b) Aug 12 — the finds promise is re-asked, and the second attempt registers it', async () => {
    const promises: unknown[] = [];
    const coach = scriptedCoach([
      { reply: "I'm checking details on 5 finds nearby - I'll text you the good ones." },
      {
        reply: "I'm checking details on 5 finds nearby - I'll text you the good ones.",
        activityPromise: { subject: 'toddler classes nearby', childId: null },
      },
    ]);
    const h = harness({
      coach,
      recordActivityPromise: async (_db, input) => {
        promises.push(input);
        return { status: 'recorded' as const, commitmentId: PROMISE_COMMITMENT_ID };
      },
    });
    await routeChannelMessage(h.deps, job());

    // Asked twice: the first attempt promised with nothing registered, and the violation
    // told the second what to do about it.
    expect(coach.rejected).toHaveLength(2);
    expect(coach.rejected[0]).toEqual([]);
    expect(coach.rejected[1]?.[0]).toContain('promise_activity_followup');
    expect(promises).toHaveLength(1);
    expect(h.transport.sent.map((m) => m.body)).toEqual([
      "I'm checking details on 5 finds nearby - I'll text you the good ones.",
    ]);
  });

  it('(b2) the same promise passes on the FIRST attempt when the tool was called', async () => {
    const coach = scriptedCoach([
      {
        reply: "I'm checking details on 5 finds nearby - I'll text you the good ones.",
        activityPromise: { subject: 'toddler classes nearby', childId: null },
      },
    ]);
    const h = harness({ coach });
    await routeChannelMessage(h.deps, job());

    expect(coach.rejected).toEqual([[]]);
  });

  it('(c) Aug 12 — the self-referential promise is cut, and the rest goes out verbatim', async () => {
    const coach = scriptedCoach([
      { reply: "Swim runs Tuesdays at 4. I'll cut the one sec messages and just answer." },
      { reply: "Swim runs Tuesdays at 4. I'll cut the one sec messages and just answer." },
    ]);
    const h = harness({ coach });
    const result = await routeChannelMessage(h.deps, job());

    expect(coach.rejected[1]?.[0]).toContain('promises to change how Hale itself behaves');
    expect(h.transport.sent.map((m) => m.body)).toEqual(['Swim runs Tuesdays at 4.']);
    expect(result.status).toBe('agent_replied');
  });

  it('(c2) a claim naming "St. Mary\'s" is cut whole, never leaving "at St." (VIL-575)', async () => {
    const named = "Swim runs Tuesdays at 4. Your visit at St. Mary's clinic is booked.";
    const coach = scriptedCoach([{ reply: named }, { reply: named }]);
    const h = harness({ coach });
    const result = await routeChannelMessage(h.deps, job());

    expect(h.transport.sent.map((m) => m.body)).toEqual(['Swim runs Tuesdays at 4.']);
    expect(result.status).toBe('agent_replied');
  });

  it('(c3) a cut that would leave a dangling clause fails the turn (VIL-575)', async () => {
    const dangling = "Here's where things stand:\nYour well-baby visit is booked.";
    const coach = scriptedCoach([{ reply: dangling }, { reply: dangling }]);
    const h = harness({ coach, apology: fakeApology({ status: 'composed', reply: 'sorry' }) });
    const result = await routeChannelMessage(h.deps, job());

    // Never "Here's where things stand:" on its own: the turn's failure path answers.
    expect(h.transport.sent.map((m) => m.body)).toEqual(['sorry']);
    expect(result.status).toBe('agent_failed');
    expect(JSON.stringify(h.logs)).toContain('"reason":"cut_fragment"');
  });

  it('(d) a booking claim with nothing on the calendar never reaches the wire', async () => {
    const coach = scriptedCoach([
      { reply: 'Your well-baby visit is booked.' },
      { reply: 'Your well-baby visit is booked.' },
    ]);
    const h = harness({ coach, apology: fakeApology({ status: 'composed', reply: 'sorry' }) });
    const result = await routeChannelMessage(h.deps, job());

    // Nothing survived the cut, so the turn is a FAILURE with an apology — not a blank
    // text, and not the claim.
    expect(h.transport.sent.map((m) => m.body)).toEqual(['sorry']);
    expect(result.status).toBe('agent_failed');
  });

  it('(d1) a booking claim ending "Sat." is not hidden by the question after it (VIL-575)', async () => {
    const asked = 'Your well-baby visit is booked for Sat. Want me to add a reminder?';
    const coach = scriptedCoach([{ reply: asked }, { reply: asked }]);
    const h = harness({ coach, apology: fakeApology({ status: 'composed', reply: 'sorry' }) });
    const result = await routeChannelMessage(h.deps, job());

    expect(h.transport.sent.map((m) => m.body)).toEqual(['sorry']);
    expect(result.status).toBe('agent_failed');
  });

  it('(d2) the same claim is sent when the calendar actually holds it', async () => {
    const h = harness({
      coach: fakeCoach('Your well-baby visit is booked.'),
      reconcileView: async () => emptyReconcileView({ scheduledTitles: ['Well-baby checkup'] }),
    });
    await routeChannelMessage(h.deps, job());

    expect(h.transport.sent.map((m) => m.body)).toEqual(['Your well-baby visit is booked.']);
  });

  it('(e) a second-person prediction is not a claim — one attempt, sent verbatim', async () => {
    const coach = scriptedCoach([
      { reply: "You'll want to register soon - Halton Hills opens Sep 1." },
    ]);
    const minted: unknown[] = [];
    const h = harness({
      coach,
      recordRegistrationWatch: async (_db, input) => {
        minted.push(input);
        return { status: 'recorded' as const };
      },
    });
    await routeChannelMessage(h.deps, job());

    expect(coach.rejected).toEqual([[]]);
    expect(minted).toEqual([]);
    expect(h.transport.sent.map((m) => m.body)).toEqual([
      "You'll want to register soon - Halton Hills opens Sep 1.",
    ]);
  });

  it('(e2) a quoted parent promise is not a claim', async () => {
    const coach = scriptedCoach([
      { reply: 'Your note said "I\'ll sign her up Monday" so I have not touched it.' },
    ]);
    const h = harness({ coach });
    await routeChannelMessage(h.deps, job());

    expect(coach.rejected).toEqual([[]]);
    expect(h.transport.sent).toHaveLength(1);
  });

  it('an ordinary reply costs one attempt and no rewrite', async () => {
    const coach = scriptedCoach([{ reply: 'Swim runs Tuesdays at 4 at the Gellert.' }]);
    const h = harness({ coach });
    await routeChannelMessage(h.deps, job());

    expect(coach.rejected).toEqual([[]]);
    expect(h.transport.sent.map((m) => m.body)).toEqual([
      'Swim runs Tuesdays at 4 at the Gellert.',
    ]);
  });
});

/**
 * VIL-294 · the inbound half's CALL SITE. What the parent settled becomes a row before
 * anything reads state — the DB-level behaviour of that row is pinned over real Postgres
 * in lib/__journey__/stated-fact-remembered.test.ts; what is pinned here is the ORDER,
 * which is the whole reason the write lives in the router rather than after the reply.
 */
describe('what the parent stated is written before anything reads it', () => {
  function statefulHarness(options: { handlers?: DeterministicHandler[]; body?: string } = {}) {
    const order: string[] = [];
    const bodies: string[] = [];
    const coach: ChannelCoachRuntime = {
      async respond() {
        order.push('coach');
        return { reply: 'noted', planOffer: null, activityPromise: null, spotWatch: null };
      },
    };
    const h = harness({
      handlers: options.handlers,
      context: { body: options.body ?? 'Yes we booked already' },
      coach,
      recordStatedState: async (_db, input) => {
        order.push('stated');
        bodies.push(input.body);
        return { status: 'recorded' as const, state: 'health_visit_handled' as const, ref: 'r' };
      },
      reconcileView: async () => {
        order.push('view');
        return emptyReconcileView();
      },
    });
    return { h, order, bodies };
  }

  it('hands the reader the parent\u2019s own words, before the coach composes', async () => {
    const { h, order, bodies } = statefulHarness();
    await routeChannelMessage(h.deps, job());

    expect(bodies).toEqual(['Yes we booked already']);
    // Stated FIRST, and the position is asserted absolutely: `indexOf` returns -1 for a
    // call that never happened, so "before the coach" alone passes when nothing ran.
    expect(order[0]).toBe('stated');
    expect(order).toContain('coach');
  });

  it('writes before the reconciliation view is read, so the ack can be backed', async () => {
    const { h, order } = statefulHarness();
    await routeChannelMessage(h.deps, job());

    expect(order[0]).toBe('stated');
    expect(order).toContain('view');
  });

  it('never runs on a turn a deterministic handler already claimed', async () => {
    // The closed vocabulary answers itself and files its own row; a second reading of
    // the same words would supersede a fact that was just written.
    const claimer: DeterministicHandler = {
      name: 'claimer',
      handle: async () => ({ claimed: true, outcome: 'recorded_done', reply: 'Filed.' }),
    };
    const { h, order } = statefulHarness({ handlers: [claimer], body: 'done' });
    await routeChannelMessage(h.deps, job());

    expect(order).toEqual([]);
  });

  it('says out loud when it read a settled state and found nothing to settle', async () => {
    const h = harness({
      context: { body: 'Yes we booked already' },
      recordStatedState: async () => ({
        status: 'not_recorded' as const,
        state: 'health_visit_handled' as const,
        reason: 'no_open_checkpoint' as const,
      }),
    });
    await routeChannelMessage(h.deps, job());

    expect(JSON.stringify(h.logs)).toContain('nothing was open to settle');
  });
});

/**
 * THE QUESTION-TIME DISPATCH — the promise becomes a row AND a job, in the same breath.
 *
 * The row is #532's, unchanged: the coach's tool registers an intent, the router writes it
 * against the message that carried it once the transport accepts. What is new is the four
 * lines after: every recorded promise also goes on a queue the drain
 * runs within the minute, so the parent gets the dated answer in minutes rather than in a
 * day.
 *
 * THE MUTATION AT THE BOTTOM IS THE POINT OF THE WHOLE BLOCK. Delete the enqueue and
 * nothing breaks, nothing throws and nobody is worse off than they were last week — the
 * ledger row is still there and the hourly sweep still keeps it. That is exactly why the
 * dispatch has to be a COUNTED outcome rather than a fire-and-forget: an enqueue that
 * silently stopped happening is invisible from every other signal in the system.
 */
describe('a promise worth opening pages for is dispatched at question time', () => {
  function promisingCoach(subject: string): ChannelCoachRuntime {
    return {
      async respond() {
        return {
          reply: `Cartwheels runs a parent and tot block. I'll go and read their fall schedule and text you.`,
          planOffer: null,
          activityPromise: { subject, childId: null },
          spotWatch: null,
        };
      },
    };
  }

  it('mints the commitment AND enqueues the deep pass keyed to it', async () => {
    const promises: unknown[] = [];
    const dispatched: unknown[] = [];
    const askers: unknown[] = [];
    const h = harness({
      coach: promisingCoach('Cartwheels Gym Centre fall schedule'),
      recordActivityPromise: async (_db, input) => {
        promises.push(input);
        return { status: 'recorded' as const, commitmentId: PROMISE_COMMITMENT_ID };
      },
      dispatchDeepResearch: async (payload, askedBy) => {
        dispatched.push(payload);
        askers.push(askedBy);
        return { status: 'enqueued' as const };
      },
    });

    await routeChannelMessage(h.deps, job());

    // The reply went first, and the row is minted against the message that carried it.
    expect(h.transport.sent).toHaveLength(1);
    expect(promises).toHaveLength(1);
    expect(promises[0]).toMatchObject({
      familyId: FAMILY,
      channelMessageId: ledgerRows(h.fake)[0]?.id,
    });
    // ONE job, keyed to the promise that was just written — never to the message, never
    // to the family: the commitment is what the job is about and what it re-reads.
    expect(dispatched).toEqual([{ commitment_id: PROMISE_COMMITMENT_ID, family_id: FAMILY }]);
    // The adult whose ask it was, so the dispatch's audit row is theirs (VIL-635).
    expect(askers).toEqual([PARENT]);
  });

  // A subject is never read for keywords to decide this: the promise was made, so it is
  // researched now. These two named no place and no timetable, and used to wait a day.
  it.each([['indoor swim lessons'], ['幼儿游泳课']])(
    'enqueues the deep pass for every recorded promise (%s)',
    async (subject) => {
      const dispatched: unknown[] = [];
      const h = harness({
        coach: promisingCoach(subject),
        recordActivityPromise: async () => ({
          status: 'recorded' as const,
          commitmentId: PROMISE_COMMITMENT_ID,
        }),
        dispatchDeepResearch: async (payload) => {
          dispatched.push(payload);
          return { status: 'enqueued' as const };
        },
      });

      await routeChannelMessage(h.deps, job());

      expect(dispatched).toEqual([{ commitment_id: PROMISE_COMMITMENT_ID, family_id: FAMILY }]);
      expect(h.logs).toContainEqual([{ dispatch: 'enqueued' }, expect.any(String)]);
    },
  );

  it('does not enqueue against a promise that was never recorded', async () => {
    const dispatched: unknown[] = [];
    const h = harness({
      coach: promisingCoach('Cartwheels Gym Centre fall schedule'),
      recordActivityPromise: async () => ({
        status: 'not_recorded' as const,
        reason: 'no_ledger_row' as const,
      }),
      dispatchDeepResearch: async (payload) => {
        dispatched.push(payload);
        return { status: 'enqueued' as const };
      },
    });

    await routeChannelMessage(h.deps, job());

    expect(dispatched).toEqual([]);
    expect(JSON.stringify(h.logs)).toContain('not_recorded');
  });

  /**
   * THE MUTATION: the queue is gone. The parent must still have been promised, the row
   * must still exist and be open, and the failure must be VISIBLE — because the only
   * thing that changed for the parent is that their answer now takes a day.
   */
  it('leaves the promise standing and COUNTS the failure when the enqueue cannot happen', async () => {
    const promises: unknown[] = [];
    const h = harness({
      coach: promisingCoach('Cartwheels Gym Centre fall schedule'),
      recordActivityPromise: async (_db, input) => {
        promises.push(input);
        return { status: 'recorded' as const, commitmentId: PROMISE_COMMITMENT_ID };
      },
      dispatchDeepResearch: async () => ({
        status: 'not_enqueued' as const,
        reason: 'queue_unavailable' as const,
      }),
    });

    await routeChannelMessage(h.deps, job());

    expect(h.transport.sent).toHaveLength(1);
    // The debt exists. The sweep will keep it.
    expect(promises).toHaveLength(1);
    // And the lost speed is on the record rather than nowhere.
    expect(JSON.stringify(h.logs)).toContain('queue_unavailable');
  });
});

/**
 * VIL-304 — THE CLARIFIER OWNS THE NEXT REPLY.
 *
 * On 2026-08-24 the founder answered an offer with "YES", got "Which one - add to your
 * calendar, sending your welcome note to the new family or note in your digest?", quoted
 * one of those options straight back, and was told Hale cannot message other families.
 *
 * The menu was a sentence Hale said and then forgot. Nothing anywhere recorded that
 * three named options had just been put in front of this parent, so the next inbound was
 * read cold against every open question at once — and a reply that names a target with
 * no yes or no in it reads as `no_target` (resolve.ts `toReading`, pinned in both
 * directions by resolve.test.ts), which is the coach lane, which cannot send that note.
 *
 * These tests drive the REAL reading (`toReading`) over the raw model output those two
 * turns actually produced, so what they pin is the live failure rather than a stipulated
 * fixture: turn one is genuinely ambiguous, turn two genuinely names a target with no
 * polarity. What had to change is that turn two never gets that far.
 */
describe('the disambiguation a clarifier owns', () => {
  const OFFER = 'ffff1111-1111-4111-8111-111111111111';
  const DRAFT = 'aaaa2222-2222-4222-8222-222222222222';

  /** The founder's own standing offer — the one whose YES writes into ANOTHER household,
   * and the one the coach can never send for itself (coach-runtime.ts). */
  const founderOffer = (): OpenQuestion => ({
    id: OFFER,
    kind: 'founder_welcome_offer',
    description: 'An offer to send your welcome note to a new family from the Georgetown poster.',
    subject: 'sending your welcome note to the new family',
    answerable: { yes: true, no: true },
    askedAt: null,
    solicited: false,
  });

  const calendarDraft = (): OpenQuestion => ({
    id: DRAFT,
    kind: 'approval',
    description: 'Add to your calendar',
    subject: 'add to your calendar',
    answerable: { yes: true, no: true },
    askedAt: null,
    solicited: false,
  });

  /**
   * The resolver, driven through its REAL reading of a scripted model output. Faking the
   * READING would let these tests assert against a decision nobody's code makes; faking
   * the model's raw JSON and running `toReading` over it is the live transcript.
   */
  function replayedResolver(
    script: Record<string, { target: string; polarity: string; confidence: string }>,
  ): ReplyResolver & { seen: string[] } {
    const resolver = {
      seen: [] as string[],
      async read({ text, questions }: { text: string; questions: readonly OpenQuestion[] }) {
        resolver.seen.push(text);
        const raw = script[text];
        if (!raw) throw new Error(`replayedResolver: nothing scripted for ${JSON.stringify(text)}`);
        return toReading(raw, questions);
      },
    };
    return resolver;
  }

  /** A stand-in for the handler that owns a kind, claiming only the RESOLVED pass. Named
   * after the real one, whose own declaration is asserted below so this cannot quietly
   * stop mirroring it. */
  function owner(name: string, kind: OpenQuestion['kind']) {
    const seen: Array<Record<string, unknown>> = [];
    return {
      seen,
      handler: {
        name,
        resolves: new Set([kind]),
        async handle(_db: unknown, ctx: { resolved: unknown }) {
          if (!ctx.resolved) return { claimed: false };
          seen.push(ctx.resolved as Record<string, unknown>);
          return { claimed: true, outcome: 'acted', reply: 'Sent - your note is in their thread.' };
        },
      } as unknown as DeterministicHandler,
    };
  }

  /** Successive texts from one parent, each its own inbound message. */
  function conversation(options: Parameters<typeof harness>[0] & { bodies: string[] }): {
    h: Harness;
    run: () => Promise<RouterResult>;
  } {
    const { bodies, ...rest } = options;
    const h = harness(rest);
    let turn = 0;
    h.deps.loadContext = async () => ({
      body: bodies[turn - 1] as string,
      role: 'primary_parent',
      primaryParentName: 'Sam',
      reply: SMS_ROUTE,
      inGroup: false,
    });
    return {
      h,
      run: async () => {
        turn += 1;
        return routeChannelMessage(h.deps, nthJob(turn));
      },
    };
  }

  const NAMED_IT = 'sending your welcome note to the new family';

  it('mirrors the kind the real founder handler declares', () => {
    // The stand-ins above answer for `founder_welcome`. If production ever stopped
    // declaring that kind, every test in this block would go on passing against nothing.
    expect(founderWelcomeHandler({} as never).resolves).toEqual(new Set(['founder_welcome_offer']));
  });

  it('resolves the option the parent quoted back, instead of handing it to the coach', async () => {
    const founder = owner('founder_welcome', 'founder_welcome_offer');
    const coach = fakeCoach('Which one did you mean - the calendar change or the welcome note?');
    const resolver = replayedResolver({
      // Turn one: an answer, and which one cannot be told from the word.
      YES: { target: 'ambiguous', polarity: 'yes', confidence: 'high' },
      // Turn two: the model places the option the parent named.
      [NAMED_IT]: { target: OFFER, polarity: 'yes', confidence: 'high' },
    });
    const c = conversation({
      bodies: ['YES', NAMED_IT],
      handlers: [founder.handler],
      // The turn that broke in production: the coach could not run, so the canned choice
      // sentence went out. The next test drives the same arc through a coach that can.
      coach,
      questions: fakeQuestions([calendarDraft(), founderOffer()]),
      replyResolver: resolver,
    });

    const asked = await c.run();
    expect(asked.status).toBe('agent_replied');
    expect(c.h.transport.bodies()[0]).toMatch(/Which one/i);

    const answered = await c.run();

    expect(answered.status).toBe('resolved');
    expect(answered.handler).toBe('founder_welcome');
    expect(founder.seen).toEqual([
      {
        kind: 'founder_welcome_offer',
        questionId: OFFER,
        polarity: 'yes',
        confidence: 'high',
      },
    ]);
    expect(c.h.transport.bodies()[1]).toBe('Sent - your note is in their thread.');
    expect(resolver.seen).toEqual(['YES', NAMED_IT]);
  });

  it('resolves it after the COACH asked which one, in its own words', async () => {
    const founder = owner('founder_welcome', 'founder_welcome_offer');
    const coach = fakeCoach(
      'Which of those did you mean - the calendar change, or the welcome note?',
    );
    const c = conversation({
      bodies: ['YES', NAMED_IT],
      handlers: [founder.handler],
      coach,
      questions: fakeQuestions([calendarDraft(), founderOffer()]),
      replyResolver: replayedResolver({
        YES: { target: 'ambiguous', polarity: 'yes', confidence: 'high' },
        [NAMED_IT]: { target: OFFER, polarity: 'yes', confidence: 'high' },
      }),
    });

    expect((await c.run()).status).toBe('agent_replied');
    const answered = await c.run();

    expect(answered.status).toBe('resolved');
    expect(founder.seen).toHaveLength(1);
    // One coach turn, the one that asked. The answer did not need a second.
    expect(coach.calls).toBe(1);
  });

  it('does not treat a digit as a menu pick', async () => {
    const founder = owner('founder_welcome', 'founder_welcome_offer');
    const c = conversation({
      bodies: ['YES', '2'],
      handlers: [founder.handler],
      coach: fakeCoach('Which one did you mean - the calendar change or the welcome note?'),
      questions: fakeQuestions([calendarDraft(), founderOffer()]),
      replyResolver: replayedResolver({
        YES: { target: 'ambiguous', polarity: 'yes', confidence: 'high' },
        '2': { target: 'none', polarity: 'unclear', confidence: 'low' },
      }),
    });

    const asked = await c.run();
    expect(c.h.transport.bodies()[0]).toMatch(/Which one/i);
    expect(c.h.transport.bodies()[0]).not.toContain('2)');
    expect(asked.status).toBe('agent_replied');

    expect((await c.run()).status).toBe('agent_replied');
    expect(founder.seen).toEqual([]);
  });

  it('is spent by the next text whatever that text says', async () => {
    const founder = owner('founder_welcome', 'founder_welcome_offer');
    const c = conversation({
      bodies: ['YES', 'what time is storytime on saturday', NAMED_IT],
      handlers: [founder.handler],
      coach: fakeCoach(),
      questions: fakeQuestions([calendarDraft(), founderOffer()]),
      replyResolver: replayedResolver({
        YES: { target: 'ambiguous', polarity: 'yes', confidence: 'high' },
        'what time is storytime on saturday': {
          target: 'none',
          polarity: 'unclear',
          confidence: 'high',
        },
        [NAMED_IT]: { target: OFFER, polarity: 'unclear', confidence: 'high' },
      }),
    });

    await c.run();
    // An ordinary question clears it and is answered as an ordinary question.
    expect((await c.run()).status).toBe('agent_replied');
    expect(founder.seen).toEqual([]);

    // And the menu is gone: the same words that would have resolved it a turn ago are
    // now just words, because Hale is no longer standing in front of that question. Its
    // positive control is the first test in this block — the identical body, through the
    // identical harness, reaching the handler — so this cannot pass by never matching.
    expect((await c.run()).status).toBe('agent_replied');
    expect(founder.seen).toEqual([]);
  });

  it('will not carry an answer into a question that has since closed', async () => {
    const founder = owner('founder_welcome', 'founder_welcome_offer');
    const open = [calendarDraft(), founderOffer()];
    const c = conversation({
      bodies: ['YES', NAMED_IT],
      handlers: [founder.handler],
      coach: fakeCoach(),
      questions: fakeQuestions(open),
      replyResolver: replayedResolver({
        YES: { target: 'ambiguous', polarity: 'yes', confidence: 'high' },
        [NAMED_IT]: { target: OFFER, polarity: 'unclear', confidence: 'high' },
      }),
    });

    await c.run();
    // The offer lapsed between the question and the answer. Same positive control as
    // above: these exact words resolve when the row is still there.
    open.splice(1, 1);

    expect((await c.run()).status).toBe('agent_replied');
    expect(founder.seen).toEqual([]);
  });

  /** Two pending drafts, in the queue's own order — a numbering that has nothing to do
   * with the menu Hale just printed. */
  function approvalsQueue() {
    const approved: string[] = [];
    return {
      approved,
      spine: {
        listPending: async () => [
          { actionId: 'a-1', actionType: 'calendar_add' },
          { actionId: 'a-2', actionType: 'calendar_move' },
        ],
        latestUndoable: async () => null,
        approve: async (_db: unknown, args: { actionId: string }) => {
          approved.push(args.actionId);
          return true;
        },
        decline: async () => true,
        undo: async () => true,
      },
    };
  }

  it('never lets the approvals queue read a digit the menu was standing for', async () => {
    // The offer was option 2 on the menu and lapsed before the answer came back. "yes 2"
    // then fell out of the menu and into the approval grammar, where 2 counts positions
    // in a DIFFERENT list — and the second drafted action, which the parent was never
    // shown and never picked, was executed (rule #4). A digit typed while a menu is
    // standing belongs to that menu and to nothing else.
    const queue = approvalsQueue();
    const open = [calendarDraft(), founderOffer()];
    const c = conversation({
      bodies: ['YES', 'yes 2'],
      handlers: [approvalHandler(queue.spine as never)],
      coach: fakeCoach('Which one did you mean - the calendar change or the welcome note?'),
      questions: fakeQuestions(open),
      replyResolver: replayedResolver({
        YES: { target: 'ambiguous', polarity: 'yes', confidence: 'high' },
        'yes 2': { target: 'none', polarity: 'unclear', confidence: 'high' },
      }),
    });

    await c.run();
    expect(c.h.transport.bodies()[0]).toMatch(/Which one/i);
    expect(c.h.transport.bodies()[0]).not.toContain('2)');
    // Option 2 closes between the question and the answer, so the menu cannot place it.
    open.splice(1, 1);

    await c.run();

    expect(queue.approved).toEqual([]);
  });

  it('does not let a digit approve a drafted action when no menu was standing', async () => {
    const queue = approvalsQueue();
    const c = conversation({
      bodies: ['what time is storytime on saturday', 'yes 2'],
      handlers: [approvalHandler(queue.spine as never)],
      coach: fakeCoach(),
      questions: fakeQuestions([calendarDraft(), founderOffer()]),
      replyResolver: replayedResolver({
        'what time is storytime on saturday': {
          target: 'none',
          polarity: 'unclear',
          confidence: 'high',
        },
        'yes 2': { target: 'none', polarity: 'unclear', confidence: 'high' },
      }),
    });

    await c.run();
    expect((await c.run()).status).toBe('agent_replied');

    expect(queue.approved).toEqual([]);
  });
});

/**
 * VIL-360 · GATE 2c-bis — the weekday-care answer, through the real router.
 *
 * Two claims, and the second one has already cost a live incident on another kind. The
 * fact is written on the turn that hears it and the turn is NOT claimed, so the coach
 * answers in its own voice already knowing the answer; and while Hale is holding this
 * question, a bare "yes" is AMBIGUOUS and must not be spent on an unrelated drafted
 * action.
 */
describe('the weekday-care answer', () => {
  const CHILD = 'cccc1111-1111-4111-8111-111111111111';
  const ASK_ID = 'dddd1111-1111-4111-8111-111111111111';

  /**
   * The REAL open-question reader over stub sources, rather than a hand-written array.
   * The `questions.push` block in open-questions.ts is the one plumbing site with no
   * compiler behind it — forget it and the question is simply never open — so the test
   * that matters most has to go through the code that builds the list.
   */
  function questionsFrom(overrides: Partial<OpenQuestionSources>): OpenQuestionReader {
    const sources: OpenQuestionSources = {
      forwardAddressRevoke: async () => null,
      pendingApprovals: async () => [],
      introOptInOpen: async () => false,
      introProposal: async () => null,
      planOffer: async () => null,
      checkupOffer: async () => null,
      founderWelcomeOffer: async () => null,
      activityPromise: async () => null,
      registrationReadiness: async () => null,
      coParentAssent: async () => null,
      emailAlertOffers: async () => [],
      eveningCheckIn: async () => null,
      activityFollowupAsk: async () => null,
      weekdayCare: async () => null,
      emptySaturday: async () => null,
      daycareFollowup: async () => null,
      ...overrides,
    };
    return createOpenQuestionReader(sources);
  }

  const askStanding = { weekdayCare: async () => ({ id: ASK_ID, askedAt: NOW }) };

  function careHarness(
    options: {
      body?: string;
      target?: ChannelRouterDeps['weekdayCareAnswerTarget'];
      questions?: OpenQuestionReader;
      searchWeekdays?: ChannelRouterDeps['searchWeekdays'];
      reading?: Awaited<ReturnType<ChannelRouterDeps['weekdayCareReader']['read']>>;
      consent?: ChannelRouterDeps['consent'];
    } = {},
  ) {
    const written: Array<{ childId: string; care: string; provider: string | null }> = [];
    const coach = fakeCoach();
    const h = harness({
      context: { body: options.body ?? "she's home with me" },
      coach,
      questions: options.questions ?? questionsFrom(askStanding),
      weekdayCareReader: {
        read: async () => options.reading ?? { status: 'nothing_stated' as const },
      },
      weekdayCareAnswerTarget:
        options.target ?? (async () => ({ status: 'open' as const, childId: CHILD })),
      searchWeekdays: options.searchWeekdays,
      consent: options.consent,
      recordWeekdayCare: async (_db, input) => {
        written.push({ childId: input.childId, care: input.care, provider: input.provider });
        return {
          status: 'recorded' as const,
          care: input.care,
          providerNamed: input.provider !== null,
        };
      },
    });
    return { h, written, coach };
  }

  it('writes the fact, does not claim the turn, and lets the coach answer', async () => {
    const { h, written, coach } = careHarness({
      reading: { status: 'read', care: 'home', provider: null },
    });

    const result = await routeChannelMessage(h.deps, job());

    // The child comes from the ASK, not from the words - "she's home with me" names
    // nobody.
    expect(written).toEqual([{ childId: CHILD, care: 'home', provider: null }]);
    // No reply string is asserted, because there is no reply string: the coach composes
    // it, with the fact already in its context.
    expect(coach.calls).toBe(1);
    expect(result.status).toBe('agent_replied');
  });

  it('records the provider when the reader named one', async () => {
    const { h, written } = careHarness({
      body: 'she goes to Little Sprouts',
      reading: { status: 'read', care: 'daycare', provider: 'Little Sprouts' },
    });

    await routeChannelMessage(h.deps, job());

    expect(written).toEqual([{ childId: CHILD, care: 'daycare', provider: 'Little Sprouts' }]);
  });

  it('logs an unreadable answer and writes nothing', async () => {
    const { h, written, coach } = careHarness({ body: 'what do you mean?' });

    await routeChannelMessage(h.deps, job());

    expect(written).toEqual([]);
    expect(JSON.stringify(h.logs)).toContain('settles neither side');
    // ...and never the words themselves: a message about a child's care arrangement is
    // the last thing that belongs in a log line.
    expect(JSON.stringify(h.logs)).not.toContain('what do you mean');
    expect(coach.calls).toBe(1);
  });

  it('does not answer an SMS question through a different door, and says so', async () => {
    const { h, written } = careHarness({
      target: async () => ({ status: 'wrong_channel' as const }),
    });

    await routeChannelMessage(h.deps, job());

    expect(written).toEqual([]);
    // NAMED, not swallowed (rule #11). An email landing inside an SMS question's window
    // is a different thing to know from a question nobody asked, and a refusal nothing
    // records is a refusal nobody can tell from a turn where the gate never ran.
    expect(JSON.stringify(h.logs)).toContain('wrong_channel');
    // ...and still never the words themselves.
    expect(JSON.stringify(h.logs)).not.toContain("she's home with me");
  });

  it('costs nothing when Hale is holding no such question', async () => {
    let reads = 0;
    const { h, written } = careHarness({
      questions: questionsFrom({}),
      target: async () => {
        reads += 1;
        return { status: 'no_open_ask' as const };
      },
    });

    await routeChannelMessage(h.deps, job());

    expect(written).toEqual([]);
    // The memoised list already said nothing is standing, so the ledger reader is never
    // reached on the turn every parent actually has.
    expect(reads).toBe(0);
  });

  /**
   * THE THEFT TEST. A drafted action awaiting approval AND the weekday-care ask
   * standing; the parent types "yes". `soleOpenKind` must refuse it, because a bare
   * affirmative near an either/or question means nothing.
   *
   * MUTATION: delete the `weekday_care` block from `createOpenQuestionReader` and this
   * goes red — `questions.every(q => q.kind === 'approval')` becomes true, the approval
   * grammar claims the word, and a calendar write the parent never picked executes.
   */
  /** One drafted calendar add, in both shapes the chain needs it: the spine's pending
   * list and the open-question source's. */
  function oneDraft() {
    const approved: string[] = [];
    const pending = [{ actionId: 'a-1', actionType: 'calendar_add', reviewerApproved: true }];
    return {
      approved,
      pending,
      spine: {
        listPending: async () => pending,
        latestUndoable: async () => null,
        approve: async (_db: unknown, args: { actionId: string }) => {
          approved.push(args.actionId);
          return true;
        },
        decline: async () => true,
        undo: async () => true,
      },
    };
  }

  it('never lets a bare yes be spent on a drafted action', async () => {
    const queue = oneDraft();
    const coach = fakeCoach();
    const h = harness({
      context: { body: 'yes' },
      coach,
      handlers: [approvalHandler(queue.spine as never)],
      questions: questionsFrom({
        ...askStanding,
        pendingApprovals: async () => queue.pending as never,
      }),
      weekdayCareAnswerTarget: async () => ({ status: 'open' as const, childId: CHILD }),
    });

    await routeChannelMessage(h.deps, job());

    expect(queue.approved).toEqual([]);
    expect(coach.calls).toBe(1);
  });

  /** The positive control beside it: with no weekday-care ask standing, the SAME bare
   * "yes" and the SAME draft still approve — so the test above is proving a block
   * rather than a chain that never worked. */
  it('still approves when the model reads the draft as the yes', async () => {
    const queue = oneDraft();
    const h = harness({
      context: { body: 'yes' },
      handlers: [approvalHandler(queue.spine as never)],
      questions: questionsFrom({ pendingApprovals: async () => queue.pending as never }),
      replyResolver: fakeResolver({
        status: 'resolved',
        questionId: 'a-1',
        kind: 'approval',
        polarity: 'yes',
        confidence: 'high',
      }),
    });

    await routeChannelMessage(h.deps, job());

    expect(queue.approved).toEqual(['a-1']);
  });

  /**
   * VIL-513. The coach asked "Add Trunk or Treat …?" which is one drafted calendar
   * add. A bare YES must approve that draft. It must not reach the coach, which
   * would draft the same add again.
   */
  it('approves the pending calendar add when YES answers the coach offer', async () => {
    const approved: string[] = [];
    const spine = {
      listPending: async () => [
        { actionId: 'a-1', actionType: 'calendar_add', reviewerApproved: true },
      ],
      latestUndoable: async () => null,
      approve: async (_db: unknown, args: { actionId: string }) => {
        approved.push(args.actionId);
        return { ok: true as const };
      },
      decline: async () => ({ ok: true as const }),
      undo: async () => ({ ok: true as const }),
    };
    const coach = fakeCoach();
    let calendarReads = 0;
    const resolver = fakeResolver({ status: 'unresolved', reason: 'ambiguous' });
    const offer: OpenQuestion = {
      id: 'offer-1',
      kind: 'email_alert_add',
      description: 'An offer to put Trunk or Treat on your week, starting 2026-10-31T19:00:00.000Z',
      subject: 'putting Trunk or Treat on your week',
      answerable: { yes: true, no: true },
      askedAt: NOW,
      solicited: true,
      approvesActionId: 'a-1',
    };
    const h = harness({
      context: { body: 'YES' },
      coach,
      handlers: [approvalHandler(spine as never)],
      questions: fakeQuestions([
        {
          id: 'a-flagged',
          kind: 'approval',
          description: 'Add to your calendar',
          subject: 'add to your calendar',
          answerable: { yes: false, no: true },
          askedAt: null,
          solicited: false,
        },
        offer,
      ]),
      replyResolver: resolver,
      calendarOffers: {
        readParent: async () => {
          calendarReads += 1;
          return {
            status: 'resolved' as const,
            questionId: 'offer-1',
            kind: 'email_alert_add' as const,
            polarity: 'yes' as const,
            confidence: 'high' as const,
          };
        },
        readCoach: async () => ({ status: 'none' as const, reason: 'no_offer' as const }),
      },
    });

    const result = await routeChannelMessage(h.deps, job());

    expect(calendarReads).toBe(1);
    expect(resolver.calls).toBe(0);
    expect(approved).toEqual(['a-1']);
    expect(coach.calls).toBe(0);
    expect(result).toMatchObject({ status: 'resolved', handler: 'approval' });
    expect(h.transport.sent).toEqual([]);
  });

  it('declines the paired calendar draft when NO answers the coach offer', async () => {
    const declined: string[] = [];
    const spine = {
      listPending: async () => [
        { actionId: 'a-1', actionType: 'calendar_add', reviewerApproved: true },
      ],
      latestUndoable: async () => null,
      approve: async () => ({ ok: true as const }),
      decline: async (_db: unknown, args: { actionId: string }) => {
        declined.push(args.actionId);
        return { ok: true as const };
      },
      undo: async () => ({ ok: true as const }),
    };
    const coach = fakeCoach();
    const offerHandler: DeterministicHandler = {
      name: 'email_alert_add',
      resolves: new Set(['email_alert_add']),
      handle: async () => ({ claimed: true, outcome: 'declined', reply: null }),
    };
    const h = harness({
      context: { body: 'NO' },
      coach,
      handlers: [offerHandler, approvalHandler(spine as never)],
      questions: fakeQuestions([
        {
          id: 'offer-1',
          kind: 'email_alert_add',
          description: 'An offer to put Trunk or Treat on your week',
          subject: 'putting Trunk or Treat on your week',
          answerable: { yes: true, no: true },
          askedAt: NOW,
          solicited: true,
          approvesActionId: 'a-1',
        },
      ]),
      calendarOffers: {
        readParent: async () => ({
          status: 'resolved' as const,
          questionId: 'offer-1',
          kind: 'email_alert_add' as const,
          polarity: 'no' as const,
          confidence: 'high' as const,
        }),
        readCoach: async () => ({ status: 'none' as const, reason: 'no_offer' as const }),
      },
    });

    const result = await routeChannelMessage(h.deps, job());

    expect(declined).toEqual(['a-1']);
    expect(coach.calls).toBe(0);
    expect(result).toMatchObject({ status: 'resolved', handler: 'email_alert_add' });
    expect(h.transport.sent).toEqual([]);
  });

  it('declines every hidden unapproved draft when NO answers the offer, and YES does not approve them', async () => {
    const declined: string[] = [];
    const approved: string[] = [];
    const spine = {
      listPending: async () => [
        { actionId: 'a-held', actionType: 'calendar_add', reviewerApproved: false },
        { actionId: 'a-held-2', actionType: 'calendar_add', reviewerApproved: false },
      ],
      latestUndoable: async () => null,
      approve: async (_db: unknown, args: { actionId: string }) => {
        approved.push(args.actionId);
        return { ok: true as const };
      },
      decline: async (_db: unknown, args: { actionId: string }) => {
        declined.push(args.actionId);
        return { ok: true as const };
      },
      undo: async () => ({ ok: true as const }),
    };
    const offer = {
      id: 'offer-1',
      kind: 'email_alert_add' as const,
      description: 'An offer to put Picture day on your week',
      subject: 'putting Picture day on your week',
      answerable: { yes: true, no: true },
      askedAt: NOW,
      solicited: true,
      declinesActionId: 'a-held',
      declinesActionIds: ['a-held', 'a-held-2'],
    };
    const offerHandler: DeterministicHandler = {
      name: 'email_alert_add',
      resolves: new Set(['email_alert_add']),
      handle: async () => ({ claimed: true, outcome: 'declined', reply: null }),
    };
    const no = harness({
      context: { body: 'NO' },
      coach: fakeCoach(),
      handlers: [offerHandler, approvalHandler(spine as never)],
      questions: fakeQuestions([offer]),
      calendarOffers: {
        readParent: async () => ({
          status: 'resolved' as const,
          questionId: 'offer-1',
          kind: 'email_alert_add' as const,
          polarity: 'no' as const,
          confidence: 'high' as const,
        }),
        readCoach: async () => ({ status: 'none' as const, reason: 'no_offer' as const }),
      },
    });

    await routeChannelMessage(no.deps, job());
    expect(declined).toEqual(['a-held', 'a-held-2']);
    expect(approved).toEqual([]);

    const yesHandler: DeterministicHandler = {
      name: 'email_alert_add',
      resolves: new Set(['email_alert_add']),
      handle: async () => ({ claimed: true, outcome: 'added', reply: null }),
    };
    const yes = harness({
      context: { body: 'YES' },
      coach: fakeCoach(),
      handlers: [yesHandler, approvalHandler(spine as never)],
      questions: fakeQuestions([offer]),
      calendarOffers: {
        readParent: async () => ({
          status: 'resolved' as const,
          questionId: 'offer-1',
          kind: 'email_alert_add' as const,
          polarity: 'yes' as const,
          confidence: 'high' as const,
        }),
        readCoach: async () => ({ status: 'none' as const, reason: 'no_offer' as const }),
      },
    });

    const result = await routeChannelMessage(yes.deps, job());
    expect(approved).toEqual([]);
    expect(result).toMatchObject({ status: 'resolved', handler: 'email_alert_add' });
  });

  it('a yes to the finder ask searches and does not write a care fact', async () => {
    const searches: Array<{ familyId: string; prompt: string }> = [];
    const { h, written, coach } = careHarness({
      body: 'yes',
      consent: { read: async () => ({ verdict: 'yes', target: 'none' }) },
      target: async () => ({
        status: 'open' as const,
        scope: 'search' as const,
        prompt: 'after_school' as const,
        eventKey: null,
      }),
      searchWeekdays: async (input) => {
        searches.push({ familyId: input.familyId, prompt: input.prompt });
        return {
          status: 'deliver' as const,
          body: 'Armour Heights after school. Toronto Parks lists it for ages 6-12.',
        };
      },
    });

    const result = await routeChannelMessage(h.deps, job());

    expect(written).toEqual([]);
    expect(searches).toEqual([{ familyId: FAMILY, prompt: 'after_school' }]);
    expect(coach.calls).toBe(0);
    expect(result).toMatchObject({ status: 'handled', handler: 'weekday_search' });
    expect(h.transport.sent.map((sent) => sent.body).join('\n')).toContain('Toronto Parks');
  });

  it('a yes with no grounded pick abstains and does not invent a venue', async () => {
    const { h, written, coach } = careHarness({
      body: 'yes',
      consent: { read: async () => ({ verdict: 'yes', target: 'none' }) },
      target: async () => ({
        status: 'open' as const,
        scope: 'search' as const,
        prompt: 'weekend_fallback' as const,
        eventKey: null,
      }),
      searchWeekdays: async () => ({ status: 'abstain' as const, reason: 'no_picks' }),
    });

    await routeChannelMessage(h.deps, job());

    expect(written).toEqual([]);
    expect(JSON.stringify(h.logs)).toContain('no_picks');
    expect(JSON.stringify(h.transport.sent)).not.toContain('EarlyON');
    expect(coach.calls).toBe(1);
  });

  it('does not store daycare from a sentence that answers a search ask', async () => {
    const { h, written } = careHarness({
      body: "she's at daycare",
      target: async () => ({
        status: 'open' as const,
        scope: 'search' as const,
        prompt: 'after_school' as const,
        eventKey: null,
      }),
    });

    await routeChannelMessage(h.deps, job());

    expect(written).toEqual([]);
  });
});

/**
 * VIL-360 · THE THEFT TEST, for the daycare check-in.
 *
 * `sendFollowup` writes a ledger row, threads the message, and registers nothing. So
 * until the thirteenth kind existed, "how is Little Sprouts going?" plus one drafted
 * action plus a bare "yes" executed that action: `questions.every(q => q.kind ===
 * 'approval')` was true, `mayClaimBareWord` returned true, and a calendar write the
 * parent never picked went through.
 *
 * This is the one test in this file whose absence has already cost a live incident on
 * another kind.
 */
describe('a bare yes while the daycare check-in is standing', () => {
  const ASK_ID = 'eeee1111-1111-4111-8111-111111111111';

  function sources(overrides: Partial<OpenQuestionSources>): OpenQuestionReader {
    return createOpenQuestionReader({
      forwardAddressRevoke: async () => null,
      pendingApprovals: async () => [],
      introOptInOpen: async () => false,
      introProposal: async () => null,
      planOffer: async () => null,
      checkupOffer: async () => null,
      founderWelcomeOffer: async () => null,
      activityPromise: async () => null,
      registrationReadiness: async () => null,
      coParentAssent: async () => null,
      emailAlertOffers: async () => [],
      eveningCheckIn: async () => null,
      activityFollowupAsk: async () => null,
      weekdayCare: async () => null,
      emptySaturday: async () => null,
      daycareFollowup: async () => null,
      ...overrides,
    });
  }

  function draftQueue() {
    const approved: string[] = [];
    const pending = [{ actionId: 'a-1', actionType: 'calendar_add', reviewerApproved: true }];
    return {
      approved,
      pending,
      spine: {
        listPending: async () => pending,
        latestUndoable: async () => null,
        approve: async (_db: unknown, args: { actionId: string }) => {
          approved.push(args.actionId);
          return true;
        },
        decline: async () => true,
        undo: async () => true,
      },
    };
  }

  it('does not approve the draft', async () => {
    const queue = draftQueue();
    const coach = fakeCoach();
    const h = harness({
      context: { body: 'yes' },
      coach,
      handlers: [approvalHandler(queue.spine as never)],
      questions: sources({
        pendingApprovals: async () => queue.pending as never,
        daycareFollowup: async () => ({ id: ASK_ID, askedAt: NOW }),
      }),
    });

    await routeChannelMessage(h.deps, job());

    expect(queue.approved).toEqual([]);
    // ...and the turn is not lost: the coach answers, having been told what is standing.
    expect(coach.calls).toBe(1);
  });

  it('still approves it when the model reads that draft as the yes', async () => {
    // The positive control, through the identical handler and spine. An absence test
    // that cannot tell "blocked" from "nothing happened" is not a test.
    const queue = draftQueue();
    const h = harness({
      context: { body: 'yes' },
      handlers: [approvalHandler(queue.spine as never)],
      questions: sources({ pendingApprovals: async () => queue.pending as never }),
      replyResolver: fakeResolver({
        status: 'resolved',
        questionId: 'a-1',
        kind: 'approval',
        polarity: 'yes',
        confidence: 'high',
      }),
    });

    await routeChannelMessage(h.deps, job());

    expect(queue.approved).toEqual(['a-1']);
  });
});

describe('turn deadline (VIL-400)', () => {
  it('fails a turn that outlives its deadline and sends nothing', async () => {
    const h = harness({
      turnDeadlineMs: 40,
      coach: {
        async respond() {
          await new Promise(() => {});
          return { reply: 'late', planOffer: null, activityPromise: null, spotWatch: null };
        },
      },
    });

    await expect(routeChannelMessage(h.deps, job())).rejects.toMatchObject({
      name: 'TurnDeferred',
      reason: 'turn_timeout',
    });
    expect(h.transport.sent).toEqual([]);
    expect(h.turns.deferredReasons).toEqual([expect.objectContaining({ reason: 'turn_timeout' })]);
  });

  it('returns the reply without waiting for the workstream extract', async () => {
    waitUntil.mockClear();
    let release: () => void = () => undefined;
    const extracted = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const h = harness({});
    h.deps.rememberWorkstream = async () => {
      started = true;
      await extracted;
    };

    const result = await Promise.race([
      routeChannelMessage(h.deps, job()),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('extract held the queue')), 2000);
      }),
    ]);

    expect(result.status).toBe('agent_replied');
    expect(started).toBe(true);
    expect(h.transport.sent).toHaveLength(1);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    const pending = waitUntil.mock.calls[0]?.[0];
    expect(pending).toBeInstanceOf(Promise);
    release();
    await extracted;
    await pending;
  });

  it('treats a stalled stated-state read as nothing stated and still answers', async () => {
    const h = harness({
      callTimeoutMs: 30,
      recordStatedState: () => new Promise(() => ({ status: 'nothing_stated' as const })),
    });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('agent_replied');
    expect(h.transport.sent).toHaveLength(1);
    expect(h.turns.unanswered).toEqual([expect.objectContaining({ reason: 'gate_timeout' })]);
  });

  it('does not send the reply when an effect read finishes after the deadline', async () => {
    vi.stubEnv('LINQ_EFFECTS_ENABLED', 'true');
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('LINQ_API_KEY', 'test-key');
    effectDecide.mockRejectedValue(new DeadlineError('turn_timeout'));
    const posts: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      posts.push(new URL(url).pathname);
      return Response.json({ message: { id: 'late' } }, { status: 201 });
    });
    const h = harness({
      context: {
        body: 'we got in for swim',
        reply: { channel: 'imessage', to: PHONE, chatId: 'chat-1', replyToMessageId: 'in-1' },
      },
    });

    await expect(routeChannelMessage(h.deps, job())).rejects.toMatchObject({
      name: 'TurnDeferred',
      reason: 'turn_timeout',
    });
    expect(posts.filter((path) => path.endsWith('/messages'))).toEqual([]);
    expect(h.transport.sent).toEqual([]);
    effectDecide.mockReset();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});

describe('an iMessage effect does not send the reply twice', () => {
  const IMESSAGE: ReplyRoute = {
    channel: 'imessage',
    to: PHONE,
    chatId: 'chat-1',
    replyToMessageId: 'in-1',
  };

  function effectTurn(options: Parameters<typeof harness>[0] = {}) {
    vi.stubEnv('LINQ_EFFECTS_ENABLED', 'true');
    vi.stubEnv('LINQ_API_KEY', 'test-key');
    effectDecide.mockResolvedValue({ effect: { type: 'screen', name: 'confetti' } });
    return harness({
      coach: fakeCoach('You are in for swim.'),
      context: { body: 'we got in for swim', reply: IMESSAGE },
      ...options,
    });
  }

  afterEach(() => {
    effectDecide.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('does not post a plain copy when Linq accepts and returns no message id', async () => {
    const h = effectTurn();
    vi.stubEnv('OPS_SLACK_WEBHOOK_URL', 'https://hooks.example.test/ops');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const posts: unknown[] = [];
    const pages: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url === 'https://hooks.example.test/ops') {
        pages.push((JSON.parse(String(init?.body)) as { text: string }).text);
        return new Response(null, { status: 200 });
      }
      if (new URL(url).pathname.endsWith('/messages')) posts.push(JSON.parse(String(init?.body)));
      return Response.json({}, { status: 201 });
    });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('agent_replied');
    expect(posts).toHaveLength(1);
    expect(h.transport.sent).toEqual([]);
    expect(h.turns.answered).toEqual([job().channel_message_id]);
    // Nobody saw Linq take it: the row says so, and ops is paged with that row.
    const out = ledgerRows(h.fake).filter((row) => row.direction === 'out');
    expect(out).toEqual([
      expect.objectContaining({
        templateKey: 'linq:effect',
        providerMessageId: null,
        status: 'queued',
        errorCode: 'delivery_unknown',
      }),
    ]);
    expect(auditRows(h.fake).filter((row) => row.targetId === out[0]?.id)).toEqual([
      expect.objectContaining({ after: { form: 'effect', delivery: 'unknown' } }),
    ]);
    expect(pages).toEqual([
      `Hale: ops page. site linq_effect_delivery_unknown. ref ${out[0]?.id}.`,
    ]);
  });

  it.each([500, 502, 503, 504, 507])(
    'does not post a plain copy when Linq answers %i, which may already have sent it',
    async (httpStatus) => {
      const h = effectTurn();
      const posts: string[] = [];
      vi.stubGlobal('fetch', async (url: string) => {
        const path = new URL(url).pathname;
        if (path.endsWith('/messages')) posts.push(path);
        return Response.json({ error: { message: 'upstream' } }, { status: httpStatus });
      });

      const result = await routeChannelMessage(h.deps, job());

      expect(result.status).toBe('agent_replied');
      expect(posts).toHaveLength(1);
      expect(h.transport.sent).toEqual([]);
      expect(h.turns.answered).toEqual([job().channel_message_id]);
      expect(ledgerRows(h.fake).filter((row) => row.direction === 'out')).toEqual([
        expect.objectContaining({
          templateKey: 'linq:effect',
          providerMessageId: null,
          status: 'queued',
          errorCode: 'delivery_unknown',
        }),
      ]);
    },
  );

  /** The lane's own facts about the reply, never its words: a safety moment it marked,
   * or a medical answer it stamped. */
  const DEFLECTED: OffDomainVerdict = {
    status: 'deflected',
    lane: 'off_domain_general',
    category: 'weather',
    reply: 'The forecast for Saturday is sunny.',
    replySource: 'composed',
    medicalSource: null,
    signal: 'recorded',
    pendingAsk: null,
  };

  it.each([
    [
      'a crisis reply',
      {
        ...DEFLECTED,
        lane: 'safety_critical',
        category: 'mental-health',
        reply: 'a written crisis reply',
        // What the marking lane puts on every crisis reply it wrote.
        crisisReply: true,
        safetyReply: true,
      },
      'safety_reply',
    ],
    [
      'a medical answer',
      {
        ...DEFLECTED,
        lane: 'safety_critical',
        category: 'medical-symptom',
        reply: 'Fevers at this age are usually viral.',
        replySource: 'web_grounded',
        medicalSource: 'web_grounded',
        signal: 'not_applicable',
      },
      'medical_reply',
    ],
    [
      'the fixed health line',
      {
        ...DEFLECTED,
        lane: 'safety_critical',
        category: 'medical-symptom',
        reply: 'MOMENT_CHILD_HEALTH',
        replySource: 'fixed',
        medicalSource: 'fixed',
        signal: 'not_applicable',
      },
      'medical_reply',
    ],
  ] satisfies Array<[string, OffDomainVerdict, string]>)(
    'never asks for an effect on %s, which goes out plain',
    async (_name, verdict, reason) => {
      const info = vi.spyOn(console, 'info');
      const h = effectTurn({ offDomain: fakeLane(verdict) });
      const posts: string[] = [];
      vi.stubGlobal('fetch', async (url: string) => {
        const path = new URL(url).pathname;
        if (path.endsWith('/messages')) posts.push(path);
        return Response.json({ message: { id: 'effect-out' } }, { status: 201 });
      });

      await routeChannelMessage(h.deps, job());

      expect(effectDecide).not.toHaveBeenCalled();
      expect(posts).toEqual([]);
      expect(h.transport.bodies()).toEqual([verdict.reply]);
      // Its own reason, not the bucket for a reply nothing wired a read for.
      expect(info).toHaveBeenCalledWith({ reason }, 'linq effect: not considered');
      expect(info).not.toHaveBeenCalledWith(
        { reason: 'no_decider' },
        'linq effect: not considered',
      );
    },
  );

  it('asks for an effect on an ordinary answer from the same lane (positive control)', async () => {
    const h = effectTurn({ offDomain: fakeLane(DEFLECTED) });
    vi.stubGlobal('fetch', async () =>
      Response.json({ message: { id: 'effect-out' } }, { status: 201 }),
    );

    await routeChannelMessage(h.deps, job());

    expect(effectDecide).toHaveBeenCalledTimes(1);
    expect(h.transport.sent).toEqual([]);
  });

  type MarkingPorts = Parameters<typeof crisisMarkingLane>[1];

  /** Production's marking lane over faked model ports. What it marks comes from the
   * lane's own reading of the text, never from the reply's words. */
  function markingLane(
    database: ChannelRouterDeps['database'],
    over: Pick<MarkingPorts, 'screen'> & Partial<MarkingPorts>,
    moments: string[],
  ): OffDomainLane {
    return crisisMarkingLane(database, {
      answer: {
        compose: async () => {
          throw new Error('not composed on this path');
        },
        continueAsk: async () => ({ status: 'unrelated' }),
      },
      moment: {
        write: async (_text, which) => {
          moments.push(which);
          return { status: 'written', reply: 'a written safety reply' };
        },
      },
      today: async () => '2026-10-20',
      place: async () => ({ status: 'unknown', reason: 'no_postal' }),
      healthPlace: async () => null,
      pendingAsk: async () => ({ status: 'none' }),
      medical: {
        answer: async () => {
          throw new Error('not a medical text');
        },
      },
      recordUnmetIntent: async () => 'recorded',
      ...over,
    });
  }

  const GENERAL_READING = {
    lane: 'off_domain_general',
    category: 'other',
    fallback: null,
    language: 'en',
  } as const;

  it.each([
    [
      'the screen read a child hurt, ill or in danger',
      {
        screen: {
          read: async () => ({
            lane: 'safety_critical',
            category: 'child-safety',
            fallback: null,
            language: 'en',
          }),
        },
      },
    ],
    [
      'the compose read a question about the world as a child in danger',
      {
        screen: { read: async () => GENERAL_READING },
        answer: {
          compose: async () => ({ status: 'safety', kind: 'child-safety' }),
          continueAsk: async () => ({ status: 'unrelated' }),
        },
      },
    ],
    [
      'the reply to an open question read as a child who is ill',
      {
        screen: { read: async () => GENERAL_READING },
        answer: {
          compose: async () => {
            throw new Error('the open question is answered, not a new one');
          },
          continueAsk: async () => ({ status: 'safety', kind: 'medical-symptom' }),
        },
        pendingAsk: async () => ({
          status: 'open',
          ask: { question: 'the weather tomorrow', missing: 'city' },
        }),
      },
    ],
  ] satisfies Array<[string, Pick<MarkingPorts, 'screen'> & Partial<MarkingPorts>]>)(
    'never asks for an effect on a safety reply: %s',
    async (_name, ports) => {
      vi.stubEnv(GENERAL_ANSWER_SEARCH_ENABLED_ENV, 'true');
      const info = vi.spyOn(console, 'info');
      const h = effectTurn();
      const moments: string[] = [];
      h.deps.offDomain = markingLane(h.deps.database, ports, moments);
      const posts: string[] = [];
      vi.stubGlobal('fetch', async (url: string) => {
        const path = new URL(url).pathname;
        if (path.endsWith('/messages')) posts.push(path);
        return Response.json({ message: { id: 'effect-out' } }, { status: 201 });
      });

      await routeChannelMessage(h.deps, job());

      // The lane wrote a child-health moment, and that alone kept the effect read away.
      expect(moments).toEqual(['child_health']);
      expect(effectDecide).not.toHaveBeenCalled();
      expect(posts).toEqual([]);
      expect(h.transport.bodies()).toEqual(['a written safety reply']);
      expect(info).toHaveBeenCalledWith({ reason: 'safety_reply' }, 'linq effect: not considered');
    },
  );

  it('asks for an effect on an answer the same marking lane composed (positive control)', async () => {
    vi.stubEnv(GENERAL_ANSWER_SEARCH_ENABLED_ENV, 'true');
    const h = effectTurn();
    const moments: string[] = [];
    h.deps.offDomain = markingLane(
      h.deps.database,
      {
        screen: { read: async () => GENERAL_READING },
        answer: {
          compose: async () => ({ status: 'composed', reply: 'Sunny all weekend.' }),
          continueAsk: async () => ({ status: 'unrelated' }),
        },
      },
      moments,
    );
    const posts: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/messages')) posts.push(path);
      return Response.json({ message: { id: 'effect-out' } }, { status: 201 });
    });

    await routeChannelMessage(h.deps, job());

    expect(moments).toEqual([]);
    expect(effectDecide).toHaveBeenCalledTimes(1);
    expect(posts).toHaveLength(1);
    expect(h.transport.sent).toEqual([]);
  });

  it('writes the same receipts as a plain reply: audit, thread source, editable bubble', async () => {
    vi.stubEnv('LINQ_MESSAGE_EDIT_ENABLED', 'true');
    // VIL-616: a reply written after reading an email keeps its mark when it carries an effect.
    const coach: ChannelCoachRuntime = {
      async respond() {
        return {
          reply: 'You are in for swim.',
          planOffer: null,
          activityPromise: null,
          spotWatch: null,
          emailRead: true,
        };
      },
    };
    const h = effectTurn({ coach });
    vi.stubEnv('OPS_SLACK_WEBHOOK_URL', 'https://hooks.example.test/ops');
    const called: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      called.push(url);
      return Response.json({ message: { id: 'effect-out' } }, { status: 201 });
    });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('agent_replied');
    expect(h.transport.sent).toEqual([]);
    // A delivered effect pages nobody (the unknown delivery above does).
    expect(called).not.toContain('https://hooks.example.test/ops');
    const out = ledgerRows(h.fake).filter((row) => row.direction === 'out');
    expect(out).toEqual([
      expect.objectContaining({
        templateKey: 'linq:effect',
        providerMessageId: 'effect-out',
        relatedConversationId: result.conversationId,
      }),
    ]);
    expect(auditRows(h.fake).filter((row) => row.targetId === out[0]?.id)).toEqual([
      expect.objectContaining({ actionTaken: 'sms_reply_sent', after: { form: 'effect' } }),
    ]);
    const assistant = messageRows(h.fake).filter((row) => row.role === 'assistant');
    expect(assistant.map((row) => [row.content, row.source, row.providerMessageId])).toEqual([
      ['You are in for swim.', { kind: 'read_email' }, 'effect-out'],
    ]);
  });

  it('is a failure after answering when the ledger write fails after Linq accepts', async () => {
    const h = effectTurn();
    const posts: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      posts.push(new URL(url).pathname);
      return Response.json({ message: { id: 'effect-out' } }, { status: 201 });
    });
    const realDb = h.deps.database;
    const realInsert = realDb.insert.bind(realDb);
    h.deps.database = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop !== 'insert') return Reflect.get(target, prop, receiver);
        return (table: Parameters<typeof realInsert>[0]) => {
          if (table === schema.auditLog) throw new Error('audit insert failed');
          return realInsert(table);
        };
      },
    });

    await routeChannelMessage(h.deps, job());

    // Answered once, and the missing record is a named failure, not a clean answer.
    expect(posts.filter((path) => path.endsWith('/messages'))).toHaveLength(1);
    expect(h.transport.sent).toEqual([]);
    expect(h.turns.answered).toEqual([job().channel_message_id]);
    expect(JSON.stringify(h.logs)).toContain('brokeAfterAnswering');
  });

  it('keeps an effect that went out while the deadline fired, and claims it', async () => {
    const h = effectTurn({ turnDeadlineMs: 500 });
    const posts: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal('fetch', async (url: string) => {
      const path = new URL(url).pathname;
      posts.push(path);
      // Only the effect POST is held; the typing stop the turn's exit sends is not.
      if (path.endsWith('/messages')) await held;
      return Response.json({ message: { id: 'effect-late' } }, { status: 201 });
    });

    await expect(routeChannelMessage(h.deps, job())).rejects.toMatchObject({
      name: 'TurnDeferred',
      reason: 'turn_timeout',
    });
    expect(posts.filter((path) => path.endsWith('/messages'))).toHaveLength(1);
    release();

    // The words are on the phone: the turn is claimed so the re-drive stops at the door,
    // and no plain copy follows.
    await vi.waitFor(() => expect(h.turns.answered).toEqual([job().channel_message_id]));
    await vi.waitFor(() =>
      expect(ledgerRows(h.fake).filter((row) => row.direction === 'out')).toEqual([
        expect.objectContaining({ templateKey: 'linq:effect', providerMessageId: 'effect-late' }),
      ]),
    );
    expect(h.transport.sent).toEqual([]);
  });

  it('still sends the reply plain when Linq refuses the effect', async () => {
    const h = effectTurn();
    vi.stubGlobal('fetch', async () => Response.json({ error: { code: 409 } }, { status: 409 }));

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('agent_replied');
    expect(h.transport.bodies()).toEqual(['You are in for swim.']);
    expect(ledgerRows(h.fake).filter((row) => row.direction === 'out')).toEqual([
      expect.objectContaining({ templateKey: null }),
    ]);
  });
});

// ── a slow answer: the typing bubble stays up and one holding line goes first ──

// ── VIL-495 · the model chose voice: the same reply goes as a memo, or as text ──

describe('a reply the model chose to say as a voice memo (VIL-495)', () => {
  const IM_ROUTE: ReplyRoute = {
    channel: 'imessage',
    to: PHONE,
    chatId: 'chat-voice',
    replyToMessageId: null,
  };
  const SPOKEN = 'So glad swim went well. Same time next week?';

  function voiceCoach(chose: boolean): ChannelCoachRuntime {
    return {
      async respond() {
        return {
          reply: SPOKEN,
          planOffer: null,
          activityPromise: null,
          spotWatch: null,
          voiceMemo: chose,
        };
      },
    };
  }

  function voiceHarness(chose: boolean, outcome: VoiceReplyOutcome) {
    const h = harness({ coach: voiceCoach(chose), context: { reply: IM_ROUTE } });
    const calls: Array<{ input: unknown; familyId: string }> = [];
    h.deps.sendVoiceReply = async (input, familyId) => {
      calls.push({ input, familyId });
      return outcome;
    };
    return { h, calls };
  }

  it('sent as a memo: no text goes out, and the ledger, audit and thread record it', async () => {
    const { h, calls } = voiceHarness(true, { sent: 'voice_memo', providerMessageId: 'vm-1' });

    const result = await routeChannelMessage(h.deps, job({ in_group: false }));

    expect(result.status).toBe('agent_replied');
    expect(h.transport.sent).toEqual([]);
    expect(calls).toEqual([
      {
        input: {
          text: SPOKEN,
          modelChoseVoice: true,
          isGroup: false,
          textOnly: false,
          chatId: 'chat-voice',
          address: PHONE,
        },
        familyId: FAMILY,
      },
    ]);
    const out = ledgerRows(h.fake).filter((row) => row.direction === 'out');
    expect(out).toEqual([
      expect.objectContaining({ channel: 'imessage', providerMessageId: 'vm-1', body: null }),
    ]);
    expect(auditRows(h.fake)).toContainEqual(
      expect.objectContaining({ actionTaken: 'sms_reply_sent', after: { form: 'voice_memo' } }),
    );
    expect(messageRows(h.fake)).toContainEqual(
      expect.objectContaining({ role: 'assistant', content: SPOKEN }),
    );
  });

  it('a memo that cannot go sends the same reply as text, once', async () => {
    const { h, calls } = voiceHarness(true, { sent: 'text', why: 'capability' });

    await routeChannelMessage(h.deps, job({ in_group: false }));

    expect(calls).toHaveLength(1);
    expect(h.transport.bodies()).toEqual([SPOKEN]);
    expect(auditRows(h.fake)).not.toContainEqual(
      expect.objectContaining({ after: { form: 'voice_memo' } }),
    );
  });

  it('a group chat is told it is a group, and gets the text', async () => {
    const { h, calls } = voiceHarness(true, { sent: 'text', why: 'not_one_to_one' });

    await routeChannelMessage(h.deps, job({ in_group: true }));

    expect(calls[0]?.input).toMatchObject({ isGroup: true });
    expect(h.transport.bodies()).toEqual([SPOKEN]);
  });

  describe('with message edit on (VIL-479)', () => {
    beforeEach(() => {
      vi.stubEnv('VERCEL_ENV', 'preview');
      vi.stubEnv('LINQ_MESSAGE_EDIT_ENABLED', 'true');
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('a memo is not an editable bubble: its thread turn carries no provider id', async () => {
      const { h } = voiceHarness(true, { sent: 'voice_memo', providerMessageId: 'vm-1' });

      await routeChannelMessage(h.deps, job({ in_group: false }));

      const assistant = messageRows(h.fake).filter((row) => row.role === 'assistant');
      expect(assistant).toEqual([expect.objectContaining({ content: SPOKEN })]);
      expect(assistant[0]?.providerMessageId).toBeUndefined();
    });

    it('the same reply sent as text keeps its bubble id for a later edit', async () => {
      const { h } = voiceHarness(true, { sent: 'text', why: 'capability' });

      await routeChannelMessage(h.deps, job({ in_group: false }));

      expect(messageRows(h.fake).filter((row) => row.role === 'assistant')).toEqual([
        expect.objectContaining({ content: SPOKEN, providerMessageId: 'fake-out-1' }),
      ]);
    });
  });

  it('the model did not choose voice: the voice send is never asked', async () => {
    const { h, calls } = voiceHarness(false, { sent: 'voice_memo', providerMessageId: 'vm-1' });

    await routeChannelMessage(h.deps, job({ in_group: false }));

    expect(calls).toEqual([]);
    expect(h.transport.bodies()).toEqual([SPOKEN]);
  });
});

describe('a slow answer gets one holding line first', () => {
  const IMESSAGE_ROUTE: ReplyRoute = {
    channel: 'imessage',
    to: PHONE,
    chatId: 'chat-1',
    replyToMessageId: null,
  };

  function slowCoach(ms: number, reply: string): ChannelCoachRuntime {
    const inner = fakeCoach(reply);
    return {
      async respond(turn, rejected) {
        await new Promise((resolve) => setTimeout(resolve, ms));
        return inner.respond(turn, rejected);
      },
    };
  }

  const typingStarts = (logs: unknown[]) =>
    logs.filter((entry) => (entry as [{ phase?: string }])[0]?.phase === 'start').length;

  /** A limiter that takes `ms` to decide: the slow-DB shape a webhook outage produces. */
  function slowLimiter(ms: number, allowed: boolean): RateLimiter {
    return {
      async check() {
        await new Promise((resolve) => setTimeout(resolve, ms));
        return { allowed, retryAfterSec: 0, firstDenied: !allowed };
      },
    };
  }

  beforeEach(() => {
    vi.stubEnv(HOLDING_LINE_ENABLED_ENV, 'true');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('a slow turn: the bubble is re-armed after ONE holding line, and the answer follows it', async () => {
    const holding = fakeHoldingLine("I'm on it.");
    const h = harness({
      coach: slowCoach(120, 'the real answer'),
      holdingLine: holding,
      holdingLineAfterMs: 10,
      context: { reply: IMESSAGE_ROUTE },
    });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('agent_replied');
    expect(h.transport.bodies()).toEqual(["I'm on it.", 'the real answer']);
    expect(holding.calls).toBe(1);
    expect(typingStarts(h.logs)).toBeGreaterThanOrEqual(2);
    expect(ledgerRows(h.fake).filter((r) => r.direction === 'out')).toEqual([
      expect.objectContaining({ templateKey: 'holding_line', body: null }),
      expect.objectContaining({ templateKey: null }),
    ]);
  });

  it('a slow deterministic reply (the plan a "yes" composes) never arms it', async () => {
    const holding = fakeHoldingLine("I'm on it.");
    const slowPlan: DeterministicHandler = {
      name: 'plan',
      handle: async (_db, turn) => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        await turn.send('the plan, part one');
        return { claimed: true, outcome: 'plan_sent', reply: null };
      },
    };
    const h = harness({
      handlers: [slowPlan],
      holdingLine: holding,
      holdingLineAfterMs: 10,
      context: { reply: IMESSAGE_ROUTE },
    });

    await routeChannelMessage(h.deps, job());

    expect(h.transport.bodies()).toEqual(['the plan, part one']);
    expect(holding.calls).toBe(0);
  });

  it('an opt-out the handlers claim never arms it, however slow the turn', async () => {
    const holding = fakeHoldingLine("I'm on it.");
    const slowOptOut: DeterministicHandler = {
      name: 'sms_opt_out',
      handle: async () => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return { claimed: true, outcome: 'opted_out', reply: 'opted out' };
      },
    };
    const h = harness({
      context: { body: 'STOP', reply: IMESSAGE_ROUTE },
      handlers: [slowOptOut],
      holdingLine: holding,
      holdingLineAfterMs: 10,
    });

    const result = await routeChannelMessage(h.deps, job());

    expect(result).toEqual(expect.objectContaining({ status: 'handled', handler: 'sms_opt_out' }));
    expect(h.transport.bodies()).toEqual(['opted out']);
    expect(holding.calls).toBe(0);
  });

  it('a flood-held turn never arms it, however slow the limiter', async () => {
    const holding = fakeHoldingLine("I'm on it.");
    const h = harness({
      limiter: slowLimiter(120, false),
      holdingLine: holding,
      holdingLineAfterMs: 10,
      context: { reply: IMESSAGE_ROUTE },
    });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('flood_held');
    expect(h.transport.bodies()).toEqual(['A lot came in at once.']);
    expect(holding.calls).toBe(0);
  });

  it('the wait is counted from the gates: a slow gate and a fast answer send no line', async () => {
    const holding = fakeHoldingLine("I'm on it.");
    const h = harness({
      limiter: slowLimiter(200, true),
      holdingLine: holding,
      holdingLineAfterMs: 50,
      context: { reply: IMESSAGE_ROUTE },
    });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('agent_replied');
    expect(h.transport.bodies()).toEqual(['coach says hi']);
    expect(holding.calls).toBe(0);
  });

  it.each([
    ['unset', undefined],
    ['a trailing newline', 'true\n'],
    ['padded', ' true'],
  ])(
    'dark unless HOLDING_LINE_ENABLED is exactly true (%s): no line, and lane_off is named',
    async (_label, value) => {
      vi.stubEnv(HOLDING_LINE_ENABLED_ENV, value);
      const holding = fakeHoldingLine("I'm on it.");
      const h = harness({
        coach: slowCoach(120, 'the real answer'),
        holdingLine: holding,
        holdingLineAfterMs: 10,
        context: { reply: IMESSAGE_ROUTE },
      });

      const result = await routeChannelMessage(h.deps, job());

      expect(result.status).toBe('agent_replied');
      expect(h.transport.bodies()).toEqual(['the real answer']);
      expect(holding.calls).toBe(0);
      expect(h.logs).toContainEqual([{ outcome: 'lane_off' }, expect.any(String)]);
    },
  );

  it('a fast turn: no holding line is composed or sent', async () => {
    const holding = fakeHoldingLine();
    const h = harness({
      holdingLine: holding,
      holdingLineAfterMs: 200,
      context: { reply: IMESSAGE_ROUTE },
    });

    await routeChannelMessage(h.deps, job());

    expect(h.transport.bodies()).toEqual(['coach says hi']);
    expect(holding.calls).toBe(0);
  });

  it('a re-driven turn already had its chance: no second holding line', async () => {
    const holding = fakeHoldingLine();
    const turns = fakeTurnLedger();
    turns.deferred.push(job().channel_message_id);
    const h = harness({
      coach: slowCoach(120, 'the real answer'),
      holdingLine: holding,
      holdingLineAfterMs: 10,
      turns,
    });

    await routeChannelMessage(h.deps, job());

    expect(h.transport.bodies()).toEqual(['the real answer']);
    expect(holding.calls).toBe(0);
    expect(h.logs).toContainEqual([{ outcome: 're_driven' }, expect.any(String)]);
  });

  it("a group thread never gets one: it is not one parent's wait to cover in front of others", async () => {
    const groupRoute: ReplyRoute = { ...IMESSAGE_ROUTE, chatId: 'chat-family-group' };
    const turnIn = async (inGroup: boolean) => {
      const holding = fakeHoldingLine("I'm on it.");
      const h = harness({
        coach: slowCoach(120, 'the real answer'),
        holdingLine: holding,
        holdingLineAfterMs: 10,
        context: { reply: groupRoute, inGroup },
      });
      const result = await routeChannelMessage(h.deps, job({ in_group: inGroup }));
      return { result, holding, h };
    };

    const group = await turnIn(true);
    expect(group.result.status).toBe('agent_replied');
    expect(group.h.transport.bodies()).toEqual(['the real answer']);
    expect(group.holding.calls).toBe(0);
    expect(group.h.logs).toContainEqual([{ outcome: 'group_thread' }, expect.any(String)]);

    // Positive control: the same slow turn in the parent's own chat still gets its line.
    const direct = await turnIn(false);
    expect(direct.h.transport.bodies()).toEqual(["I'm on it.", 'the real answer']);
    expect(direct.holding.calls).toBe(1);
    expect(direct.h.logs).toContainEqual([{ outcome: 'sent' }, expect.any(String)]);
  });

  it("keys the group skip on the inbound's own group bit, so a dark group onboarding v2 cannot arm it", async () => {
    // With v2 dark, wiring.ts derives `inGroup` as false for every message, a group one
    // included. The door still knew the chat was a group, and that is the bit that counts.
    const turnIn = async (in_group: boolean) => {
      const holding = fakeHoldingLine("I'm on it.");
      const h = harness({
        coach: slowCoach(120, 'the real answer'),
        holdingLine: holding,
        holdingLineAfterMs: 10,
        context: { reply: { ...IMESSAGE_ROUTE, chatId: 'chat-some-group' }, inGroup: false },
      });
      const result = await routeChannelMessage(h.deps, job({ in_group }));
      return { result, holding, h };
    };

    const group = await turnIn(true);
    expect(group.result.status).toBe('agent_replied');
    expect(group.h.transport.bodies()).toEqual(['the real answer']);
    expect(group.holding.calls).toBe(0);
    expect(group.h.logs).toContainEqual([{ outcome: 'group_thread' }, expect.any(String)]);

    // Positive control: the door said 1:1, and the same slow turn still gets its line.
    const direct = await turnIn(false);
    expect(direct.h.transport.bodies()).toEqual(["I'm on it.", 'the real answer']);
    expect(direct.holding.calls).toBe(1);
  });

  it('VIL-439: every group flag off, a group message still runs as a scoped group turn on the group thread', async () => {
    // With v2 dark, wiring.ts says `inGroup: false` for a coparent-claimed group message.
    // The door's own bit must still give it the group audience (group-scoped tools and
    // context in the runtime) and the group's thread, never the sender's 1:1 thread.
    for (const flag of [
      'GROUP_PRIVACY_SCOPE_ENABLED',
      'LINQ_GROUP_ONBOARDING_V2_ENABLED',
      'LINQ_GROUP_TURN_AI_ENABLED',
    ]) {
      vi.stubEnv(flag, '');
    }
    const turnIn = async (in_group: boolean) => {
      const audiences: Array<ChannelTurn['audience']> = [];
      const coach = fakeCoach('the real answer');
      const respond = coach.respond;
      coach.respond = async (turn, rejected) => {
        audiences.push(turn.audience);
        return respond(turn, rejected);
      };
      const h = harness({
        coach,
        context: { reply: { ...IMESSAGE_ROUTE, chatId: 'chat-claimed-group' }, inGroup: false },
      });
      const result = await routeChannelMessage(h.deps, job({ in_group }));
      return { result, audiences, h };
    };

    const group = await turnIn(true);
    expect(group.result.status).toBe('agent_replied');
    expect(group.audiences).toEqual(['group']);
    expect(conversationRows(group.h.fake).map((r) => r.noteKey)).toEqual([
      channelGroupNoteKey('chat-claimed-group'),
    ]);

    // Positive control: the door said 1:1, so it stays the parent's own thread.
    const direct = await turnIn(false);
    expect(direct.audiences).toEqual(['direct']);
    expect(conversationRows(direct.h.fake).map((r) => r.noteKey)).toEqual([
      channelSmsNoteKey(PARENT),
    ]);
    vi.unstubAllEnvs();
  });

  it('a job that does not say whether it came from a group is not armed, and says so', async () => {
    // A job queued before the door carried the bit, or re-driven by the reconciler, which
    // reads the row and cannot know.
    const holding = fakeHoldingLine("I'm on it.");
    const h = harness({
      coach: slowCoach(120, 'the real answer'),
      holdingLine: holding,
      holdingLineAfterMs: 10,
    });
    const unsaid = job({ in_group: undefined });

    const result = await routeChannelMessage(h.deps, unsaid);

    expect(result.status).toBe('agent_replied');
    expect(h.transport.bodies()).toEqual(['the real answer']);
    expect(holding.calls).toBe(0);
    expect(h.logs).toContainEqual([{ outcome: 'group_unknown' }, expect.any(String)]);
  });

  it('an answer that beats the wait is recorded as answered_first', async () => {
    const holding = fakeHoldingLine();
    const h = harness({
      holdingLine: holding,
      holdingLineAfterMs: 200,
      context: { reply: IMESSAGE_ROUTE },
    });

    await routeChannelMessage(h.deps, job());

    expect(holding.calls).toBe(0);
    expect(h.logs).toContainEqual([{ outcome: 'answered_first' }, expect.any(String)]);
  });

  it('an SMS turn never gets one: the line is a 1:1 iMessage thing', async () => {
    const turnOn = async (reply: ReplyRoute) => {
      const holding = fakeHoldingLine("I'm on it.");
      const h = harness({
        coach: slowCoach(120, 'the real answer'),
        holdingLine: holding,
        holdingLineAfterMs: 10,
        context: { reply },
      });
      const result = await routeChannelMessage(h.deps, job({ in_group: false }));
      return { result, holding, h };
    };

    const sms = await turnOn(SMS_ROUTE);
    expect(sms.result.status).toBe('agent_replied');
    expect(sms.h.transport.bodies()).toEqual(['the real answer']);
    expect(sms.holding.calls).toBe(0);
    expect(sms.h.logs).toContainEqual([{ outcome: 'sms' }, expect.any(String)]);

    // Positive control: the same slow turn on iMessage gets its line.
    const imessage = await turnOn(IMESSAGE_ROUTE);
    expect(imessage.h.transport.bodies()).toEqual(["I'm on it.", 'the real answer']);
    expect(imessage.holding.calls).toBe(1);
  });

  it("is written in the language the screen read off THIS text, not the family's", async () => {
    const turnTagged = async (language: string | undefined) => {
      const holding = fakeHoldingLine('在看了，有结果告诉你');
      const h = harness({
        coach: slowCoach(120, 'the real answer'),
        holdingLine: holding,
        holdingLineAfterMs: 10,
        context: { reply: IMESSAGE_ROUTE },
        offDomain: fakeLane({
          status: 'in_domain',
          fallback: null,
          ...(language ? { language } : {}),
        }),
      });
      await h.fake.db
        .insert(schema.families)
        .values({ id: FAMILY, displayName: 'The family', primaryLanguage: 'en' });
      await routeChannelMessage(h.deps, job({ in_group: false }));
      return holding;
    };

    expect((await turnTagged('zh')).languages).toEqual(['zh']);
    // Positive control: no tag on this text, so the family's stored language is the fallback.
    expect((await turnTagged(undefined)).languages).toEqual(['en']);
  });

  /** The lane's answer arrives `ms` after the screen has read the text: a slow lane. */
  function slowLane(verdict: OffDomainVerdict, ms: number, screenFirst = true): OffDomainLane {
    return {
      async consider(input) {
        if (screenFirst) input.onScreened?.(screenedAs(verdict));
        await new Promise((resolve) => setTimeout(resolve, ms));
        if (!screenFirst) input.onScreened?.(screenedAs(verdict));
        return verdict;
      },
    };
  }

  const MEDICAL: OffDomainVerdict = {
    status: 'deflected',
    lane: 'safety_critical',
    category: 'medical-symptom',
    reply: 'the medical answer',
    replySource: 'web_grounded',
    medicalSource: 'web_grounded',
    signal: 'not_applicable',
    pendingAsk: null,
  };

  it('never goes out in front of a crisis or medical answer, however slow that answer is', async () => {
    const turnThrough = async (verdict: OffDomainVerdict) => {
      const holding = fakeHoldingLine("I'm on it.");
      const h = harness({
        holdingLine: holding,
        holdingLineAfterMs: 10,
        context: { reply: IMESSAGE_ROUTE },
        offDomain: slowLane(verdict, 120),
      });
      const result = await routeChannelMessage(h.deps, job({ in_group: false }));
      return { result, holding, h };
    };

    const medical = await turnThrough(MEDICAL);
    expect(medical.result.status).toBe('deflected');
    expect(medical.h.transport.bodies()).toEqual(['the medical answer']);
    expect(medical.holding.calls).toBe(0);
    expect(medical.h.logs).toContainEqual([{ outcome: 'safety_lane' }, expect.any(String)]);

    // Positive control: the same slow lane answering a question about the world (the
    // search lane) gets its line first.
    const search = await turnThrough({
      ...MEDICAL,
      lane: 'off_domain_general',
      category: 'weather',
      reply: 'Rain later.',
      replySource: 'web_grounded',
      medicalSource: null,
      signal: 'recorded',
    });
    expect(search.h.transport.bodies()).toEqual(["I'm on it.", 'Rain later.']);
    expect(search.holding.calls).toBe(1);
  });

  it('withholds the line while the screen has not read the text, and names it', async () => {
    const holding = fakeHoldingLine("I'm on it.");
    const h = harness({
      holdingLine: holding,
      holdingLineAfterMs: 10,
      context: { reply: IMESSAGE_ROUTE },
      // The screen itself is the slow call: nothing has read the text when the line is due.
      offDomain: slowLane({ status: 'in_domain', fallback: null }, 120, false),
      coach: slowCoach(120, 'the real answer'),
    });

    await routeChannelMessage(h.deps, job({ in_group: false }));

    expect(h.transport.bodies()).toEqual(['the real answer']);
    expect(holding.calls).toBe(0);
    expect(h.logs).toContainEqual([{ outcome: 'unscreened' }, expect.any(String)]);
  });
});

/**
 * The reply's ledger row through the REAL send path, against the real DDL. The fake
 * database above records whatever it is handed, so it cannot fail on a column or a table
 * the database does not have. Everything else is the harness's: the context, the
 * transport, the coach. Every row is invented.
 */
describe('the reply row, written to a real database', () => {
  /** The harness, with its database swapped for a real one and its job pointed at a
   * family that exists there. */
  async function onRealDatabase(db: TestDb, options: Parameters<typeof harness>[0] = {}) {
    const h = harness(options);
    h.deps.database = db.database;
    const { familyId, parentUserId } = await seedFamily(db.database);
    const turn = (overrides: Partial<ChannelMessageReceivedJob> = {}) =>
      job({ family_id: familyId, parent_user_id: parentUserId, ...overrides });
    return { h, familyId, parentUserId, turn };
  }

  /**
   * Sloane's ruling on the pending question: it moves to a side table "so that 0167 no
   * longer has to run before merge to keep every text from failing". A database migrated
   * only as far as main is today takes a reply's row.
   */
  describe('on a database without migration 0167', () => {
    let db: TestDb;

    beforeAll(async () => {
      db = await createTestDb('0163_drop_retired_auth_tables.sql');
      // 0167 stays unapplied. The reply path now reads inbound media, which
      // arrives in 0173, so that column is present without the pending-ask table.
      await db.exec('ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS inbound_media jsonb');
      // Likewise the group bit (0185, VIL-463), which the ledger row now carries.
      await db.exec('ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS in_group boolean');
      // VIL-479 · drizzle names every messages column, including this one (0201).
      await db.exec('ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_message_id text');
      // And the audit row's audience (0227, VIL-635), which every audit write now carries.
      await db.exec('ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS audience uuid');
      // And the inbound service (0233), which drizzle names on every ledger row.
      await db.exec('ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS provider_service text');
    });

    afterAll(async () => {
      await db.close();
    });

    it('sends the reply and writes its row', async () => {
      const { h, familyId, turn } = await onRealDatabase(db, {
        coach: fakeCoach('Saturday is dry.'),
      });

      const result = await routeChannelMessage(h.deps, turn());

      expect(result.status).toBe('agent_replied');
      expect(h.transport.bodies()).toEqual(['Saturday is dry.']);
      const sent = await db.database
        .select({ direction: schema.channelMessages.direction })
        .from(schema.channelMessages)
        .where(eq(schema.channelMessages.familyId, familyId));
      expect(sent).toEqual([{ direction: 'out' }]);
    });

    /**
     * The same database with the search lit, which is the order the checklist allows:
     * the flag can be lit before 0167 is applied. The settle after the send then fails on
     * a table that is not there, and the parent already has the reply, so the turn ends
     * as it would have and the failure is named.
     */
    it('answers with the search lit, and names the question it could not keep', async () => {
      vi.stubEnv(GENERAL_ANSWER_SEARCH_ENABLED_ENV, 'true');
      const { h, familyId, turn } = await onRealDatabase(db, {
        coach: fakeCoach('Saturday is dry.'),
      });

      const result = await routeChannelMessage(h.deps, turn());
      vi.unstubAllEnvs();

      expect(result.status).toBe('agent_replied');
      expect(h.transport.bodies()).toEqual(['Saturday is dry.']);
      expect(
        await db.database
          .select({ direction: schema.channelMessages.direction })
          .from(schema.channelMessages)
          .where(eq(schema.channelMessages.familyId, familyId)),
      ).toEqual([{ direction: 'out' }]);
      expect(
        h.logs.filter(
          (entry) =>
            (entry as unknown[])[1] ===
            'pending ask: the reply landed; the question it left open was not kept',
        ),
      ).toHaveLength(1);
    });
  });

  /**
   * A question Hale left open, through the real send path and the real read path, with
   * no row seeded by hand: what the router writes is what the lane's reader finds. The
   * lane is production's own wiring on a scripted client.
   */
  describe('a question left open, and the reply to it', () => {
    let db: TestDb;

    beforeAll(async () => {
      db = await createTestDb();
    });

    afterAll(async () => {
      await db.close();
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });

    const OWN_CHAT: ReplyRoute = {
      channel: 'imessage',
      to: PHONE,
      chatId: 'chat-own',
      replyToMessageId: null,
    };
    const OTHER_CHAT: ReplyRoute = { ...OWN_CHAT, chatId: 'chat-other' };
    const ASKED = { question: 'hows the weather tomorrow', missing: 'which city' };
    const COMBINED = 'hows the weather tomorrow in Maplewood';

    /** How long a slow stage takes: well past the holding line's shortened wait. */
    const SLOW_MS = 150;
    const HOLDING_AFTER_MS = 10;

    /** The lane's one client: the screen files the text as off-topic, the sanitizer reads
     * a text beside a pending ask as its answer, and the search finds something. `slow`
     * is the one call that takes {@link SLOW_MS}: the screen's, or the compose's. */
    function scripted(slow: 'screen' | 'compose' | null = null) {
      const seen = { sanitize: [] as unknown[], search: [] as unknown[] };
      const takesAWhile = (stage: 'screen' | 'compose') =>
        slow === stage ? new Promise((resolve) => setTimeout(resolve, SLOW_MS)) : null;
      const structured = (payload: unknown) => ({
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      const client = () =>
        ({
          messages: {
            async create(request: {
              system: Array<{ text: string }>;
              messages: Array<{ content: string }>;
            }) {
              const system = request.system.map((block) => block.text).join('');
              const payload = JSON.parse(request.messages[0]?.content ?? '{}');
              if (system.includes('Which lane does this text belong in')) {
                await takesAWhile('screen');
                return structured({ lane: 'off_domain_general', category: 'weather', reason: 'x' });
              }
              if (system.includes('Take the family out, keep the question')) {
                seen.sanitize.push(payload);
                return structured(
                  'pending' in payload
                    ? {
                        language: 'en',
                        answers_pending: 'yes',
                        question: COMBINED,
                        missing_detail: 'none',
                        their_place: 'not_needed',
                        current_fact: 'the forecast',
                        needs_search: 'yes',
                      }
                    : {
                        language: 'en',
                        answers_pending: 'nothing_pending',
                        question: ASKED.question,
                        missing_detail: ASKED.missing,
                        their_place: 'needed',
                        current_fact: 'the forecast',
                        needs_search: 'missing_detail',
                      },
                );
              }
              await takesAWhile('compose');
              return structured({
                answer:
                  payload.live === 'missing_detail'
                    ? 'Which city are you in?'
                    : 'Sunny, high of 14.',
              });
            },
            stream(request: { messages: Array<{ content: string }> }) {
              seen.search.push(JSON.parse(request.messages[0]?.content ?? '{}'));
              return {
                async finalMessage() {
                  return {
                    content: [
                      {
                        type: 'web_search_tool_result',
                        tool_use_id: 'srvtoolu_1',
                        content: [{ type: 'web_search_result', url: 'https://weather.example/f' }],
                      },
                      { type: 'text', text: 'Sunny tomorrow, high of 14, per the forecast.' },
                    ],
                    stop_reason: 'end_turn',
                    usage: { input_tokens: 10, output_tokens: 5 },
                  };
                },
              };
            },
          },
        }) as unknown as AgentClient;
      return { client, seen };
    }

    /** One text from this parent, in one chat, through the router and the production lane.
     * `options` are the harness's own, for a turn that is not an ordinary one, and `slow`
     * the lane call that outlasts the holding line's wait. */
    async function text(
      parent: { familyId: string; parentUserId: string },
      body: string,
      route: ReplyRoute,
      {
        slow = null,
        now,
        ...options
      }: Parameters<typeof harness>[0] & {
        slow?: 'screen' | 'compose' | null;
        now?: Date;
      } = {},
    ) {
      const turn = scripted(slow);
      const h = harness({
        offDomain: productionOffDomainLane(db.database, turn.client),
        ...options,
        context: { body, reply: route, ...options.context },
      });
      h.deps.database = db.database;
      // The reply rows are stamped by the database's clock, so the turn reads on it too.
      // A pinned `now` keeps the wall-clock fact stable (VIL-473).
      const clock = now ?? new Date();
      h.deps.now = () => clock;
      const [inbound] = await db.database
        .insert(schema.channelMessages)
        .values({
          ...parent,
          channel: 'imessage',
          providerChatId: route.channel === 'imessage' ? route.chatId : null,
          direction: 'in',
          category: 'reply',
          status: 'delivered',
          body,
        })
        .returning({ id: schema.channelMessages.id });
      await routeChannelMessage(
        h.deps,
        job({
          family_id: parent.familyId,
          parent_user_id: parent.parentUserId,
          channel_message_id: inbound?.id as string,
        }),
      );
      return { said: h.transport.bodies(), seen: turn.seen, logs: h.logs };
    }

    const keptAsks = (familyId: string) =>
      db.database
        .select({
          question: schema.channelPendingAsks.question,
          missing: schema.channelPendingAsks.missing,
          chat: schema.channelMessages.providerChatId,
          direction: schema.channelMessages.direction,
        })
        .from(schema.channelPendingAsks)
        .innerJoin(
          schema.channelMessages,
          eq(schema.channelMessages.id, schema.channelPendingAsks.channelMessageId),
        )
        .where(eq(schema.channelPendingAsks.familyId, familyId));

    const lit = () => {
      vi.stubEnv(GENERAL_ANSWER_SEARCH_ENABLED_ENV, 'true');
      for (const level of ['info', 'warn', 'error'] as const) {
        vi.spyOn(console, level).mockImplementation(() => {});
      }
    };

    it('keeps the question beside the reply that asked, reads it for the next text in that chat, and deletes it once answered', async () => {
      lit();
      const parent = await seedFamily(db.database);

      const asked = await text(parent, 'hows the weather tomorrow', OWN_CHAT);

      expect(asked.said).toEqual(['Which city are you in?']);
      expect(await keptAsks(parent.familyId)).toEqual([
        { ...ASKED, chat: 'chat-own', direction: 'out' },
      ]);

      const answered = await text(parent, 'Maplewood', OWN_CHAT);

      // The real reader found what the real send wrote, in the chat it was asked in.
      expect(answered.seen.sanitize).toEqual([{ text: 'Maplewood', pending: ASKED }]);
      expect(answered.seen.search).toMatchObject([{ question: COMBINED }]);
      expect(answered.said).toEqual(['Sunny, high of 14.']);
      // Answered, so it is gone: the question lived only while it was open.
      expect(await keptAsks(parent.familyId)).toEqual([]);
    });

    it('does not read it for a text in another chat, and Hale answering there closes it', async () => {
      lit();
      const parent = await seedFamily(db.database);
      await text(parent, 'hows the weather tomorrow', OWN_CHAT);
      // Positive control: the question is open.
      expect(await keptAsks(parent.familyId)).toHaveLength(1);

      const elsewhere = await text(parent, 'Maplewood', OTHER_CHAT);

      expect(elsewhere.seen.sanitize).toEqual([{ text: 'Maplewood' }]);
      expect(JSON.stringify(elsewhere.seen)).not.toContain(COMBINED);
      // That text was answered as a question of its own, which is Hale's newer word to
      // this parent. The first question can never be read again, so it is not kept; the
      // one this reply left open is.
      expect(await keptAsks(parent.familyId)).toEqual([
        { ...ASKED, chat: 'chat-other', direction: 'out' },
      ]);
    });

    /**
     * ONLY THE TURN'S ANSWER SETTLES. The holding line goes out through the same send as
     * the answer does, while the turn is still reading, and it used to close the parent's
     * open questions like any reply: when it went out before the screen had finished, the
     * question was deleted before the lane read it, and "Maplewood" after "Which city are
     * you in?" got the question asked again. Both flags lit, the production lane, a real
     * database.
     */
    describe('the holding line is not an answer', () => {
      beforeEach(() => {
        vi.stubEnv(HOLDING_LINE_ENABLED_ENV, 'true');
      });

      it.each([
        // Withheld: nothing has read the text yet, so nobody knows it is not a crisis.
        ['is due while the screen is still reading', 'screen', ['Sunny, high of 14.']],
        // Controls. The question is read before the compose, and with no slow call the
        // line never goes out at all.
        ['goes out while the answer is composed', 'compose', ["I'm on it.", 'Sunny, high of 14.']],
        ['never goes out', null, ['Sunny, high of 14.']],
      ] as const)(
        'still reads the reply beside its question when the holding line %s',
        async (_label, slow, said) => {
          lit();
          const parent = await seedFamily(db.database);
          const asked = await text(parent, 'hows the weather tomorrow', OWN_CHAT);
          expect(asked.said).toEqual(['Which city are you in?']);
          expect(await keptAsks(parent.familyId)).toHaveLength(1);

          const answered = await text(parent, 'Maplewood', OWN_CHAT, {
            slow,
            holdingLine: fakeHoldingLine("I'm on it."),
            // With no slow call, a deadline no real turn reaches: the control must not
            // depend on how fast this machine runs the turn.
            holdingLineAfterMs: slow === null ? 60_000 : HOLDING_AFTER_MS,
          });

          expect(answered.said).toEqual(said);
          expect(answered.seen.sanitize).toEqual([{ text: 'Maplewood', pending: ASKED }]);
          expect(answered.seen.search).toMatchObject([{ question: COMBINED }]);
          // The answer closed it: the holding line's own row is in the ledger, and the
          // question is gone.
          expect(await keptAsks(parent.familyId)).toEqual([]);
        },
      );
    });

    /**
     * WHICH SENDS ARE AN ANSWER, each through the router. A question is open only while
     * the reply that left it is Hale's last word to that parent (lane.ts readPendingAsk),
     * so every reply that answers the parent's text is a newer word and takes it out:
     * what the coach says, the line a spent budget gets on either of its two routes, the
     * line someone who is not a parent gets, and a tapback that stood in for the words.
     */
    describe('every answer closes the question', () => {
      const SPENT: RateLimiter = {
        check: async () => ({ allowed: false, retryAfterSec: 60, firstDenied: true }),
      };

      it.each([
        ['what the coach says', {}, ['coach says hi']],
        ['the line a spent budget gets', { limiter: SPENT }, ['A lot came in at once.']],
        [
          'the line a spent budget gets from a group, on their own phone',
          { limiter: SPENT, context: { inGroup: true } },
          ['A lot came in at once.'],
        ],
        [
          'the line someone who is not a parent gets',
          { context: { role: 'nanny' } },
          [scopedReply('Sam')],
        ],
      ] as const)('%s', async (_label, options, said) => {
        lit();
        const parent = await seedFamily(db.database);
        await text(parent, 'hows the weather tomorrow', OWN_CHAT);
        // Positive control: the question is open.
        expect(await keptAsks(parent.familyId)).toHaveLength(1);

        const next = await text(parent, 'never mind, what is on this weekend', OWN_CHAT, {
          offDomain: fakeLane(IN_DOMAIN),
          ...options,
        });

        expect(next.said).toEqual(said);
        expect(await keptAsks(parent.familyId)).toEqual([]);
      });

      it('a tapback that stood in for the words', async () => {
        lit();
        vi.stubEnv('LINQ_API_KEY', 'test-key');
        const reacted: string[] = [];
        vi.stubGlobal('fetch', async (url: string) => {
          reacted.push(new URL(url).pathname);
          return new Response(null, { status: 204 });
        });
        const parent = await seedFamily(db.database);
        await text(parent, 'hows the weather tomorrow', OWN_CHAT);
        expect(await keptAsks(parent.familyId)).toHaveLength(1);

        const next = await text(
          parent,
          'thanks',
          { ...OWN_CHAT, replyToMessageId: 'in-1' },
          { offDomain: fakeLane(IN_DOMAIN), coach: fakeCoach('Anytime.') },
        );
        vi.unstubAllGlobals();

        // Positive control: the reaction went out, and no words did.
        expect(reacted.filter((path) => path.endsWith('/reactions'))).toEqual([
          '/api/partner/v3/messages/in-1/reactions',
        ]);
        expect(next.said).toEqual([]);
        expect(await keptAsks(parent.familyId)).toEqual([]);
      });

      it('a sticker the model chose to stand in for the words', async () => {
        lit();
        vi.stubEnv('LINQ_API_KEY', 'test-key');
        vi.stubEnv('LINQ_STICKERS_ENABLED', 'true');
        stickerDecide.mockResolvedValue({ sticker: '🙌', sendReply: false });
        const peeled: unknown[] = [];
        vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
          if (new URL(url).pathname.endsWith('/reactions'))
            peeled.push(JSON.parse(String(init?.body)));
          return new Response(null, { status: 204 });
        });
        const parent = await seedFamily(db.database);
        await text(parent, 'hows the weather tomorrow', OWN_CHAT);
        expect(await keptAsks(parent.familyId)).toHaveLength(1);

        const next = await text(
          parent,
          'perfect, see you saturday',
          { ...OWN_CHAT, replyToMessageId: 'in-1' },
          { offDomain: fakeLane(IN_DOMAIN), coach: fakeCoach('See you then.') },
        );
        vi.unstubAllGlobals();

        expect(stickerDecide).toHaveBeenCalledWith({
          audience: 'direct',
          parentText: 'perfect, see you saturday',
          parentAttachments: [],
          reply: 'See you then.',
        });
        expect(peeled).toEqual([{ operation: 'add', type: 'sticker', emoji: '🙌' }]);
        expect(next.said).toEqual([]);
        expect(await keptAsks(parent.familyId)).toEqual([]);
        stickerDecide.mockReset();
      });

      it('a sticker that keeps the reply sends the reply plain, with no effect read', async () => {
        lit();
        vi.stubEnv('LINQ_API_KEY', 'test-key');
        vi.stubEnv('LINQ_STICKERS_ENABLED', 'true');
        vi.stubEnv('LINQ_EFFECTS_ENABLED', 'true');
        vi.stubEnv('VERCEL_ENV', 'preview');
        stickerDecide.mockResolvedValue({ sticker: '🙌', sendReply: true });
        effectDecide.mockResolvedValue({ effect: { type: 'screen', name: 'confetti' } });
        const posted: string[] = [];
        vi.stubGlobal('fetch', async (url: string) => {
          posted.push(new URL(url).pathname);
          return new Response(null, { status: 204 });
        });
        const parent = await seedFamily(db.database);
        await text(parent, 'hows the weather tomorrow', OWN_CHAT);
        effectDecide.mockClear();
        posted.length = 0;

        const next = await text(
          parent,
          'we got in for swim',
          { ...OWN_CHAT, replyToMessageId: 'in-1' },
          {
            offDomain: fakeLane(IN_DOMAIN),
            coach: fakeCoach('You are in for swim.'),
            now: new Date('2026-10-28T16:00:00.000Z'),
          },
        );
        vi.unstubAllGlobals();

        // One moment per reply: the sticker peeled, the words go out plain.
        expect(stickerDecide).toHaveBeenCalled();
        expect(effectDecide).not.toHaveBeenCalled();
        expect(posted.filter((path) => path.endsWith('/messages'))).toEqual([]);
        expect(next.said).toEqual(['You are in for swim.']);
        stickerDecide.mockReset();
        effectDecide.mockReset();
      });

      it('a reply the model chose an iMessage effect for', async () => {
        // Its own chat: the effect read looks up this chat's earlier effects, and another
        // test's chat-own rows are not this one's history.
        const EFFECT_CHAT: ReplyRoute = { ...OWN_CHAT, chatId: 'chat-effect' };
        lit();
        vi.stubEnv('LINQ_API_KEY', 'test-key');
        vi.stubEnv('LINQ_EFFECTS_ENABLED', 'true');
        vi.stubEnv('VERCEL_ENV', 'preview');
        effectDecide.mockResolvedValue({ effect: null });
        const sent: unknown[] = [];
        vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
          if (new URL(url).pathname.endsWith('/messages'))
            sent.push(JSON.parse(String(init?.body)));
          return Response.json({ message: { id: 'effect-out' } }, { status: 201 });
        });
        const parent = await seedFamily(db.database);
        await text(parent, 'hows the weather tomorrow', EFFECT_CHAT);
        expect(await keptAsks(parent.familyId)).toHaveLength(1);

        effectDecide.mockResolvedValue({ effect: { type: 'screen', name: 'confetti' } });
        const next = await text(
          parent,
          'we got in for swim',
          { ...EFFECT_CHAT, replyToMessageId: 'in-1' },
          {
            offDomain: fakeLane(IN_DOMAIN),
            coach: fakeCoach('You are in for swim.'),
            now: new Date('2026-10-28T16:00:00.000Z'),
          },
        );
        vi.unstubAllGlobals();

        expect(effectDecide).toHaveBeenCalledWith({
          audience: 'direct',
          parentText: 'we got in for swim',
          reply: 'You are in for swim.',
          // The stored zone is the users column default, UTC, which means never set:
          // Hale does not know this parent's clock, so the model is told none.
          parentLocalTime: null,
          lastEffectHoursAgo: null,
        });
        expect(sent).toEqual([
          {
            message: {
              parts: [{ type: 'text', value: 'You are in for swim.' }],
              reply_to: { message_id: 'in-1' },
              effect: { type: 'screen', name: 'confetti' },
            },
          },
        ]);
        // The words went out through Linq (asserted above), not the harness transport.
        expect(next.said).toEqual([]);
        expect(await keptAsks(parent.familyId)).toEqual([]);

        // No per-chat quota: two and a half hours later the model reads that fact from
        // send history, and its choice still plays. The parent has a zone by now.
        await db.database
          .update(schema.users)
          .set({ timezone: 'America/Toronto' })
          .where(eq(schema.users.id, parent.parentUserId));
        vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
          if (new URL(url).pathname.endsWith('/messages'))
            sent.push(JSON.parse(String(init?.body)));
          return Response.json({ message: { id: 'effect-out-2' } }, { status: 201 });
        });
        await text(
          parent,
          'and the waitlist for gym came through too',
          { ...EFFECT_CHAT, replyToMessageId: 'in-2' },
          {
            offDomain: fakeLane(IN_DOMAIN),
            coach: fakeCoach('Gym too. Both are in.'),
            now: new Date('2026-10-28T18:30:00.000Z'),
          },
        );
        vi.unstubAllGlobals();
        expect(effectDecide).toHaveBeenLastCalledWith(
          expect.objectContaining({
            parentLocalTime: 'Wednesday 2:30 PM America/Toronto',
            lastEffectHoursAgo: 2,
          }),
        );
        expect(sent).toHaveLength(2);
        effectDecide.mockReset();
      });
    });

    /** One person, two households. A question is put to a parent in one family, and
     * what Hale says to the same person about another family is not a word in the first. */
    it('keeps a question open in one household when Hale replies to the same person in another', async () => {
      lit();
      const parent = await seedFamily(db.database);
      const other = await seedFamily(db.database, 'Second Household');
      await db.database
        .insert(schema.familyMembers)
        .values({ familyId: other.familyId, userId: parent.parentUserId, role: 'co_parent' });
      await text(parent, 'hows the weather tomorrow', OWN_CHAT);

      const elsewhere = await text(
        { familyId: other.familyId, parentUserId: parent.parentUserId },
        'what is on this weekend',
        OTHER_CHAT,
        { offDomain: fakeLane(IN_DOMAIN) },
      );

      // Positive control: Hale did reply to them there.
      expect(elsewhere.said).toEqual(['coach says hi']);
      expect(await keptAsks(parent.familyId)).toEqual([
        { ...ASKED, chat: 'chat-own', direction: 'out' },
      ]);
    });
  });

  /** The production wiring: no `crisisPager` in the deps, so the router's default (the
   * real failure-page pager on this turn's database) runs. Only the Slack post is faked. */
  describe('a crisis moment nobody could write, through the default pager', () => {
    const WEBHOOK = 'https://hooks.example.test/ops';
    let db: TestDb;

    beforeAll(async () => {
      db = await createTestDb();
    });

    afterAll(async () => {
      await db.close();
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it("pages #ops once and leaves the claim and the texting parent's audit row", async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.stubEnv('OPS_SLACK_WEBHOOK_URL', WEBHOOK);
      const posted: string[] = [];
      vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
        if (url === WEBHOOK) posted.push(JSON.parse(init?.body ?? '{}').text);
        return new Response('ok', { status: 200 });
      });
      const { h, familyId, parentUserId, turn } = await onRealDatabase(db, {
        offDomain: {
          async consider() {
            return {
              status: 'unwritten' as const,
              moment: 'mental_crisis' as const,
              reason: 'model_failed',
              lane: 'safety_critical' as const,
              category: 'other' as const,
            };
          },
        },
      });
      h.deps.crisisPager = undefined;

      await expect(routeChannelMessage(h.deps, turn())).rejects.toMatchObject({
        name: 'TurnDeferred',
        reason: 'moment_unwritten',
      });

      expect(h.transport.bodies()).toEqual([]);
      expect(posted).toHaveLength(1);
      expect(posted[0]).toContain('kind mental.');
      expect(posted[0]).toContain('where router_moment.');
      expect(posted[0]).toContain('reason model_failed.');
      expect(posted[0]).toContain('writes 2.');
      const claims = await db.database
        .select({ count: schema.rateLimits.count })
        .from(schema.rateLimits)
        .where(eq(schema.rateLimits.route, CRISIS_UNANSWERED_PAGE_ROUTE));
      expect(claims).toEqual([{ count: 1 }]);
      const audit = await db.database
        .select({
          familyId: schema.auditLog.familyId,
          targetId: schema.auditLog.targetId,
          after: schema.auditLog.after,
        })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.actionTaken, CRISIS_UNANSWERED_AUDIT_ACTION));
      expect(audit).toEqual([
        {
          familyId,
          targetId: parentUserId,
          after: { kind: 'mental', where: 'router moment', reason: 'model_failed', writes: 2 },
        },
      ]);
    });
  });
});

/**
 * VIL-463 — a group turn never reaches a parent's 1:1 thread, 1:1 asks, or the group
 * with a private line. Fake families only; no keys, no SMS, no model.
 */
describe('VIL-463 group scope', () => {
  const GROUP_ROUTE: ReplyRoute = {
    channel: 'imessage',
    to: PHONE,
    chatId: 'chat-family-group',
    replyToMessageId: 'in-1',
  };

  it('refuses a job with no group bit that arrived in an iMessage chat, opening no 1:1 thread', async () => {
    const coach = fakeCoach();
    const h = harness({ coach, context: { reply: GROUP_ROUTE, inGroup: false } });

    const result = await routeChannelMessage(h.deps, job({ in_group: undefined }));

    expect(result.status).toBe('group_unscoped');
    expect(result.conversationId).toBeNull();
    expect(conversationRows(h.fake)).toEqual([]);
    expect(messageRows(h.fake)).toEqual([]);
    expect(coach.calls).toBe(0);
    expect(h.transport.sent).toEqual([]);
  });

  it('positive control: the same chat with the bit said false runs as a 1:1 turn', async () => {
    const h = harness({ context: { reply: GROUP_ROUTE, inGroup: false } });
    const result = await routeChannelMessage(h.deps, job({ in_group: false }));
    expect(result.status).toBe('agent_replied');
  });

  it('a group "yes" does not resolve a question open in the 1:1 chat', async () => {
    const question: OpenQuestion = {
      id: 'aaaa1111-1111-4111-8111-111111111111',
      kind: 'approval',
      description: 'Reschedule on your calendar',
      subject: 'reschedule on your calendar',
      answerable: { yes: true, no: true },
      askedAt: null,
      solicited: false,
    };
    const seen: unknown[] = [];
    const owner = {
      name: 'owner_approval',
      resolves: new Set(['approval']),
      async handle(_db: unknown, ctx: { resolved: unknown }) {
        seen.push(ctx.resolved);
        if (!ctx.resolved) return { claimed: false };
        return { claimed: true, outcome: 'acted', reply: 'Done.' };
      },
    } as unknown as DeterministicHandler;
    const resolved = fakeResolver({
      status: 'resolved',
      questionId: question.id,
      kind: 'approval',
      polarity: 'yes',
      confidence: 'high',
    });

    const questions = fakeQuestions([question]);
    const h = harness({
      context: { body: 'yes', reply: GROUP_ROUTE, inGroup: true },
      handlers: [owner],
      questions,
      replyResolver: resolved,
    });
    const result = await routeChannelMessage(h.deps, job({ in_group: true }));

    expect(result.status).not.toBe('resolved');
    expect(questions.calls).toBe(0);
    expect(resolved.calls).toBe(0);
    expect(seen.every((r) => r === null)).toBe(true);

    // Positive control: the same "yes" in the 1:1 chat resolves it.
    const direct = harness({
      context: { body: 'yes' },
      handlers: [owner],
      questions: fakeQuestions([question]),
      replyResolver: fakeResolver({
        status: 'resolved',
        questionId: question.id,
        kind: 'approval',
        polarity: 'yes',
        confidence: 'high',
      }),
    });
    expect((await routeChannelMessage(direct.deps, job())).status).toBe('resolved');
  });

  it('VIL-443: a group "yes" approves a plan drafted in that same group, and nothing else', async () => {
    const planned: OpenQuestion = {
      id: 'bbbb2222-2222-4222-8222-222222222222',
      kind: 'approval',
      description: 'Add to your calendar',
      subject: 'add to your calendar',
      answerable: { yes: true, no: true },
      askedAt: null,
      solicited: false,
    };
    const private1to1: OpenQuestion = { ...planned, id: 'cccc3333-3333-4333-8333-333333333333' };
    const seen: Array<{ questionId: string } | null> = [];
    const owner = {
      name: 'owner_approval',
      resolves: new Set(['approval']),
      async handle(_db: unknown, ctx: { resolved: { questionId: string } | null }) {
        seen.push(ctx.resolved);
        if (!ctx.resolved) return { claimed: false };
        return { claimed: true, outcome: 'acted', reply: 'Done.' };
      },
    } as unknown as DeterministicHandler;
    const shown: string[][] = [];
    const resolver = {
      calls: 0,
      async read(input: { questions: readonly OpenQuestion[] }) {
        resolver.calls += 1;
        shown.push(input.questions.map((q) => q.id));
        return {
          status: 'resolved' as const,
          questionId: planned.id,
          kind: 'approval' as const,
          polarity: 'yes' as const,
          confidence: 'high' as const,
        };
      },
    };
    const asked: Array<{ familyId: string; chatId: string }> = [];
    const h = harness({
      context: { body: 'yes', reply: GROUP_ROUTE, inGroup: true },
      handlers: [owner],
      questions: fakeQuestions([private1to1, planned]),
      replyResolver: resolver as never,
    });
    h.deps.groupPlanActionIds = async (_db, input) => {
      asked.push(input);
      return new Set([planned.id]);
    };
    const result = await routeChannelMessage(h.deps, job({ in_group: true }));

    expect(result.status).toBe('resolved');
    expect(asked).toEqual([{ familyId: expect.any(String), chatId: GROUP_ROUTE.chatId }]);
    // The 1:1 approval is never shown to the resolver from the group.
    expect(shown).toEqual([[planned.id]]);
    expect(seen.at(-1)?.questionId).toBe(planned.id);

    // Negative control: no plan drafted in this group, so the group yes answers nothing.
    const none = harness({
      context: { body: 'yes', reply: GROUP_ROUTE, inGroup: true },
      handlers: [owner],
      questions: fakeQuestions([private1to1, planned]),
      replyResolver: resolver as never,
    });
    none.deps.groupPlanActionIds = async () => new Set();
    const callsBefore = resolver.calls;
    expect((await routeChannelMessage(none.deps, job({ in_group: true }))).status).not.toBe(
      'resolved',
    );
    expect(resolver.calls).toBe(callsBefore);
  });

  it('a group text does not spend the menu Hale printed in the 1:1 chat', async () => {
    function menuSpy() {
      const spy = {
        consumed: 0,
        async pending() {
          return {
            id: 'menu-1',
            polarity: 'yes' as const,
            numbered: true,
            options: [] as readonly DisambiguationOption[],
          };
        },
        async mint() {
          return { status: 'minted' as const };
        },
        async consume() {
          spy.consumed += 1;
          return 'spent' as const;
        },
      };
      return spy;
    }
    const group = harness({ context: { body: '2', reply: GROUP_ROUTE, inGroup: true } });
    const groupMenu = menuSpy();
    group.deps.disambiguation = groupMenu as unknown as DisambiguationStore;
    await routeChannelMessage(group.deps, job({ in_group: true }));
    expect(groupMenu.consumed).toBe(0);

    // Positive control: the same text in the 1:1 chat spends it.
    const direct = harness({ context: { body: '2' } });
    const directMenu = menuSpy();
    direct.deps.disambiguation = directMenu as unknown as DisambiguationStore;
    await routeChannelMessage(direct.deps, job());
    expect(directMenu.consumed).toBe(1);
  });

  // VIL-477: an overlapping turn (a "be quiet" reply composed before another member's
  // leave landed) must not speak into the chat Hale already left.
  it('sends nothing into a group chat Hale left while the turn was in flight', async () => {
    const seen: Array<{ chatId: string; since: Date }> = [];
    const h = harness({
      context: { body: 'Hale be quiet for a bit', reply: GROUP_ROUTE, inGroup: true },
    });
    h.deps.leftChatSince = async (_db, input) => {
      seen.push(input);
      return true;
    };
    const turn = job({ in_group: true });
    const result = await routeChannelMessage(h.deps, turn);

    expect(result.status).toBe('group_left');
    expect(h.transport.sent).toEqual([]);
    expect(seen[0]?.chatId).toBe(GROUP_ROUTE.chatId);
    expect(seen[0]?.since.toISOString()).toBe(new Date(turn.received_at).toISOString());

    // Positive control: the same group turn, chat not left, replies.
    const stay = harness({
      context: { body: 'Hale be quiet for a bit', reply: GROUP_ROUTE, inGroup: true },
    });
    const kept = await routeChannelMessage(stay.deps, job({ in_group: true }));
    expect(kept.status).not.toBe('group_left');
    expect(stay.transport.sent.length).toBeGreaterThan(0);
  });

  async function overLimitGroupTurn(floodLine: FloodLineComposer) {
    const limiter = new FakeRateLimiter(() => NOW.getTime());
    for (let i = 0; i < AGENT_TURNS_PER_HOUR; i += 1) {
      await limiter.check(PARENT, 'sms-agent-turn', {
        limit: AGENT_TURNS_PER_HOUR,
        windowSec: 3600,
      });
    }
    const h = harness({ limiter, floodLine, context: { reply: GROUP_ROUTE, inGroup: true } });
    const result = await routeChannelMessage(h.deps, job({ in_group: true }));
    return { h, result };
  }

  it('sends the composed over-limit line 1:1 with no conversation, never into the group', async () => {
    const flood = fakeFloodLine({ status: 'composed', line: 'Swamped for a second.' });
    const { h, result } = await overLimitGroupTurn(flood);

    expect(result.status).toBe('flood_held');
    expect(flood.calls).toBe(1);
    expect(h.transport.sent).toEqual([{ route: SMS_ROUTE, body: 'Swamped for a second.' }]);
    expect(h.transport.sent.some((s) => s.route.channel === 'imessage')).toBe(false);
    const out = ledgerRows(h.fake).filter((r) => r.direction === 'out');
    expect(out).toHaveLength(1);
    expect(out[0]?.relatedConversationId).toBeNull();
    expect(messageRows(h.fake).filter((m) => m.role === 'assistant')).toEqual([]);
  });

  /** A receipt only its asker should read (a texted disconnect names their accounts). */
  function askerOnlyHandler(onlyToAsker: boolean): DeterministicHandler {
    return {
      name: 'asker_only',
      async handle() {
        return {
          claimed: true as const,
          outcome: 'revoked',
          reply: 'Your Gmail and Calendar are off.',
          ...(onlyToAsker ? { onlyToAsker: true as const } : {}),
        };
      },
    };
  }

  /** The asker's own SMS channel, verified, as enrolment leaves it. */
  async function enrolAsker(h: Harness, phone = PHONE): Promise<void> {
    vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
    await h.fake.db.insert(schema.parentChannels).values({
      familyId: FAMILY,
      userId: PARENT,
      kind: 'sms',
      phoneE164Encrypted: encryptString(phone),
      phoneE164Hash: 'hash-asker',
      verifiedAt: NOW,
      revokedAt: null,
    });
  }

  it('a group turn: a receipt marked for its asker goes 1:1 to them, never into the group', async () => {
    const h = harness({
      handlers: [askerOnlyHandler(true)],
      context: { reply: GROUP_ROUTE, inGroup: true },
    });
    await enrolAsker(h);

    const result = await routeChannelMessage(h.deps, job({ in_group: true }));

    expect(result.status).toBe('handled');
    expect(h.transport.sent).toEqual([
      { route: SMS_ROUTE, body: 'Your Gmail and Calendar are off.' },
    ]);
    const out = ledgerRows(h.fake).filter((r) => r.direction === 'out');
    expect(out).toHaveLength(1);
    expect(out[0]?.relatedConversationId).toBeNull();
  });

  it('a group turn whose asker has no enrolled SMS channel: nothing sent anywhere, named', async () => {
    const h = harness({
      handlers: [askerOnlyHandler(true)],
      context: { reply: GROUP_ROUTE, inGroup: true },
    });

    const result = await routeChannelMessage(h.deps, job({ in_group: true }));

    expect(result).toMatchObject({ status: 'asker_unreachable', handler: 'asker_only' });
    expect(h.transport.sent).toEqual([]);
  });

  it('a group turn from an Apple ID handle: no SMS to an address, nothing to the group', async () => {
    const h = harness({
      handlers: [askerOnlyHandler(true)],
      context: { reply: { ...GROUP_ROUTE, to: 'parent@icloud.example' }, inGroup: true },
    });
    await enrolAsker(h);

    const result = await routeChannelMessage(h.deps, job({ in_group: true }));

    expect(result).toMatchObject({ status: 'asker_unreachable', handler: 'asker_only' });
    expect(h.transport.sent).toEqual([]);
  });

  it("a group handle that is a phone, but not the asker's enrolled one: nothing sent", async () => {
    const h = harness({
      handlers: [askerOnlyHandler(true)],
      context: { reply: GROUP_ROUTE, inGroup: true },
    });
    await enrolAsker(h, '+12025550143');

    const result = await routeChannelMessage(h.deps, job({ in_group: true }));

    expect(result).toMatchObject({ status: 'asker_unreachable', handler: 'asker_only' });
    expect(h.transport.sent).toEqual([]);
  });

  it('a resolved answer whose owner marks the receipt for its asker goes 1:1 too', async () => {
    const planned: OpenQuestion = {
      id: 'dddd4444-4444-4444-8444-444444444444',
      kind: 'approval',
      description: 'Add to your calendar',
      subject: 'add to your calendar',
      answerable: { yes: true, no: true },
      askedAt: null,
      solicited: false,
    };
    const owner = {
      name: 'owner_approval',
      resolves: new Set(['approval']),
      async handle(_db: unknown, ctx: { resolved: { questionId: string } | null }) {
        if (!ctx.resolved) return { claimed: false };
        return { claimed: true, outcome: 'acted', reply: 'Done, just for you.', onlyToAsker: true };
      },
    } as unknown as DeterministicHandler;
    const resolver = {
      async read() {
        return {
          status: 'resolved' as const,
          questionId: planned.id,
          kind: 'approval' as const,
          polarity: 'yes' as const,
          confidence: 'high' as const,
        };
      },
    };
    const h = harness({
      context: { body: 'yes', reply: GROUP_ROUTE, inGroup: true },
      handlers: [owner],
      questions: fakeQuestions([planned]),
      replyResolver: resolver as never,
    });
    h.deps.groupPlanActionIds = async () => new Set([planned.id]);
    await enrolAsker(h);

    const result = await routeChannelMessage(h.deps, job({ in_group: true }));

    expect(result.status).toBe('resolved');
    expect(h.transport.sent).toEqual([{ route: SMS_ROUTE, body: 'Done, just for you.' }]);
  });

  it('positive control: the same receipt without the mark answers in the group', async () => {
    const h = harness({
      handlers: [askerOnlyHandler(false)],
      context: { reply: GROUP_ROUTE, inGroup: true },
    });

    await routeChannelMessage(h.deps, job({ in_group: true }));

    expect(h.transport.sent).toEqual([
      { route: GROUP_ROUTE, body: 'Your Gmail and Calendar are off.' },
    ]);
  });

  it('a 1:1 turn: a receipt marked for its asker is the ordinary answer in their own thread', async () => {
    const h = harness({ handlers: [askerOnlyHandler(true)] });

    await routeChannelMessage(h.deps, job());

    expect(h.transport.sent).toEqual([
      { route: SMS_ROUTE, body: 'Your Gmail and Calendar are off.' },
    ]);
    const out = ledgerRows(h.fake).filter((r) => r.direction === 'out');
    expect(out[0]?.relatedConversationId).not.toBeNull();
  });

  it('a 1:1 text re-driven by the reconciler with its stored bit (false) runs, in its own thread', async () => {
    const coach = fakeCoach();
    const h = harness({ coach, context: { reply: GROUP_ROUTE, inGroup: false } });
    // `redriven` is the turn ledger's business; the job is the reconciler's shape.
    const result = await routeChannelMessage(h.deps, job({ in_group: false }));
    expect(result.status).toBe('agent_replied');
    expect(coach.calls).toBe(1);
    expect(conversationRows(h.fake)).toHaveLength(1);
  });

  async function overLimitDirectTurn(floodLine: FloodLineComposer) {
    const limiter = new FakeRateLimiter(() => NOW.getTime());
    for (let i = 0; i < AGENT_TURNS_PER_HOUR; i += 1) {
      await limiter.check(PARENT, 'sms-agent-turn', {
        limit: AGENT_TURNS_PER_HOUR,
        windowSec: 3600,
      });
    }
    const h = harness({ limiter, floodLine });
    const result = await routeChannelMessage(h.deps, job());
    return { h, result };
  }

  it('answers a 1:1 over-limit text with the composed line, told it is 1:1', async () => {
    const seen: unknown[] = [];
    const flood: FloodLineComposer = {
      async compose(facts) {
        seen.push(facts);
        return { status: 'composed', line: 'Swamped for a second.' };
      },
    };
    const { h, result } = await overLimitDirectTurn(flood);

    expect(result.status).toBe('flood_held');
    expect(seen).toEqual([{ language: null, inGroup: false }]);
    expect(h.transport.sent).toEqual([{ route: SMS_ROUTE, body: 'Swamped for a second.' }]);
  });

  it('records the 1:1 over-limit answer under the flood line template key', async () => {
    const { h } = await overLimitDirectTurn(
      fakeFloodLine({ status: 'composed', line: 'Swamped for a second.' }),
    );
    expect(ledgerRows(h.fake).filter((r) => r.direction === 'out')).toEqual([
      expect.objectContaining({ templateKey: 'flood_line' }),
    ]);
  });

  it('composes the over-limit line once per budget window: later texts make no model call', async () => {
    const limiter = new FakeRateLimiter(() => NOW.getTime());
    for (let i = 0; i < AGENT_TURNS_PER_HOUR; i += 1) {
      await limiter.check(PARENT, 'sms-agent-turn', {
        limit: AGENT_TURNS_PER_HOUR,
        windowSec: 3600,
      });
    }
    const flood = fakeFloodLine({ status: 'composed', line: 'Swamped for a second.' });
    const h = harness({ limiter, floodLine: flood });
    const results = [];
    for (let i = 0; i < 3; i += 1) {
      results.push((await routeChannelMessage(h.deps, nthJob(AGENT_TURNS_PER_HOUR + i))).status);
    }
    expect(results).toEqual(['flood_held', 'flood_held', 'flood_held']);
    expect(flood.calls).toBe(1);
    expect(h.transport.bodies()).toEqual(['Swamped for a second.']);
  });

  it('a failed compose still spends the window: the next over-limit text does not retry it', async () => {
    const limiter = new FakeRateLimiter(() => NOW.getTime());
    for (let i = 0; i < AGENT_TURNS_PER_HOUR; i += 1) {
      await limiter.check(PARENT, 'sms-agent-turn', {
        limit: AGENT_TURNS_PER_HOUR,
        windowSec: 3600,
      });
    }
    const flood = fakeFloodLine({ status: 'unavailable', reason: 'model_failed' });
    const h = harness({ limiter, floodLine: flood });
    await routeChannelMessage(h.deps, nthJob(AGENT_TURNS_PER_HOUR));
    await routeChannelMessage(h.deps, nthJob(AGENT_TURNS_PER_HOUR + 1));
    expect(flood.calls).toBe(1);
    expect(h.transport.sent).toEqual([]);
  });

  it('sends nothing on a 1:1 over-limit text when the line cannot be composed', async () => {
    const { h, result } = await overLimitDirectTurn(
      fakeFloodLine({ status: 'unavailable', reason: 'model_failed' }),
    );
    expect(result.status).toBe('flood_held');
    expect(h.transport.sent).toEqual([]);
    expect(ledgerRows(h.fake).filter((r) => r.direction === 'out')).toEqual([]);
  });

  it('sends nothing at all when the over-limit line cannot be composed', async () => {
    const flood = fakeFloodLine({ status: 'unavailable', reason: 'model_failed' });
    const { h, result } = await overLimitGroupTurn(flood);

    expect(result.status).toBe('flood_held');
    expect(flood.calls).toBe(1);
    expect(h.transport.sent).toEqual([]);
    expect(ledgerRows(h.fake).filter((r) => r.direction === 'out')).toEqual([]);
  });
});

describe('VIL-581 · the claim shadow starts after the send and changes nothing', () => {
  type CoachTurnCall = Parameters<ClaimShadow['coachTurn']>;
  function recordingShadow() {
    const calls: Array<{ args: CoachTurnCall; sentBefore: number }> = [];
    const seen: { transport?: FakeReplyTransport } = {};
    const shadow: ClaimShadow = {
      coachTurn: (...args) => {
        calls.push({ args, sentBefore: seen.transport?.sent.length ?? -1 });
        return 'started';
      },
      sweep: () => 'off',
      dispatch: () => 'off',
    };
    return { shadow, calls, seen };
  }
  function scripted(replies: readonly string[]): ChannelCoachRuntime {
    let attempt = 0;
    return {
      async respond() {
        const reply = replies[Math.min(attempt, replies.length - 1)] ?? '';
        attempt += 1;
        return { reply, planOffer: null, activityPromise: null, spotWatch: null };
      },
    };
  }

  it('a clean turn: one call, after the transport took the reply, with the sent reply', async () => {
    const rec = recordingShadow();
    const h = harness({
      coach: fakeCoach('Saturday has two indoor options.'),
      claimShadow: rec.shadow,
    });
    rec.seen.transport = h.transport;
    await routeChannelMessage(h.deps, job());

    expect(rec.calls).toHaveLength(1);
    const call = rec.calls[0] as (typeof rec.calls)[number];
    expect(call.sentBefore).toBe(1);
    const [database, input] = call.args;
    expect(database).toBe(h.deps.database);
    expect(input.attempts).toHaveLength(1);
    expect(input.attempts[0]?.reply).toBe(h.transport.bodies()[0]);
    expect(input.inbound).toBe('anything indoors this weekend?');
    expect(input.familyId).toBe(FAMILY);
    expect(input.parentUserId).toBe(PARENT);

    const baseline = harness({ coach: fakeCoach('Saturday has two indoor options.') });
    await routeChannelMessage(baseline.deps, job());
    expect(h.transport.bodies()).toEqual(baseline.transport.bodies());
  });

  it('a re-asked turn hands over both attempts, the first with its refusal', async () => {
    const rec = recordingShadow();
    const h = harness({
      coach: scripted([
        "I'm watching that morning and I'll text you before it goes live.",
        'Riverford has not published a winter date yet.',
      ]),
      claimShadow: rec.shadow,
    });
    rec.seen.transport = h.transport;
    await routeChannelMessage(h.deps, job());

    expect(h.transport.bodies()).toEqual(['Riverford has not published a winter date yet.']);
    const attempts = rec.calls[0]?.args[1].attempts ?? [];
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.verdict.refused).toHaveLength(1);
    expect(attempts[1]?.verdict.refused).toHaveLength(0);
  });

  it('an empty reply sends nothing and starts no shadow (control)', async () => {
    const rec = recordingShadow();
    const h = harness({ coach: fakeCoach(''), claimShadow: rec.shadow });
    rec.seen.transport = h.transport;
    await routeChannelMessage(h.deps, job());
    expect(h.transport.sent).toEqual([]);
    expect(rec.calls).toEqual([]);
  });
});

describe('VIL-581 PR 3 · enforce: every claim a sentence makes must cite a row', () => {
  const INTRO = 'Here are two indoor options.';
  // VIL-580's reproducer: a real follow-up and a false booking in one sentence.
  const REPRODUCER =
    "Registration opens Tuesday, and I'll keep looking for toddler activities; your well-baby visit is booked.";
  const FOLLOW_UP = "I'll keep looking for toddler activities.";
  const PROMISE: ActivityPromise = { subject: 'toddler activities', childId: null };

  function scriptedCoach(
    turns: readonly { reply: string; promise?: boolean; drafted?: string[] }[],
  ): ChannelCoachRuntime & { calls: number; rejected: string[][] } {
    const coach = {
      calls: 0,
      rejected: [] as string[][],
      async respond(_turn: ChannelTurn, rejectedLastAttempt: readonly string[]) {
        const scripted = turns[Math.min(coach.calls, turns.length - 1)];
        coach.calls += 1;
        coach.rejected.push([...rejectedLastAttempt]);
        return {
          reply: scripted?.reply ?? '',
          planOffer: null,
          activityPromise: scripted?.promise ? PROMISE : null,
          spotWatch: null,
          ...(scripted?.drafted ? { draftedActionIds: scripted.drafted } : {}),
        };
      },
    };
    return coach;
  }

  /** The reader cites the pending follow-up for its clause and no row for a booking. */
  const readsLikeTheEval = () =>
    scriptedClaimReader((segments) =>
      segments.flatMap((segment) => [
        ...(/keep looking/.test(segment.text)
          ? [{ segment: segment.index, kind: 'activity_followup' as const, row: 'p1' as const }]
          : []),
        ...(/booked/.test(segment.text)
          ? [{ segment: segment.index, kind: 'scheduled_event' as const, row: 'none' as const }]
          : []),
      ]),
    );

  function enforcer(reader: ClaimReader): ClaimEnforcer {
    return createClaimEnforcer({
      enforces: () => true,
      reader,
      loadContext: async (_db, input) => ({
        status: 'ready',
        rows: input.pending?.activityFollowup
          ? [
              {
                familyId: FAMILY,
                source: 'pending',
                kind: 'activity_followup',
                what: claimRowLabel({ from: 'pending', text: input.pending.activityFollowup }, NOW),
              },
            ]
          : [],
        language: 'en',
        timeZone: 'America/New_York',
      }),
    });
  }

  function recorded() {
    const promises: unknown[] = [];
    const research: unknown[] = [];
    const options: Pick<
      Parameters<typeof harness>[0] & object,
      'recordActivityPromise' | 'dispatchDeepResearch'
    > = {
      recordActivityPromise: async (_db, input) => {
        promises.push(input);
        return { status: 'recorded' as const, commitmentId: PROMISE_COMMITMENT_ID };
      },
      dispatchDeepResearch: async (payload) => {
        research.push(payload);
        return { status: 'enqueued' as const, jobId: 'job-1' };
      },
    };
    return { promises, research, options };
  }

  it('off: the regex reads the reproducer as a follow-up only, so the false booking goes out (the hole)', async () => {
    const rec = recorded();
    const coach = scriptedCoach([{ reply: `${INTRO} ${REPRODUCER}`, promise: true }]);
    const h = harness({ coach, ...rec.options });
    await routeChannelMessage(h.deps, job());
    expect(h.transport.bodies()).toEqual([`${INTRO} ${REPRODUCER}`]);
    expect(rec.promises).toHaveLength(1);
  });

  it('enforce: the booking is refused, re-asked, then its whole sentence is cut and the promise it carried is not written', async () => {
    const rec = recorded();
    const coach = scriptedCoach([{ reply: `${INTRO} ${REPRODUCER}`, promise: true }]);
    const h = harness({ coach, claimEnforcer: enforcer(readsLikeTheEval()), ...rec.options });
    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('agent_replied');
    expect(coach.calls).toBe(2);
    expect(coach.rejected[1]?.join(' ')).toMatch(/something is booked or on the calendar/);
    expect(h.transport.bodies()).toEqual([INTRO]);
    // The follow-up's sentence never reached the parent, so nothing promises it.
    expect(rec.promises).toEqual([]);
    expect(rec.research).toEqual([]);
    expect(JSON.stringify(h.logs)).toContain('promise_cut');
  });

  it('enforce: a re-asked reply that keeps only the follow-up is sent, and its promise is written', async () => {
    const rec = recorded();
    const coach = scriptedCoach([
      { reply: `${INTRO} ${REPRODUCER}`, promise: true },
      { reply: `${INTRO} ${FOLLOW_UP}`, promise: true },
    ]);
    const h = harness({ coach, claimEnforcer: enforcer(readsLikeTheEval()), ...rec.options });
    await routeChannelMessage(h.deps, job());
    expect(h.transport.bodies()).toEqual([`${INTRO} ${FOLLOW_UP}`]);
    expect(rec.promises).toHaveLength(1);
  });

  it('enforce: an enforced turn starts no shadow read; it was read before the send', async () => {
    const calls: unknown[] = [];
    const reader = readsLikeTheEval();
    const h = harness({
      coach: fakeCoach(INTRO),
      claimEnforcer: enforcer(reader),
      claimShadow: {
        ...offShadow(),
        coachTurn: (...args) => {
          calls.push(args);
          return 'started';
        },
      },
    });
    await routeChannelMessage(h.deps, job());
    expect(h.transport.bodies()).toEqual([INTRO]);
    expect(reader.bodies).toEqual([INTRO]);
    expect(calls).toEqual([]);
  });

  describe('a read that fails after the coach ran claims the turn and never re-drives it', () => {
    const failing = () => scriptedClaimReader(() => 'unreachable');

    it('sends the composed apology, records the failure, defers nothing', async () => {
      const coach = scriptedCoach([{ reply: INTRO }]);
      const apology = fakeApology();
      const h = harness({ coach, apology, claimEnforcer: enforcer(failing()) });
      const result = await routeChannelMessage(h.deps, job());

      expect(result.status).toBe('agent_failed');
      expect(h.transport.bodies()).toEqual([APOLOGY]);
      expect(h.turns.failed.map((f) => f.reason)).toEqual(['apology_sent']);
      expect(h.turns.deferred).toEqual([]);
      expect(coach.calls).toBe(1);
    });

    it('names the drafts the coach already made instead of apologising', async () => {
      const coach = scriptedCoach([{ reply: INTRO, drafted: ['action-1', 'action-2'] }]);
      const apology = fakeApology();
      const h = harness({ coach, apology, claimEnforcer: enforcer(failing()) });
      await routeChannelMessage(h.deps, job());
      expect(h.transport.bodies()).toEqual([
        writtenAsk({ kind: 'partial_failure', draftCount: 2 }),
      ]);
      expect(apology.calls).toBe(0);
    });

    it('with no apology either: nothing is sent, the turn is claimed, and a redelivery never reruns the coach', async () => {
      const turns = fakeTurnLedger();
      const coach = scriptedCoach([{ reply: INTRO }]);
      const h = harness({
        coach,
        turns,
        apology: fakeApology({ status: 'unreachable' }),
        claimEnforcer: enforcer(failing()),
      });
      expect((await routeChannelMessage(h.deps, job())).status).toBe('agent_failed');
      expect(h.transport.sent).toEqual([]);
      expect(turns.failed.map((f) => f.reason)).toEqual(['claim_read_failed']);
      expect(turns.deferred).toEqual([]);

      const rerun = scriptedCoach([{ reply: 'should never run' }]);
      const again = harness({ coach: rerun, turns, claimEnforcer: enforcer(failing()) });
      expect((await routeChannelMessage(again.deps, job())).status).toBe('already_answered');
      expect(rerun.calls).toBe(0);
    });
  });
});

/**
 * VIL-602 · a live crisis reply counts as answered only once the transport accepted it.
 * The opt-out recovery pass releases a held copy of the text without replying when it is
 * marked answered, so a mark taken on a reply that never left would leave a crisis with
 * nothing. The lane is production's marking wrapper over faked model ports; the mark is
 * real SQL.
 */
describe('a live crisis reply is marked answered only once it is sent', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const CRISIS_TEXT = 'i cannot keep going';

  function crisisLane(): OffDomainLane {
    return crisisMarkingLane(db.database, {
      screen: {
        read: async () => ({
          lane: 'safety_critical',
          category: 'mental-health',
          fallback: null,
          language: 'en',
        }),
      },
      answer: {
        compose: async () => {
          throw new Error('a crisis is never composed as a general answer');
        },
        continueAsk: async () => ({ status: 'unrelated' }),
      },
      moment: { write: async () => ({ status: 'written', reply: 'a written crisis reply' }) },
      today: async () => '2026-10-20',
      place: async () => ({ status: 'unknown', reason: 'no_postal' }),
      healthPlace: async () => null,
      pendingAsk: async () => ({ status: 'none' }),
      medical: {
        answer: async () => {
          throw new Error('not a medical text');
        },
      },
      recordUnmetIntent: async () => 'recorded',
    });
  }

  /** One crisis text through the router; `transport` replaces the harness's own. */
  async function crisisTurn(
    providerMessageId: string,
    transport: ChannelRouterDeps['transport'] | null,
    options: Parameters<typeof harness>[0] = {},
  ) {
    const parent = await seedFamily(db.database);
    const h = harness({
      offDomain: crisisLane(),
      ...options,
      context: { body: CRISIS_TEXT, reply: SMS_ROUTE },
    });
    h.deps.database = db.database;
    h.deps.now = () => new Date();
    if (transport) h.deps.transport = transport;
    const [inbound] = await db.database
      .insert(schema.channelMessages)
      .values({
        ...parent,
        channel: 'sms',
        direction: 'in',
        category: 'reply',
        status: 'delivered',
        providerMessageId,
        body: CRISIS_TEXT,
      })
      .returning({ id: schema.channelMessages.id });
    const outcome = await routeChannelMessage(
      h.deps,
      job({
        family_id: parent.familyId,
        parent_user_id: parent.parentUserId,
        channel_message_id: inbound?.id as string,
        provider_message_id: providerMessageId,
      }),
    ).then(
      () => 'routed' as const,
      () => 'threw' as const,
    );
    return { h, outcome };
  }

  /** The reply marks for one inbound: 1 is answered, 0 is a reply still leaving. */
  async function marks(providerMessageId: string): Promise<number[]> {
    const rows = await db.database
      .select({ count: schema.rateLimits.count })
      .from(schema.rateLimits)
      .where(
        and(
          eq(schema.rateLimits.route, CRISIS_ANSWERED_ROUTE),
          eq(
            schema.rateLimits.identifier,
            createHash('sha256').update(providerMessageId).digest('hex').slice(0, 32),
          ),
        ),
      );
    return rows.map((row) => row.count);
  }

  it('a crisis reply whose send throws is never marked answered', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { outcome } = await crisisTurn('pm-route-refused', {
      send: async () => {
        throw new Error('carrier refused');
      },
    });

    expect(outcome).toBe('threw');
    expect(await marks('pm-route-refused')).toEqual([0]);
  });

  it('a crisis reply whose send never comes back is never marked answered', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { outcome } = await crisisTurn(
      'pm-route-hung',
      { send: () => new Promise(() => {}) },
      { turnDeadlineMs: 200 },
    );

    expect(outcome).toBe('threw');
    expect(await marks('pm-route-hung')).toEqual([0]);
  });

  it('a crisis reply the transport accepted is marked answered even when its receipt write throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const receiptless = new Proxy(db.database, {
      get(target, prop, receiver) {
        if (prop === 'insert') {
          return (table: unknown) => {
            if (table === schema.channelMessages) throw new Error('receipt lost');
            return target.insert(table as typeof schema.auditLog);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof db.database;
    const parent = await seedFamily(db.database);
    const h = harness({
      offDomain: crisisLane(),
      context: { body: CRISIS_TEXT, reply: SMS_ROUTE },
    });
    h.deps.database = receiptless;
    h.deps.now = () => new Date();
    const [inbound] = await db.database
      .insert(schema.channelMessages)
      .values({
        ...parent,
        channel: 'sms',
        direction: 'in',
        category: 'reply',
        status: 'delivered',
        providerMessageId: 'pm-route-receiptless',
        body: CRISIS_TEXT,
      })
      .returning({ id: schema.channelMessages.id });

    const outcome = await routeChannelMessage(
      h.deps,
      job({
        family_id: parent.familyId,
        parent_user_id: parent.parentUserId,
        channel_message_id: inbound?.id as string,
        provider_message_id: 'pm-route-receiptless',
      }),
    ).then(
      () => 'routed',
      () => 'threw',
    );

    // Positive control: the fault fired after the parent had the reply.
    expect(outcome).toBe('threw');
    expect(h.transport.bodies()).toEqual(['a written crisis reply']);
    expect(await marks('pm-route-receiptless')).toEqual([1]);
  });

  it('positive control: a crisis reply the transport accepted is marked answered', async () => {
    const { h, outcome } = await crisisTurn('pm-route-sent', null);

    expect(outcome).toBe('routed');
    expect(h.transport.bodies()).toEqual(['a written crisis reply']);
    expect(await marks('pm-route-sent')).toEqual([1]);
  });
});

/**
 * VIL-303 · the no a reply gave about a deferred capability, or the earlier no it
 * corrected, is written against the message that carried it, and only once it was sent.
 */
describe('capability notes ride out with the reply', () => {
  const NOTES = { declined: ['spot_watch' as const], corrected: ['sign_up' as const] };

  function notingCoach(reply: string): ChannelCoachRuntime {
    return {
      async respond() {
        return {
          reply,
          planOffer: null,
          activityPromise: null,
          spotWatch: null,
          capabilityNotes: NOTES,
        };
      },
    };
  }

  it('records the notes against the sent message', async () => {
    const noted: unknown[] = [];
    const h = harness({
      coach: notingCoach('Watching a full class is not something I can do yet.'),
      recordCapabilityNotes: async (_db, input) => {
        noted.push(input);
        return { status: 'recorded' as const, declined: 1, corrected: 1 };
      },
    });

    await routeChannelMessage(h.deps, job());

    expect(h.transport.sent).toHaveLength(1);
    expect(noted).toEqual([
      expect.objectContaining({
        familyId: FAMILY,
        parentUserId: PARENT,
        notes: NOTES,
        channelMessageId: ledgerRows(h.fake).find((row) => row.direction === 'out')?.id,
      }),
    ]);
  });

  it('records nothing when the reply is empty and nothing is sent', async () => {
    const noted: unknown[] = [];
    const h = harness({
      coach: notingCoach(''),
      recordCapabilityNotes: async (_db, input) => {
        noted.push(input);
        return { status: 'recorded' as const, declined: 1, corrected: 1 };
      },
    });

    await routeChannelMessage(h.deps, job());

    expect(h.transport.sent).toHaveLength(0);
    expect(noted).toEqual([]);
  });

  it('records nothing when the reconcile cuts part of the reply, and names the drop', async () => {
    const noted: unknown[] = [];
    const h = harness({
      coach: notingCoach(
        'Watching a full class is not something I can do yet. Thursday swim is booked at 5:15.',
      ),
      recordCapabilityNotes: async (_db, input) => {
        noted.push(input);
        return { status: 'recorded' as const, declined: 1, corrected: 1 };
      },
    });

    await routeChannelMessage(h.deps, job());

    // Positive control: the cut happened and the surviving half was sent.
    expect(h.transport.sent.map((m) => m.body)).toEqual([
      'Watching a full class is not something I can do yet.',
    ]);
    expect(noted).toEqual([]);
    expect(JSON.stringify(h.logs)).toContain('capability_notes_cut');
  });
});

/**
 * ONE ANSWER, SEVERAL SHORT BUBBLES (Barton 2026-11-11). On a 1:1 iMessage chat with
 * COACH_BUBBLES lit for the family, the coach's reply carries a line break between
 * bubbles (coach/reply.ts) and the router sends each one, in order, as its own message.
 * What happens once per ANSWER (the moment read, the claim, the mirror, the post-send
 * writes) still happens once; what a delivered message leaves behind (a ledger row with
 * its own dedupe key, an audit row, a thread row) happens once per bubble.
 */
describe('one answer as several bubbles on a 1:1 iMessage chat', () => {
  const ID = job().channel_message_id;
  const IMESSAGE: ReplyRoute = {
    channel: 'imessage',
    to: PHONE,
    chatId: 'chat-1',
    replyToMessageId: 'in-1',
    service: 'iMessage',
  };
  const WATCH: SpotWatchIntent = {
    url: 'https://rec.example.test/courses/tuesday-swim',
    host: 'rec.example.test',
    portalLabel: "the city's portal",
    label: 'Tuesday preschool swim',
    instant: false,
    lastState: 'full',
    sessionStartsAt: null,
    sessionAnchor: null,
  };
  const UNTHREADED: ReplyRoute = { ...IMESSAGE, replyToMessageId: null };
  const THREE = 'Swim is Saturday at 10.\nBring a towel.\nWant me to add it to your calendar?';
  const OFFER = { sentence: 'Want the full plan for his nights?', topic: 'sleep' } as never;
  const PROMISE: ActivityPromise = { subject: 'toddler swim nearby', childId: null };

  /** A coach that records the turn it was handed and answers with `result`. */
  function seeingCoach(
    result: Partial<ChannelTurnResult> & { reply: string },
  ): ChannelCoachRuntime & { turns: ChannelTurn[] } {
    const coach = {
      turns: [] as ChannelTurn[],
      async respond(turn: ChannelTurn) {
        coach.turns.push(turn);
        return { planOffer: null, activityPromise: null, spotWatch: null, ...result };
      },
    };
    return coach;
  }

  function bubbleTurn(
    result: Partial<ChannelTurnResult> & { reply: string } = { reply: THREE },
    options: Parameters<typeof harness>[0] = {},
  ) {
    vi.stubEnv('COACH_BUBBLES_ENABLED', 'true');
    const coach = seeingCoach(result);
    const h = harness({
      coach,
      context: { body: 'what is on saturday', reply: IMESSAGE },
      ...options,
    });
    return { h, coach };
  }

  const outRows = (fake: FakeDb) => ledgerRows(fake).filter((row) => row.direction === 'out');

  afterEach(() => {
    effectDecide.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('sends each bubble in order, threads only the first, and keys one ledger row per bubble', async () => {
    const { h, coach } = bubbleTurn();
    const claimedAtSend: number[] = [];
    const send = h.transport.send.bind(h.transport);
    h.transport.send = async (input) => {
      claimedAtSend.push(h.turns.answered.length);
      return send(input);
    };

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('agent_replied');
    expect(coach.turns[0]?.replyBubbles).toBe(true);
    expect(h.transport.sent).toEqual([
      { route: IMESSAGE, body: 'Swim is Saturday at 10.', sendKey: `turn-reply:${ID}:0` },
      { route: UNTHREADED, body: 'Bring a towel.', sendKey: `turn-reply:${ID}:1` },
      {
        route: UNTHREADED,
        body: 'Want me to add it to your calendar?',
        sendKey: `turn-reply:${ID}:2`,
      },
    ]);
    // Claimed once, after the first bubble went and before the second.
    expect(claimedAtSend).toEqual([0, 1, 1]);
    expect(h.turns.answered).toEqual([ID]);
    const out = outRows(h.fake);
    expect(out.map((row) => [row.dedupeKey, row.providerMessageId, row.body])).toEqual([
      [`turn-reply:${ID}:0`, 'fake-out-1', null],
      [`turn-reply:${ID}:1`, 'fake-out-2', null],
      [`turn-reply:${ID}:2`, 'fake-out-3', null],
    ]);
    expect(
      auditRows(h.fake)
        .filter((row) => row.actionTaken === 'sms_reply_sent')
        .map((row) => row.targetId),
    ).toEqual(out.map((row) => row.id));
    expect(
      messageRows(h.fake)
        .filter((row) => row.role === 'assistant')
        .map((row) => row.content),
    ).toEqual(['Swim is Saturday at 10.', 'Bring a towel.', 'Want me to add it to your calendar?']);
  });

  it('dark: the turn is not lit and a line break in the reply is not split', async () => {
    const coach = seeingCoach({ reply: 'Swim is Saturday at 10.\nhttps://pool.example/swim' });
    const h = harness({ coach, context: { body: 'what is on saturday', reply: IMESSAGE } });

    await routeChannelMessage(h.deps, job());

    expect(coach.turns[0]).not.toHaveProperty('replyBubbles');
    expect(h.transport.sent).toEqual([
      { route: IMESSAGE, body: 'Swim is Saturday at 10.\nhttps://pool.example/swim' },
    ]);
    expect(outRows(h.fake)[0]?.dedupeKey).toBeUndefined();
  });

  it('lit, an SMS route is not lit for bubbles and sends one text', async () => {
    const { h, coach } = bubbleTurn(
      { reply: 'Swim is Saturday at 10.' },
      { context: { body: 'what is on saturday', reply: SMS_ROUTE } },
    );

    await routeChannelMessage(h.deps, job());

    expect(coach.turns[0]).not.toHaveProperty('replyBubbles');
    expect(h.transport.bodies()).toEqual(['Swim is Saturday at 10.']);
  });

  /**
   * Linq relays green-bubble chats on the iMessage channel, and a carrier can deliver
   * separate texts out of order. Only a chat Linq said is iMessage takes bubbles; a chat
   * whose service Linq did not name is not assumed to be one.
   */
  it.each([
    ['SMS', { ...IMESSAGE, service: 'SMS' }],
    ['RCS', { ...IMESSAGE, service: 'RCS' }],
    ['an unnamed service', { ...IMESSAGE, service: null }],
    ['no service on the route', { ...IMESSAGE, service: undefined }],
  ] as const)(
    'lit, a 1:1 Linq chat over %s is not lit for bubbles and sends one text',
    async (_label, route) => {
      const { h, coach } = bubbleTurn(
        { reply: 'Swim is Saturday at 10.' },
        { context: { body: 'what is on saturday', reply: route } },
      );

      await routeChannelMessage(h.deps, job());

      expect(coach.turns[0]).not.toHaveProperty('replyBubbles');
      expect(h.transport.sent).toEqual([{ route, body: 'Swim is Saturday at 10.' }]);
    },
  );

  it('lit, a group turn is not lit for bubbles', async () => {
    const { h, coach } = bubbleTurn(
      { reply: 'Swim is Saturday at 10.' },
      { context: { body: 'hale what is on saturday', reply: IMESSAGE, inGroup: true } },
    );

    await routeChannelMessage(h.deps, job({ in_group: true }));

    expect(coach.turns[0]).not.toHaveProperty('replyBubbles');
    expect(h.transport.bodies()).toEqual(['Swim is Saturday at 10.']);
  });

  it('writes what the answer promised against the LAST bubble', async () => {
    const offers: Array<string | null> = [];
    const promises: Array<string | null> = [];
    const { h } = bubbleTurn(
      { reply: THREE, planOffer: OFFER, activityPromise: PROMISE },
      {
        recordPlanOffer: async (_db, input) => {
          offers.push(input.channelMessageId);
          return { status: 'recorded' };
        },
        recordActivityPromise: async (_db, input) => {
          promises.push(input.channelMessageId);
          return { status: 'recorded' as const, commitmentId: PROMISE_COMMITMENT_ID };
        },
      },
    );

    await routeChannelMessage(h.deps, job());

    const last = outRows(h.fake)[2]?.id;
    expect(last).toEqual(expect.any(String));
    expect(offers).toEqual([last]);
    expect(promises).toEqual([last]);
  });

  /**
   * Any bubble may carry "I'll come back to you" or "I'm watching that page". A set that
   * stops after such a bubble went still writes the promise and the watch, against the
   * last bubble that went. The offer rides the last bubble, which never went, so a later
   * yes has no offer to land on.
   */
  it('a set that stops partway still keeps what the bubbles that went promised', async () => {
    const offers: Array<string | null> = [];
    const promises: Array<string | null> = [];
    const watches: Array<string | null> = [];
    const { h } = bubbleTurn(
      {
        reply:
          'Nothing for winter is up yet.\nI will go back through it tomorrow and watch the Tuesday page.\nWant the full plan for his nights?',
        planOffer: OFFER,
        activityPromise: PROMISE,
        spotWatch: WATCH,
      },
      {
        recordPlanOffer: async (_db, input) => {
          offers.push(input.channelMessageId);
          return { status: 'recorded' };
        },
        recordActivityPromise: async (_db, input) => {
          promises.push(input.channelMessageId);
          return { status: 'recorded' as const, commitmentId: PROMISE_COMMITMENT_ID };
        },
        armWatchedSpot: async (_db, input) => {
          watches.push(input.channelMessageId);
          return { status: 'armed' as const, spotId: 'spot-1' };
        },
      },
    );
    const send = h.transport.send.bind(h.transport);
    let calls = 0;
    h.transport.send = async (input) => {
      calls += 1;
      if (calls === 3) throw new Error('linq refused');
      return send(input);
    };

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('agent_failed');
    expect(h.transport.bodies()).toEqual([
      'Nothing for winter is up yet.',
      'I will go back through it tomorrow and watch the Tuesday page.',
    ]);
    const out = outRows(h.fake);
    expect(out.map((row) => row.dedupeKey)).toEqual([`turn-reply:${ID}:0`, `turn-reply:${ID}:1`]);
    expect(promises).toEqual([out[1]?.id]);
    expect(watches).toEqual([out[1]?.id]);
    expect(offers).toEqual([]);
    expect(h.turns.failed).toEqual([{ channelMessageId: ID, reason: 'reply_set_incomplete' }]);
  });

  it('stops after a bubble fails: what went is on record and claimed, nothing is re-sent', async () => {
    const offers: Array<string | null> = [];
    const { h } = bubbleTurn(
      { reply: THREE, planOffer: OFFER },
      {
        recordPlanOffer: async (_db, input) => {
          offers.push(input.channelMessageId);
          return { status: 'recorded' };
        },
      },
    );
    const send = h.transport.send.bind(h.transport);
    let calls = 0;
    h.transport.send = async (input) => {
      calls += 1;
      if (calls === 2) throw new Error('linq refused');
      return send(input);
    };

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('agent_failed');
    expect(h.transport.bodies()).toEqual(['Swim is Saturday at 10.']);
    expect(outRows(h.fake).map((row) => row.dedupeKey)).toEqual([`turn-reply:${ID}:0`]);
    expect(h.turns.answered).toEqual([ID]);
    expect(h.turns.failed).toEqual([{ channelMessageId: ID, reason: 'reply_set_incomplete' }]);
    expect(offers).toEqual([]);
    expect(JSON.stringify(h.logs)).toContain(
      '{"outcome":"reply_set_incomplete","bubblesSent":1,"bubbles":3}',
    );

    // The re-drive stops at the door: the turn is claimed.
    const again = await routeChannelMessage(h.deps, job());
    expect(again.status).toBe('already_answered');
    expect(calls).toBe(2);
  });

  /**
   * The send went and its receipt did not land. The parent has two bubbles, so this is a
   * set that stopped partway, named as one with how far it got, and not a turn that broke
   * after its whole answer went.
   */
  it('a receipt write that fails on a bubble that went stops the set as reply_set_incomplete', async () => {
    const { h } = bubbleTurn();
    const insert = h.fake.db.insert.bind(h.fake.db);
    let outboundRows = 0;
    h.fake.db.insert = ((table: Parameters<typeof insert>[0]) => {
      if (table === schema.channelMessages) {
        outboundRows += 1;
        if (outboundRows === 2) throw new Error('db: connection reset');
      }
      return insert(table);
    }) as typeof h.fake.db.insert;

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('agent_failed');
    expect(h.transport.bodies()).toEqual(['Swim is Saturday at 10.', 'Bring a towel.']);
    expect(outRows(h.fake).map((row) => row.dedupeKey)).toEqual([`turn-reply:${ID}:0`]);
    expect(h.turns.answered).toEqual([ID]);
    expect(h.turns.failed).toEqual([{ channelMessageId: ID, reason: 'reply_set_incomplete' }]);
    expect(JSON.stringify(h.logs)).toContain(
      '{"outcome":"reply_set_incomplete","bubblesSent":2,"bubbles":3}',
    );
    expect(JSON.stringify(h.logs)).not.toContain('brokeAfterAnswering');
  });

  it('a first bubble that fails is the failure it always was: nothing claimed by it', async () => {
    const { h } = bubbleTurn();
    const send = h.transport.send.bind(h.transport);
    let calls = 0;
    h.transport.send = async (input) => {
      calls += 1;
      if (calls === 1) throw new Error('linq refused');
      return send(input);
    };

    await routeChannelMessage(h.deps, job());

    // The composed apology went in its place, as for any send that failed.
    expect(h.transport.bodies()).toEqual([APOLOGY]);
    expect(h.turns.failed).toEqual([{ channelMessageId: ID, reason: 'apology_sent' }]);
    expect(JSON.stringify(h.logs)).not.toContain('reply_set_incomplete');
  });

  it('skips a bubble already on record under its key and sends the rest', async () => {
    const { h } = bubbleTurn();
    await h.fake.db.insert(schema.channelMessages).values({
      familyId: FAMILY,
      parentUserId: PARENT,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      dedupeKey: `turn-reply:${ID}:0`,
      status: 'sent',
    });

    await routeChannelMessage(h.deps, job());

    expect(h.transport.bodies()).toEqual(['Bring a towel.', 'Want me to add it to your calendar?']);
    expect(outRows(h.fake).map((row) => row.dedupeKey)).toEqual([
      `turn-reply:${ID}:0`,
      `turn-reply:${ID}:1`,
      `turn-reply:${ID}:2`,
    ]);
  });

  it('an iMessage effect rides the first bubble, read against the whole answer', async () => {
    vi.stubEnv('LINQ_EFFECTS_ENABLED', 'true');
    vi.stubEnv('LINQ_API_KEY', 'test-key');
    effectDecide.mockResolvedValue({ effect: { type: 'screen', name: 'confetti' } });
    const posted: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (new URL(url).pathname.endsWith('/messages')) posted.push(String(init?.body));
      return Response.json({ message: { id: 'effect-out' } }, { status: 201 });
    });
    const { h } = bubbleTurn();

    await routeChannelMessage(h.deps, job());

    expect(effectDecide).toHaveBeenCalledTimes(1);
    expect(effectDecide.mock.calls[0]?.[0]).toMatchObject({ reply: THREE });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('Swim is Saturday at 10.');
    expect(posted[0]).not.toContain('Bring a towel.');
    expect(h.transport.sent).toEqual([
      { route: UNTHREADED, body: 'Bring a towel.', sendKey: `turn-reply:${ID}:1` },
      {
        route: UNTHREADED,
        body: 'Want me to add it to your calendar?',
        sendKey: `turn-reply:${ID}:2`,
      },
    ]);
    expect(outRows(h.fake).map((row) => [row.templateKey, row.providerMessageId])).toEqual([
      ['linq:effect', 'effect-out'],
      [null, 'fake-out-1'],
      [null, 'fake-out-2'],
    ]);
  });

  /**
   * The effect bubble is bubble 0, so it carries bubble 0's key: a plain resend of the same
   * bubble (an effect POST that never reached Linq goes plain) is then one send to Linq.
   */
  it('the effect bubble carries the same turn-reply key as bubble 0', async () => {
    vi.stubEnv('LINQ_EFFECTS_ENABLED', 'true');
    vi.stubEnv('LINQ_API_KEY', 'test-key');
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    effectDecide.mockResolvedValue({ effect: { type: 'screen', name: 'confetti' } });
    const keys: unknown[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (new URL(url).pathname.endsWith('/messages')) {
        keys.push(JSON.parse(String(init?.body)).message.idempotency_key);
      }
      return Response.json({ message: { id: 'effect-out' } }, { status: 201 });
    });
    const { h } = bubbleTurn();

    await routeChannelMessage(h.deps, job());

    expect(keys).toEqual([createHash('sha256').update(`turn-reply:${ID}:0`).digest('hex')]);
  });

  /**
   * The model wrote nothing and chose a card. The card rides beside the words, so with no
   * words nothing goes, and the turn ends on a named outcome rather than a crash.
   */
  it('an empty reply with a card sends nothing and names the card it withheld', async () => {
    const cards: unknown[] = [];
    const { h } = bubbleTurn({
      reply: '',
      experienceCard: { url: 'https://pool.example/lanes', title: 'Riverdale pool' },
    });
    h.deps.sendExperienceCard = async (input) => {
      cards.push(input);
      return { status: 'sent' } as never;
    };

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('agent_silent');
    expect(h.transport.sent).toEqual([]);
    expect(cards).toEqual([]);
    expect(h.turns.answered).toEqual([ID]);
    expect(JSON.stringify(h.logs)).toContain('{"outcome":"empty_reply_card_withheld"}');
  });

  it('a sticker the model chose never stands in for an answer of several bubbles', async () => {
    vi.stubEnv('LINQ_API_KEY', 'test-key');
    vi.stubEnv('LINQ_STICKERS_ENABLED', 'true');
    stickerDecide.mockResolvedValue({ sticker: '🙌', sendReply: false });
    const peeled: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      if (new URL(url).pathname.endsWith('/reactions')) peeled.push(url);
      return new Response(null, { status: 204 });
    });
    const { h } = bubbleTurn();

    await routeChannelMessage(h.deps, job());

    expect(stickerDecide).toHaveBeenCalledTimes(1);
    expect(stickerDecide.mock.calls[0]?.[0]).toMatchObject({ reply: THREE });
    expect(peeled).toHaveLength(1);
    expect(h.transport.bodies()).toEqual(THREE.split('\n'));
    stickerDecide.mockReset();
  });

  it('a cut sentence leaves the bubbles around it whole', async () => {
    const { h } = bubbleTurn({
      reply: 'Swim is Saturday at 10.\nThursday swim is booked at 5:15.\nBring a towel.',
    });

    await routeChannelMessage(h.deps, job());

    expect(h.transport.bodies()).toEqual(['Swim is Saturday at 10.', 'Bring a towel.']);
  });

  it('a voice memo the model chose says the whole answer once', async () => {
    const spoken: string[] = [];
    const { h } = bubbleTurn({ reply: THREE, voiceMemo: true });
    h.deps.sendVoiceReply = async (input) => {
      spoken.push(input.text);
      return { sent: 'voice', providerMessageId: 'memo-1' } as never;
    };

    await routeChannelMessage(h.deps, job());

    expect(spoken).toEqual([
      'Swim is Saturday at 10. Bring a towel. Want me to add it to your calendar?',
    ]);
    expect(h.transport.sent).toEqual([]);
    expect(outRows(h.fake).map((row) => [row.dedupeKey, row.providerMessageId])).toEqual([
      [`turn-reply:${ID}:0`, 'memo-1'],
    ]);
  });

  it('the experience card takes its page out of the bubbles and goes once, after them', async () => {
    const cards: string[] = [];
    const { h } = bubbleTurn({
      reply: 'Riverdale pool has lane swim.\nGo early https://pool.example/lanes',
      experienceCard: { url: 'https://pool.example/lanes', title: 'Riverdale pool' },
    });
    h.deps.sendExperienceCard = async (input) => {
      cards.push(`${input.card.url} after ${h.transport.sent.length}`);
      return { status: 'sent' } as never;
    };

    await routeChannelMessage(h.deps, job());

    expect(h.transport.bodies()).toEqual(['Riverdale pool has lane swim.', 'Go early']);
    expect(cards).toEqual(['https://pool.example/lanes after 2']);
  });
});

/**
 * The same set through the real database and the production turn ledger: what a lit turn
 * leaves behind is one row per bubble with its own key, one answered claim, and one
 * thread row per bubble. The held-venue fold reads the real thread, so it runs here too.
 */
describe('several bubbles through the production ledger and database', () => {
  let db: TestDb;
  const IMESSAGE = {
    channel: 'imessage',
    to: PHONE,
    chatId: 'chat-bubbles',
    replyToMessageId: 'in-1',
    service: 'iMessage',
  } satisfies ReplyRoute;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function text(parent: { familyId: string; parentUserId: string }, reply: string) {
    vi.stubEnv('COACH_BUBBLES_ENABLED', 'true');
    const h = harness({
      coach: fakeCoach(reply),
      context: { body: 'what is on saturday', reply: IMESSAGE },
    });
    h.deps.database = db.database;
    h.deps.turns = auditTurnLedger(db.database);
    const clock = new Date();
    h.deps.now = () => clock;
    const [inbound] = await db.database
      .insert(schema.channelMessages)
      .values({
        ...parent,
        channel: 'imessage',
        providerChatId: IMESSAGE.chatId,
        direction: 'in',
        category: 'reply',
        status: 'delivered',
        body: 'what is on saturday',
      })
      .returning({ id: schema.channelMessages.id });
    const inboundId = inbound?.id as string;
    const result = await routeChannelMessage(
      h.deps,
      job({
        family_id: parent.familyId,
        parent_user_id: parent.parentUserId,
        channel_message_id: inboundId,
      }),
    );
    return { result, inboundId, said: h.transport.bodies() };
  }

  it('writes one keyed row and one thread row per bubble, and one answered claim', async () => {
    const parent = await seedFamily(db.database);

    const { result, inboundId, said } = await text(
      parent,
      'Swim is Saturday at 10.\nBring a towel.',
    );

    expect(result.status).toBe('agent_replied');
    expect(said).toEqual(['Swim is Saturday at 10.', 'Bring a towel.']);
    const out = await db.database
      .select({ dedupeKey: schema.channelMessages.dedupeKey })
      .from(schema.channelMessages)
      .where(
        and(
          eq(schema.channelMessages.familyId, parent.familyId),
          eq(schema.channelMessages.direction, 'out'),
        ),
      );
    expect(out.map((row) => row.dedupeKey).sort()).toEqual([
      `turn-reply:${inboundId}:0`,
      `turn-reply:${inboundId}:1`,
    ]);
    const claims = await db.database
      .select({ targetId: schema.auditLog.targetId })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.familyId, parent.familyId),
          eq(schema.auditLog.actionTaken, TURN_ANSWERED_ACTION),
        ),
      );
    expect(claims).toEqual([{ targetId: inboundId }]);
    const thread = await db.database
      .select({ content: schema.messages.content })
      .from(schema.messages)
      .innerJoin(schema.conversations, eq(schema.conversations.id, schema.messages.conversationId))
      .where(
        and(
          eq(schema.conversations.familyId, parent.familyId),
          eq(schema.messages.role, 'assistant'),
        ),
      );
    expect(thread.map((row) => row.content).sort()).toEqual([
      'Bring a towel.',
      'Swim is Saturday at 10.',
    ]);
  });

  it('appends a venue page the answer named to the last bubble, by one read', async () => {
    const parent = await seedFamily(db.database);
    await text(parent, 'Swim is Saturday at 10.\nBring a towel.');
    const [conversation] = await db.database
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(eq(schema.conversations.familyId, parent.familyId));
    await db.database.insert(schema.messages).values({
      conversationId: conversation?.id as string,
      role: 'assistant',
      topic: 'activity_held',
      content: JSON.stringify({
        unsent_activity_options: [
          { name: 'Riverdale Pool', source_url: 'https://www.toronto.ca/riverdale-pool' },
        ],
      }),
    });

    const { said } = await text(parent, 'Riverdale Pool has lane swim.\nWant to go Saturday?');

    expect(said).toEqual([
      'Riverdale Pool has lane swim.',
      'Want to go Saturday?\nhttps://www.toronto.ca/riverdale-pool',
    ]);
  });

  describe('a sign-up offer in the answer', () => {
    const OFFER = 'Want me to sign Ada up for Little Kickers at the open?';

    async function offerTurn(
      onBubble: (index: number, ids: { swim: string; gym: string }) => Promise<void>,
      options: { reply?: string; voiceMemo?: true } = {},
    ) {
      vi.stubEnv('COACH_BUBBLES_ENABLED', 'true');
      const parent = await seedFamily(db.database);
      const childId = await seedChild(db.database, parent.familyId, 'Ada', 40);
      const offer = async (activityKey: string, registrationUrl: string) => {
        const recorded = await recordSignupOffer(db.database, {
          ...parent,
          childId,
          activityKey,
          registrationUrl,
          sessions: [
            {
              id: 'sat-0900',
              label: 'Sat 9:00',
              startsAt: '2027-01-09T14:00:00.000Z',
              endsAt: '2027-01-09T14:45:00.000Z',
              full: false,
              priceCents: 9800,
            },
          ],
          approvedPriceCents: null,
          now: new Date(),
        });
        if (!recorded.ok) throw new Error(recorded.reason);
        return recorded.id;
      };
      const ids = {
        swim: await offer('swim-preschool', 'https://swim.example-rec.test/register'),
        gym: await offer('gym-tots', 'https://gym.example-rec.test/register'),
        kickers: await offer('kickers-sat', 'https://kickers.example-sport.test/register'),
      };
      const coach: ChannelCoachRuntime = {
        async respond() {
          return {
            reply: options.reply ?? `Kickers opens Dec 8 at 7.\n${OFFER}`,
            planOffer: null,
            activityPromise: null,
            spotWatch: null,
            signupOffers: [{ offerId: ids.kickers, text: OFFER }],
            ...(options.voiceMemo ? { voiceMemo: true } : {}),
          };
        },
      };
      const h = harness({ coach, context: { body: 'and kickers?', reply: IMESSAGE } });
      h.deps.database = db.database;
      h.deps.turns = auditTurnLedger(db.database);
      const voiced: string[] = [];
      h.deps.sendVoiceReply = async (input) => {
        voiced.push(input.text);
        return { sent: 'voice_memo', providerMessageId: 'vm-offer' };
      };
      const send = h.transport.send.bind(h.transport);
      h.transport.send = async (input) => {
        await onBubble(h.transport.sent.length, ids);
        return send(input);
      };
      const [inbound] = await db.database
        .insert(schema.channelMessages)
        .values({
          ...parent,
          channel: 'imessage',
          providerChatId: IMESSAGE.chatId,
          direction: 'in',
          category: 'reply',
          status: 'delivered',
          body: 'and kickers?',
        })
        .returning({ id: schema.channelMessages.id });
      const result = await routeChannelMessage(
        h.deps,
        job({
          family_id: parent.familyId,
          parent_user_id: parent.parentUserId,
          channel_message_id: inbound?.id as string,
        }),
      );
      const seq = async (offerId: string) => {
        const [row] = await db.database
          .select({ seq: schema.authorizedSignupOffers.lastAskedSeq })
          .from(schema.authorizedSignupOffers)
          .where(eq(schema.authorizedSignupOffers.id, offerId));
        return row?.seq ?? null;
      };
      return { result, said: h.transport.bodies(), voiced, ids, seq };
    }

    /** Another send about another ask, starting now: it draws the next number. */
    const otherSendStarts = (offerId: string) =>
      db.database.execute(
        sql`update authorized_signup_offers set last_asked_seq = nextval('authorized_signup_ask_seq') where id = ${offerId}`,
      );

    it('ranks it by the start of the bubble that carries its text', async () => {
      const turn = await offerTurn(async (index, ids) => {
        // Swim's send starts while the first bubble is on the wire, Gym's while the
        // bubble carrying the offer is.
        await otherSendStarts(index === 0 ? ids.swim : ids.gym);
      });

      expect(turn.result.status).toBe('agent_replied');
      expect(turn.said).toEqual(['Kickers opens Dec 8 at 7.', OFFER]);
      const swim = (await turn.seq(turn.ids.swim)) as number;
      const kickers = (await turn.seq(turn.ids.kickers)) as number;
      const gym = (await turn.seq(turn.ids.gym)) as number;
      expect(kickers).toBeGreaterThan(swim);
      expect(gym).toBeGreaterThan(kickers);
    });

    it('sends it as its own text, never as a voice memo the model chose', async () => {
      const turn = await offerTurn(async () => {}, { reply: OFFER, voiceMemo: true });
      expect(turn.voiced).toEqual([]);
      expect(turn.said).toEqual([OFFER]);
      expect(await turn.seq(turn.ids.kickers)).not.toBeNull();
    });

    it('sends a set of bubbles that carries it as texts, never as a voice memo the model chose', async () => {
      const turn = await offerTurn(async () => {}, { voiceMemo: true });
      expect(turn.voiced).toEqual([]);
      expect(turn.said).toEqual(['Kickers opens Dec 8 at 7.', OFFER]);
      expect(await turn.seq(turn.ids.kickers)).not.toBeNull();
    });

    it('never offers it to a tapback, an edit, a sticker or an effect', async () => {
      vi.stubEnv('LINQ_API_KEY', 'test-key');
      vi.stubEnv('VERCEL_ENV', 'preview');
      vi.stubEnv('LINQ_EFFECTS_ENABLED', 'true');
      vi.stubEnv('LINQ_STICKERS_ENABLED', 'true');
      vi.stubEnv('LINQ_MESSAGE_EDIT_ENABLED', 'true');
      effectDecide.mockResolvedValue({ effect: { type: 'screen', name: 'confetti' } });
      stickerDecide.mockResolvedValue({ sticker: '🙌', sendReply: false });
      const posted: string[] = [];
      vi.stubGlobal('fetch', async (url: string) => {
        posted.push(new URL(url).pathname);
        return Response.json({ message: { id: 'linq-out' } }, { status: 201 });
      });
      try {
        const turn = await offerTurn(async () => {}, { reply: OFFER });
        expect(effectDecide).not.toHaveBeenCalled();
        expect(stickerDecide).not.toHaveBeenCalled();
        // The typing bubble only: no reaction, no edit, no effect send.
        expect(posted.filter((path) => !path.endsWith('/typing'))).toEqual([]);
        expect(turn.said).toEqual([OFFER]);
        expect(await turn.seq(turn.ids.kickers)).not.toBeNull();
      } finally {
        effectDecide.mockReset();
        stickerDecide.mockReset();
        vi.unstubAllGlobals();
      }
    });

    it('leaves it unstamped when the set stops before the bubble that carries its text', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const turn = await offerTurn(async (index) => {
        if (index === 1) throw new Error('carrier refused');
      });
      expect(turn.said).toEqual(['Kickers opens Dec 8 at 7.']);
      expect(await turn.seq(turn.ids.kickers)).toBeNull();
      vi.restoreAllMocks();
    });
  });
});

/**
 * From the Linq webhook to the send, through the real door, the real inbound row, the real
 * context loader and the real router. Linq relays a green-bubble SMS chat on the iMessage
 * channel, so `channel` on the row says `imessage` either way: the service Linq named is
 * what keeps an SMS parent's answer to one text, and an iMessage parent's in bubbles.
 */
describe('a Linq chat’s service decides bubbles, from the webhook to the send', () => {
  let db: TestDb;
  const LINQ_KEY = Buffer.alloc(32, 9);
  const LINQ_NOW = new Date('2026-11-12T17:00:00.000Z');
  const LINQ_TS = String(Math.floor(LINQ_NOW.getTime() / 1000));
  const REPLY = 'Swim is Saturday at 10.\nBring a towel.';

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(() => {
    vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_WEBHOOK_SECRET', `whsec_${LINQ_KEY.toString('base64')}`);
    vi.stubEnv('COACH_BUBBLES_ENABLED', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** The 2026-02-03 message.received a 1:1 chat on the Hale line posts, signed. */
  function webhook(service: string, messageId: string): Request {
    const body = JSON.stringify({
      api_version: 'v3',
      webhook_version: '2026-02-03',
      event_type: 'message.received',
      event_id: `evt-${messageId}`,
      created_at: LINQ_NOW.toISOString(),
      data: {
        chat: { id: `chat-${messageId}`, is_group: false },
        id: messageId,
        direction: 'inbound',
        sender_handle: { handle: PHONE, is_me: false, service },
        parts: [{ type: 'text', value: 'what is on saturday' }],
        sent_at: LINQ_NOW.toISOString(),
        service,
      },
    });
    const mac = createHmac('sha256', LINQ_KEY)
      .update(`evt-${messageId}.${LINQ_TS}.${body}`)
      .digest('base64');
    return new Request('https://app.villagehale.com/api/channels/linq/inbound?version=2026-02-03', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': `evt-${messageId}`,
        'webhook-timestamp': LINQ_TS,
        'webhook-signature': `v1,${mac}`,
      },
      body,
    });
  }

  /** A parent enrolled on the SMS blind index whose intake is done, as the door expects. */
  async function enrolledParent() {
    await db.exec('truncate table families, users, sms_intake_sessions cascade');
    const parent = await seedFamily(db.database);
    await db.database.insert(schema.parentChannels).values({
      userId: parent.parentUserId,
      familyId: parent.familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(PHONE),
      phoneE164Hash: phoneBlindIndex(PHONE),
      verifiedAt: LINQ_NOW,
    });
    await db.database.insert(schema.smsIntakeSessions).values({
      phoneHash: phoneBlindIndex(PHONE),
      phoneEncrypted: encryptString(PHONE),
      state: 'complete',
      dataEncrypted: encryptString(
        JSON.stringify({ collected: { children: [], postalCode: null }, transcript: [] }),
      ),
      closedAt: LINQ_NOW,
    });
    return parent;
  }

  async function textIn(service: string, messageId: string) {
    const jobs: ChannelMessageReceivedJob[] = [];
    const intake: IntakeDeps = {
      transport: new FakeTransport(),
      threadMessage: async () => 'conv-1',
      extractor: new FakeExtractor([{ children: [], postalCode: null }]),
      intentReader: new FakeIntentReader([
        { intent: 'assent', verbatim: 'yes', interpretation: 'plain yes' },
      ]),
      radar: fakeRadar,
      answerComposer: fakeSilentAnswerComposer,
      openQuestions: fakeNoOpenQuestions,
      identityAsk: new FakeIdentityAsk(),
      limiter: new FakeRateLimiter(() => LINQ_NOW.getTime()),
      now: LINQ_NOW,
    };
    const door = {
      database: db.database,
      intake: () => intake,
      enqueue: async (queued: ChannelMessageReceivedJob) => {
        jobs.push(queued);
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      countOutcome: async () => {},
      now: () => LINQ_NOW,
      markRead: async () => ({ status: 'accepted' as const }),
      sendGroupText: async () => ({ providerMessageId: 'unused' }),
    } as unknown as Parameters<typeof handleLinqInboundRequest>[1];

    const response = await handleLinqInboundRequest(webhook(service, messageId), door);
    expect(await response.json()).toEqual({ outcome: 'handed_off' });
    const queued = jobs[0];
    if (!queued) throw new Error('the door queued no turn');

    const coach = {
      turns: [] as ChannelTurn[],
      async respond(turn: ChannelTurn) {
        coach.turns.push(turn);
        return { reply: REPLY, planOffer: null, activityPromise: null, spotWatch: null };
      },
    };
    const h = harness({ coach });
    h.deps.database = db.database;
    h.deps.loadContext = loadInboundContext;
    h.deps.turns = auditTurnLedger(db.database);
    h.deps.now = () => LINQ_NOW;
    const result = await routeChannelMessage(h.deps, queued);
    const [row] = await db.database
      .select({
        channel: schema.channelMessages.channel,
        providerService: schema.channelMessages.providerService,
      })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.id, queued.channel_message_id));
    return { result, row, coach, sent: h.transport.sent };
  }

  it('an SMS chat Linq relays gets one joined text, never bubbles', async () => {
    await enrolledParent();

    const { result, row, coach, sent } = await textIn('SMS', 'in-sms-1');

    expect(result.status).toBe('agent_replied');
    expect(row).toEqual({ channel: 'imessage', providerService: 'SMS' });
    expect(coach.turns[0]).not.toHaveProperty('replyBubbles');
    expect(sent.map((send) => [send.route.channel, send.body])).toEqual([['imessage', REPLY]]);
  });

  it('positive control: an iMessage chat on the same line gets its bubbles', async () => {
    await enrolledParent();

    const { result, row, coach, sent } = await textIn('iMessage', 'in-imessage-1');

    expect(result.status).toBe('agent_replied');
    expect(row).toEqual({ channel: 'imessage', providerService: 'iMessage' });
    expect(coach.turns[0]?.replyBubbles).toBe(true);
    expect(sent.map((send) => send.body)).toEqual(['Swim is Saturday at 10.', 'Bring a towel.']);
  });
});
