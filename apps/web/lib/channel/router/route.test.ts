import Anthropic from '@anthropic-ai/sdk';
import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { scopedReply } from '~/lib/channel/caregiver/copy';
import { SAFETY_REPLY } from '~/lib/channel/off-domain/copy';
import { type FakeDb, makeFakeDb } from '~/lib/channel/intake/fakes';
import { FakeTransport } from '~/lib/channel/intake/transport';
import type { OffDomainLane, OffDomainVerdict } from '~/lib/channel/off-domain/lane';
import type { ChannelMessageReceivedJob } from '~/lib/channel/twilio/inbound';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import { channelSmsNoteKey } from '~/lib/coach/note-key';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import type { RateLimiter } from '~/lib/rate-limit/limiter';
import type { ApologyOutcome, TurnApology } from './apology';
import { type ChannelTurnResult, ChannelTurnFailed } from './coach-runtime';
import type { SmokeAlarmClaim } from './smoke-alarm';
import type { OpenQuestion, OpenQuestionReader } from './open-questions';
import type { VillageIntroReplyDeps } from '~/lib/village/intros/reply';
import {
  DISCOVERABILITY_ALREADY_ON,
  DISCOVERABILITY_OFF,
  DISCOVERABILITY_ON,
} from '~/lib/village/intros/copy';
import { villageIntroHandler } from './handlers';
import type { ReplyReading, ReplyResolver } from './resolve';
import type { InboundTurnLedger, TurnStage } from './turn-ledger';
import { FLOOD_REPLY, capabilityReply, failureReply, partialFailureReply } from './copy';
import { approvalHandler, healthReplyHandler, sequenceReplyHandler } from './handlers';
import { AGENT_TURNS_PER_HOUR } from './flood';
import {
  type ChannelCoachRuntime,
  type ChannelRouterDeps,
  type DeterministicHandler,
  type InboundContext,
  TurnDeferred,
  routeChannelMessage,
} from './route';

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
const PARENT = '22222222-2222-4222-8222-222222222222';
const PHONE = '+14165551234';
const NOW = new Date('2026-07-30T12:00:00.000Z');

