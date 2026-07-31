import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { scopedReply } from '~/lib/channel/caregiver/copy';
import { type FakeDb, makeFakeDb } from '~/lib/channel/intake/fakes';
import { FakeTransport } from '~/lib/channel/intake/transport';
import type { ChannelMessageReceivedJob } from '~/lib/channel/twilio/inbound';
import { channelSmsNoteKey } from '~/lib/coach/note-key';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { ACK_REPLY, FLOOD_REPLY, capabilityReply, failureReply } from './copy';
import { approvalHandler, healthReplyHandler, sequenceReplyHandler } from './handlers';
import { AGENT_TURNS_PER_HOUR } from './flood';
import {
  type AckTimer,
  type ChannelCoachRuntime,
  type ChannelRouterDeps,
  type DeterministicHandler,
  type InboundContext,
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
      return { reply };
    },
  };
  return coach;
}

/** A timer that never fires — the fast-turn case. */
const neverFires = (): AckTimer => ({ elapsed: new Promise<void>(() => {}), cancel: () => {} });

interface Harness {
  deps: ChannelRouterDeps;
  fake: FakeDb;
  transport: FakeTransport;
  logs: unknown[];
}

function harness(
  options: {
    context?: Partial<InboundContext> | null;
    handlers?: DeterministicHandler[];
    coach?: ChannelCoachRuntime;
    limiter?: FakeRateLimiter;
    ackTimer?: () => AckTimer;
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

  return {
    fake,
    transport,
    logs,
    deps: {
      database: fake.db,
      loadContext: async () => context,
      transport,
      handlers: options.handlers ?? [],
      coach: options.coach ?? fakeCoach(),
      limiter: options.limiter ?? new FakeRateLimiter(() => NOW.getTime()),
      ackTimer: options.ackTimer ?? neverFires,
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
    const first = await routeChannelMessage(h.deps, job({ provider_message_id: 'SM1' }));
    const second = await routeChannelMessage(h.deps, job({ provider_message_id: 'SM2' }));

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
      expect((await routeChannelMessage(h.deps, job())).status).toBe('agent_replied');
    }

    const overflow = await routeChannelMessage(h.deps, job());
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
      await routeChannelMessage(h.deps, job());
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
      await routeChannelMessage(h.deps, job());
    }
    const before = messageRows(h.fake).length;

    await routeChannelMessage(h.deps, job());
    expect(messageRows(h.fake).length).toBeGreaterThan(before);
  });
});

// ── slow turns and failures ──────────────────────────────────────────────────

describe('the ack turn', () => {
  /** A deferred coach + an already-elapsed timer is the only deterministic way to
   * describe "the agent is taking too long" without sleeping in a test. */
  function deferredCoach(): ChannelCoachRuntime & { release: (reply: string) => void } {
    let resolve!: (value: { reply: string }) => void;
    const pending = new Promise<{ reply: string }>((r) => {
      resolve = r;
    });
    return {
      respond: () => pending,
      release: (reply: string) => resolve({ reply }),
    };
  }

  it('sends "on it" first, then the real answer', async () => {
    const coach = deferredCoach();
    const h = harness({
      coach,
      ackTimer: () => ({ elapsed: Promise.resolve(), cancel: () => {} }),
    });

    const run = routeChannelMessage(h.deps, job());
    await vi.waitFor(() => expect(h.transport.bodies()).toEqual([ACK_REPLY]));
    coach.release('Saturday is dry — the splash pad is open.');

    expect((await run).status).toBe('agent_replied');
    expect(h.transport.bodies()).toEqual([
      ACK_REPLY,
      'Saturday is dry — the splash pad is open.',
    ]);
  });

  it('cancels the timer when the turn is fast — no stray ack', async () => {
    let cancelled = false;
    const h = harness({
      ackTimer: () => ({ elapsed: new Promise<void>(() => {}), cancel: () => { cancelled = true; } }),
    });

    await routeChannelMessage(h.deps, job());

    expect(cancelled).toBe(true);
    expect(h.transport.bodies()).toEqual(['coach says hi']);
  });
});

describe('failure honesty', () => {
  const throwingCoach: ChannelCoachRuntime = {
    respond: async () => {
      throw new Error('anthropic timeout');
    },
  };

  it('says nothing was changed and points at the app', async () => {
    const h = harness({ coach: throwingCoach });
    const result = await routeChannelMessage(h.deps, job());

    expect(result.status).toBe('agent_failed');
    expect(h.transport.bodies()).toEqual([failureReply()]);
    expect(failureReply()).toMatch(/nothing was changed/i);
  });

  it('never leaves the parent with silence OR a fabricated success', async () => {
    const h = harness({ coach: throwingCoach });
    await routeChannelMessage(h.deps, job());

    const assistantTurns = messageRows(h.fake).filter((r) => r.role === 'assistant');
    expect(assistantTurns).toHaveLength(1);
    expect(assistantTurns[0]?.content).toBe(failureReply());
  });

  it('still sends the honest line after an ack has already gone out', async () => {
    const h = harness({
      coach: throwingCoach,
      ackTimer: () => ({ elapsed: Promise.resolve(), cancel: () => {} }),
    });
    await routeChannelMessage(h.deps, job());

    expect(h.transport.bodies().at(-1)).toBe(failureReply());
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
});

// ── the coach stub ───────────────────────────────────────────────────────────

describe('the C2 seam', () => {
  it('answers with the Conversation Design capability reply until VIL-221 lands', async () => {
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
    const spine = {
      listPending: async () => options.pending ?? [],
      latestUndoable: async () => null,
      approve: async () => true,
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
          programDomainLabel: 'swim lessons',
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

  /** Ordinary conversation is claimed by NO handler's grammar — but M7's open window
   * still owns the single re-ask, so this is the one case where a readable question is
   * answered deterministically. Pinned so the behaviour is visible rather than
   * surprising when C2 lands and takes the branch over. */
  it('spends the one re-ask on an unreadable message inside an open window', async () => {
    const chain = realChain();
    const coach = fakeCoach();
    const h = harness({
      context: { body: 'anything indoors this weekend?' },
      handlers: chain.handlers,
      coach,
    });

    expect((await routeChannelMessage(h.deps, job())).handler).toBe('registration');
    expect(coach.calls).toBe(0);
  });
});