function job(overrides: Partial<ChannelMessageReceivedJob> = {}): ChannelMessageReceivedJob {
  return {
    family_id: FAMILY,
    parent_user_id: PARENT,
    channel_message_id: '33333333-3333-4333-8333-333333333333',
    provider_message_id: 'SM1',
    received_at: NOW.toISOString(),
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
function claimingHandler(name: string, reply: string | null = `${name} reply`): DeterministicHandler & {
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

function fakeCoach(reply = 'coach says hi'): ChannelCoachRuntime & { calls: number } {
  const coach = {
    calls: 0,
    async respond() {
      coach.calls += 1;
      return { reply, planOffer: null };
    },
  };
  return coach;
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
    async consider(input: { familyId: string; channelMessageId: string; text: string }) {
      lane.calls += 1;
      lane.seen.push({ text: input.text, channelMessageId: input.channelMessageId });
      return verdict;
    },
  };
  return lane;
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
  reads: string[];
} {
  const ledger = {
    answered: [] as string[],
    deferred: [] as string[],
    reads: [] as string[],
    async stageOf({ channelMessageId }: { channelMessageId: string }): Promise<TurnStage> {
      ledger.reads.push(channelMessageId);
      if (ledger.answered.includes(channelMessageId)) return 'answered';
      if (ledger.deferred.includes(channelMessageId)) return 'deferred';
      return 'fresh';
    },
    async recordAnswered(input: { channelMessageId: string }) {
      ledger.answered.push(input.channelMessageId);
    },
    async recordDeferred(input: { channelMessageId: string }) {
      ledger.deferred.push(input.channelMessageId);
    },
  };
  return ledger;
}

/** A limiter that only counts. The real fake keeps its window state private, and what
 * the re-drive tests need to see is how many times the budget was CHARGED. */
function countingLimiter(): RateLimiter & { checks: number } {
  const limiter = {
    checks: 0,
    async check() {
      limiter.checks += 1;
      return { allowed: true, retryAfterSec: 3600 };
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

interface Harness {
  deps: ChannelRouterDeps;
  fake: FakeDb;
  transport: FakeTransport;
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
    recordPlanOffer?: ChannelRouterDeps['recordPlanOffer'];
  } = {},
): Harness {
  const fake = makeFakeDb();
  const transport = new FakeTransport();
  const logs: unknown[] = [];
  const context: InboundContext | null =
    options.context === null
      ? null
      : {
          body: 'anything indoors this weekend?',
          role: 'primary_parent',
          primaryParentName: 'Sam',
          phoneE164: PHONE,
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
      loadContext: async () => context,
      transport,
      handlers: options.handlers ?? [],
      coach: options.coach ?? fakeCoach(),
      recordPlanOffer: options.recordPlanOffer ?? (async () => ({ status: 'recorded' })),
      questions: options.questions ?? fakeQuestions([]),
      replyResolver: options.replyResolver ?? fakeResolver({ status: 'unresolved', reason: 'no_target' }),
      offDomain: options.offDomain ?? fakeLane(IN_DOMAIN),
      smokeAlarm: options.smokeAlarm ?? fakeSmokeAlarmClaim(),
      turns,
      apology: options.apology ?? fakeApology(),
      limiter: options.limiter ?? new FakeRateLimiter(() => NOW.getTime()),
      now: () => NOW,
      log: {
        info: (...args: unknown[]) => logs.push(args),
        error: (...args: unknown[]) => logs.push(args),
      } as unknown as Pick<Console, 'info' | 'error'>,
    },
  };
}

const conversationRows = (fake: FakeDb) => fake.rows(schema.conversations);
const messageRows = (fake: FakeDb) => fake.rows(schema.messages);
const auditRows = (fake: FakeDb) => fake.rows(schema.auditLog);
const ledgerRows = (fake: FakeDb) => fake.rows(schema.channelMessages);

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
describe('the off-domain lane', () => {
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
  };

  /** The lane's other answer: a symptom, answered rather than deflected. */
  const medicalVerdict = (medicalSource: 'web_grounded' | 'fixed'): OffDomainVerdict => ({
    status: 'deflected',
    lane: 'safety_critical',
    category: 'medical-symptom',
    reply: medicalSource === 'fixed' ? SAFETY_REPLY : 'Fevers at this age are usually viral.',
    replySource: medicalSource,
    medicalSource,
    signal: 'not_applicable',
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
    expect(h.transport.bodies().at(-1)).toBe(FLOOD_REPLY);
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
          reply: "Most 2-year-olds wake once or twice. Want the full plan? Reply YES and I'll send it.",
          planOffer: {
            topic: 'sleep',
            childId: null,
            sentence: "Want the full plan? Reply YES and I'll send it.",
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
          sentence: "Want the full plan? Reply YES and I'll send it.",
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
      release: (reply: string) => resolve({ reply, planOffer: null }),
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

    expect(h.transport.bodies()).not.toContain(failureReply());
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
     * The one templated line left on this path, and deliberately: it is a RECEIPT for
     * rows that exist, not an apology. It carries a count and the YES/NO grammar that
     * resolves against those rows, which is the same reason approvedReceipt and
     * whichOneReply are templates the coach never touches — a model that miscounts here
     * points a parent's "yes" at the wrong action.
     */
    it('names the drafts that are waiting instead of claiming nothing changed', async () => {
      const apology = fakeApology();
      const h = harness({ coach: draftingThenFailingCoach(2), apology });

      const result = await routeChannelMessage(h.deps, job());

      expect(result.status).toBe('agent_failed');
      expect(h.transport.bodies()).toEqual([partialFailureReply(2)]);
      expect(apology.calls).toBe(0);
      expect(partialFailureReply(2)).toMatch(/2 changes/);
      expect(partialFailureReply(2)).not.toMatch(/nothing was changed/i);
      expect(partialFailureReply(1)).toMatch(/1 change\b/);
    });

    /** The longest line the router sends. A typographic dash in it would flip the
     * message to UCS-2 (70 chars a segment) and cost three segments instead of one —
     * the same rule the coach skill states, and the reason this copy is plain ASCII. */
    it('costs one GSM-7 segment', () => {
      expect(smsEncoding(partialFailureReply(2))).toBe('gsm7');
      expect(smsSegments(partialFailureReply(2))).toBe(1);
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
   * The parent's words go into the thread ONCE, however many times the outage hands the
   * turn back. Nine copies of the same question is a transcript that lies to the coach
   * that reads it on the attempt that finally works.
   */
  it('does not thread the parent\'s message again on a re-drive', async () => {
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
      coach: { respond: () => new Promise<ChannelTurnResult>((_, r) => { reject = r; }) },
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

  it('sends the fixed safety line, verbatim, instead of the honesty template', async () => {
    const h = harness({ context: { body: EMERGENCY }, coach: outageCoach() });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('smoke_alarm_fired');
    expect(h.transport.bodies()).toEqual([SAFETY_REPLY]);
    expect(h.transport.bodies()[0]).toBe(SAFETY_REPLY);
    expect(h.transport.bodies()).not.toContain(failureReply());
  });

  /** It is a reply like any other: ledgered, audited (rule #6), and in the thread the
   * parent can read back. A siren that skipped the books would be the one message Hale
   * sent that nothing recorded. */
  it('ledgers, audits and threads it like every other reply', async () => {
    const h = harness({ context: { body: EMERGENCY }, coach: outageCoach() });

    await routeChannelMessage(h.deps, job());

    const out = ledgerRows(h.fake).filter((r) => r.direction === 'out');
    expect(out).toHaveLength(1);
    expect(auditRows(h.fake).map((r) => r.actionTaken)).toContain('sms_reply_sent');
    const assistant = messageRows(h.fake).filter((r) => r.role === 'assistant');
    expect(assistant.map((r) => r.content)).toEqual([SAFETY_REPLY]);
  });

  it('records the alarm against the inbound message so a queue retry cannot re-ring it', async () => {
    const claim = fakeSmokeAlarmClaim();
    const h = harness({ context: { body: EMERGENCY }, coach: outageCoach(), smokeAlarm: claim });

    const first = await routeChannelMessage(h.deps, job());
    expect(first.status).toBe('smoke_alarm_fired');
    expect(claim.fired).toEqual([job().channel_message_id]);

    // The SAME message, re-driven: at-least-once delivery means the drain can hand this
    // job back after a mid-turn crash (lib/cron/drain.ts), and the defer arc means it
    // does so routinely. The alarm's own claim is now the SECOND line of defence — the
    // turn ledger stops the re-drive before the coach is ever woken, because the safety
    // line was this text's answer.
    const retry = await routeChannelMessage(h.deps, job());
    expect(retry.status).toBe('already_answered');
    expect(h.transport.bodies()).toEqual([SAFETY_REPLY]);
    expect(claim.fired).toHaveLength(1);
  });

  /** A different text during the same outage is a different emergency. The claim is
   * per inbound message, not per family. */
  it('still rings for the parent\'s next text', async () => {
    const claim = fakeSmokeAlarmClaim();
    const h = harness({ context: { body: EMERGENCY }, coach: outageCoach(), smokeAlarm: claim });

    await routeChannelMessage(h.deps, job());
    const second = await routeChannelMessage(
      h.deps,
      job({ channel_message_id: '44444444-4444-4444-8444-444444444444' }),
    );

    expect(second.status).toBe('smoke_alarm_fired');
    expect(h.transport.bodies()).toEqual([SAFETY_REPLY, SAFETY_REPLY]);
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
    expect(h.transport.bodies()).not.toContain(SAFETY_REPLY);
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
        reply: SAFETY_REPLY,
        replySource: 'fixed',
        medicalSource: null,
        signal: 'recorded',
      }),
      coach: outageCoach(),
      smokeAlarm: claim,
    });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('deflected');
    expect(claim.reads).toEqual([]);
    expect(h.transport.bodies()).toEqual([SAFETY_REPLY]);
  });

  it('names the outcome on the failure log without carrying the body (rule #1, #11)', async () => {
    const h = harness({ context: { body: EMERGENCY }, coach: outageCoach() });

    await routeChannelMessage(h.deps, job());

    const dump = JSON.stringify(h.logs);
    expect(dump).toContain('smoke_alarm_fired');
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
    const h = harness({ context: { phoneE164: null }, coach });

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
      coach: { respond: async () => { throw new Error('boom'); } },
    });

    await routeChannelMessage(h.deps, job());

    expect(JSON.stringify(h.logs)).not.toContain(secret);
  });

  /** The apology composer is BLIND (apology.ts): it never receives the parent's words,
   * so no bug in it can put them back on the wire. Asserted through the router because
   * this is the seam where the words are in scope and could be passed by mistake. */
  it('never hands the parent\'s words to the apology composer', async () => {
    const secret = 'Mia has a therapy appointment on Thursday';
    const seen: unknown[] = [];
    const h = harness({
      context: { body: secret },
      coach: { respond: async () => { throw new Error('boom'); } },
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

    expect(h.transport.bodies()).toEqual([capabilityReply()]);
    expect(capabilityReply()).toMatch(/past me for now/);
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
      loadLastCheckpointRef: async () => `dental_school_screening:${CHILD}:1`,
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
    };
    return {
      recorded,
      approved,
      // The production order (wiring.defaultHandlers): narrow claimers, then the broad one.
      handlers: [
        approvalHandler(spine as never),
        healthReplyHandler(health as never),
        sequenceReplyHandler(sequence as never),
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
    // The parent is told the clock started — M7's copy, not the stub's boundary line.
    expect(h.transport.bodies()).toHaveLength(1);
    expect(h.transport.bodies()[0]).not.toBe(capabilityReply());
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

  it('gives a bare "yes" to the drafted action ahead of everything else', async () => {
    const chain = realChain({ pending: [{ actionId: 'a-1', actionType: 'calendar_add' }] });
    const coach = fakeCoach();
    const h = harness({ context: { body: 'yes' }, handlers: chain.handlers, coach });

    expect((await routeChannelMessage(h.deps, job())).handler).toBe('approval');
    expect(coach.calls).toBe(0);
  });

  /** VIL-260 · WS4 — the words a parent actually uses now reach the same place "yes"
   * does, through the real chain rather than only through the grammar unit. */
  for (const body of ['sounds good', 'do it', '👍']) {
    it(`approves the drafted action from ${JSON.stringify(body)}`, async () => {
      const chain = realChain({ pending: [{ actionId: 'a-1', actionType: 'calendar_add' }] });
      const coach = fakeCoach();
      const h = harness({ context: { body }, handlers: chain.handlers, coach });

      expect((await routeChannelMessage(h.deps, job())).handler).toBe('approval');
      expect(chain.approved).toEqual(['a-1']);
      expect(coach.calls).toBe(0);
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
    };
  }

  function introQuestion(): OpenQuestion {
    return {
      id: 'proposal-1',
      kind: 'intro_proposal',
      description: 'Whether to meet one nearby Hale family',
      subject: 'meeting the family nearby',
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
    // A free, exact read always wins. No keyword was removed, only stopped being printed.
    expect(questions.calls).toBe(0);
    expect(resolver.calls).toBe(0);
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
    // TWO passes: the free one, then the resolved one. The body is untouched on both, so
    // whatever the owning module records as evidence is the sentence the parent sent.
    expect(owner.seen).toEqual([
      { body: 'yeah go ahead with the swim move', resolved: null },
      {
        body: 'yeah go ahead with the swim move',
        resolved: {
          kind: 'approval',
          questionId: ACTION,
          polarity: 'yes',
          // Carried down to the consent ledger, not just used for the grade check.
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

    expect(otherCalls).toBe(1);
  });

  it('asks which one - in a sentence, never a menu - when the answer names nothing', async () => {
    const h = harness({
      context: { body: 'sounds good' },
      questions: fakeQuestions([approvalQuestion(), introQuestion()]),
      replyResolver: fakeResolver({ status: 'unresolved', reason: 'ambiguous' }),
    });

    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('clarified');
    expect(h.transport.bodies()).toEqual([
      'Which one - reschedule on your calendar or meeting the family nearby?',
    ]);
    // No ordinal, no numbered list, and nothing the parent has to type back verbatim.
    expect(h.transport.bodies()[0]).not.toMatch(/\bYES\b|\b1\./);
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
  };

  /** The real lane, over spies. `standing` is what the ledger already holds. */
  function introChain(standing: 'unanswered' | 'granted') {
    const written: boolean[] = [];
    const deps: VillageIntroReplyDeps = {
      recordDiscoverability: async (_db, input) => {
        written.push(input.granted);
      },
      discoverabilityStanding: async () => standing,
      answerableProposal: async () => null,
      recordDecision: async () => {},
      cancelOpenProposals: async () => {},
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
    expect(h.transport.bodies()).toEqual([DISCOVERABILITY_ON]);
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
    expect(h.transport.bodies()).toEqual([DISCOVERABILITY_ALREADY_ON]);
    // Not the full acknowledgement a second time.
    expect(h.transport.bodies()[0]).not.toBe(DISCOVERABILITY_ON);
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
    expect(h.transport.bodies()).toEqual([DISCOVERABILITY_OFF]);
  });
});
