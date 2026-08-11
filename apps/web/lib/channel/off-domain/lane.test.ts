import type { Database } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { PROVIDER_ACCESS_REPLY, SAFETY_REPLY, offDomainReply } from './copy';
import {
  type OffDomainPorts,
  type UnmetSignalOutcome,
  offDomainLane,
  recordUnmetIntent,
} from './lane';
import type { LaneReading, LaneScreenFallback } from './screen';

/**
 * VIL-273 — the lane's decisions, with no model and no database.
 *
 * The screen's QUALITY is not asserted here and cannot be: a faked classifier can only
 * ever confirm that our own fixture came back (rule #8). What it decides is measured in
 * apps/worker/evals/run-inbound-lane-eval.mjs against real cached Claude. What is
 * asserted here is everything AROUND it — which line each lane sends, what the lane is
 * allowed to look up before sending it, and that a failed demand-signal write costs a
 * count rather than a parent's answer.
 */

const FAMILY = '11111111-1111-4111-8111-111111111111';
const MESSAGE = '33333333-3333-4333-8333-333333333333';

function reading(overrides: Partial<LaneReading> = {}): LaneReading {
  return { lane: 'off_domain_general', category: 'weather', fallback: null, ...overrides };
}

interface Recorded {
  lane: string;
  category: string;
  channelMessageId: string;
}

interface Harness extends OffDomainPorts {
  pendingCalls: number;
  recorded: Recorded[];
}

function ports(
  overrides: { read?: LaneReading; pending?: number; signal?: UnmetSignalOutcome } = {},
): Harness {
  const read = overrides.read ?? reading();
  const pending = overrides.pending ?? 0;
  const signal = overrides.signal ?? 'recorded';
  const harness: Harness = {
    pendingCalls: 0,
    recorded: [],
    screen: { read: async () => read },
    pendingApprovals: async () => {
      harness.pendingCalls += 1;
      return pending;
    },
    recordUnmetIntent: async (input) => {
      harness.recorded.push({
        lane: input.lane,
        category: input.category,
        channelMessageId: input.channelMessageId,
      });
      return signal;
    },
  };
  return harness;
}

const consider = (p: OffDomainPorts) =>
  offDomainLane(p).consider({ familyId: FAMILY, channelMessageId: MESSAGE, text: 'anything' });

describe('what each lane says', () => {
  it('answers a safety ask with the fixed line, exactly', async () => {
    const p = ports({ read: reading({ lane: 'safety_critical', category: 'medical-symptom' }) });

    const verdict = await consider(p);

    expect(verdict).toMatchObject({ status: 'deflected', reply: SAFETY_REPLY });
    expect(SAFETY_REPLY).toContain('811');
    expect(SAFETY_REPLY).toContain('911');
  });

  it('answers a provider ask with the Ontario workflow, and invents nothing', async () => {
    const p = ports({ read: reading({ lane: 'provider_access', category: 'doctor-access' }) });

    const verdict = await consider(p);

    expect(verdict).toMatchObject({ status: 'deflected', reply: PROVIDER_ACCESS_REPLY });
    expect(PROVIDER_ACCESS_REPLY).toContain('Health Care Connect');
    // No clinic names and no links: a wrong one sends a family across the city, and a
    // mistyped URL in a text cannot be corrected.
    expect(PROVIDER_ACCESS_REPLY).not.toMatch(/https?:|\.ca\b|\.com\b/);
  });

  it('answers an off-domain ask with the charm deflect', async () => {
    const p = ports({ pending: 0 });

    const verdict = await consider(p);

    expect(verdict).toMatchObject({
      status: 'deflected',
      reply: offDomainReply({ pendingApprovals: 0 }),
    });
  });

  it('adds the pending count when the family has one, and only then', async () => {
    const withWork = await consider(ports({ pending: 2 }));
    const without = await consider(ports({ pending: 0 }));

    expect(withWork).toMatchObject({ reply: offDomainReply({ pendingApprovals: 2 }) });
    expect(without).toMatchObject({ reply: offDomainReply({ pendingApprovals: 0 }) });
    if (withWork.status !== 'deflected' || without.status !== 'deflected') throw new Error('x');
    expect(withWork.reply.length).toBeGreaterThan(without.reply.length);
  });

  /**
   * The structural half of the rule. "and 2 things are waiting on your OK" appended to
   * an answer about a child's head injury is the worst sentence Hale could send, and the
   * way to make it impossible is for the fact never to be fetched — not for a template
   * to decline to print it.
   */
  it.each(['safety_critical', 'provider_access'] as const)(
    'never even reads the approvals queue for a %s ask',
    async (lane) => {
      const p = ports({ read: reading({ lane, category: 'emergency' }) });

      await consider(p);

      expect(p.pendingCalls).toBe(0);
    },
  );

  it('reads the approvals queue exactly once for a charm deflect', async () => {
    const p = ports();
    await consider(p);
    expect(p.pendingCalls).toBe(1);
  });
});

describe('in-domain is the fall-through', () => {
  it('hands the turn on without composing, recording, or querying anything', async () => {
    const p = ports({ read: { lane: 'in_domain', category: null, fallback: null } });

    const verdict = await consider(p);

    expect(verdict).toEqual({ status: 'in_domain', fallback: null });
    expect(p.pendingCalls).toBe(0);
    expect(p.recorded).toEqual([]);
  });

  /** Rule #11: a screen that could not run says WHY, and the reason survives the call
   * rather than being flattened into "nothing to see here". */
  it.each([
    'client_unavailable',
    'skill_unavailable',
    'model_failed',
    'unreadable',
  ] as LaneScreenFallback[])('carries the %s fallback out', async (fallback) => {
    const p = ports({ read: { lane: 'in_domain', category: null, fallback } });

    expect(await consider(p)).toEqual({ status: 'in_domain', fallback });
  });
});

describe('the demand signal', () => {
  it('records the lane and the bucket against the inbound row', async () => {
    const p = ports({ read: reading({ lane: 'provider_access', category: 'specialist-access' }) });

    await consider(p);

    expect(p.recorded).toEqual([
      { lane: 'provider_access', category: 'specialist-access', channelMessageId: MESSAGE },
    ]);
  });

  it('records every deflect, whichever lane it was', async () => {
    for (const lane of ['off_domain_general', 'safety_critical', 'provider_access'] as const) {
      const p = ports({ read: reading({ lane, category: 'other' }) });
      await consider(p);
      expect(p.recorded).toHaveLength(1);
    }
  });

  /**
   * A telemetry row is not worth a parent's answer. The write is best-effort, and its
   * failure comes back NAMED so the founder's weekly count can be read as short by one
   * rather than silently wrong (rule #11).
   */
  it('still deflects when the signal could not be written, and says so', async () => {
    const p = ports({ signal: 'not_recorded' });

    const verdict = await consider(p);

    expect(verdict).toMatchObject({ status: 'deflected', signal: 'not_recorded' });
    if (verdict.status !== 'deflected') throw new Error('x');
    expect(verdict.reply).toBe(offDomainReply({ pendingApprovals: 0 }));
  });
});

/**
 * The write itself, against a stub that can answer three ways. What is under test is the
 * OUTCOME MAPPING — drizzle's where-clause is drizzle's business — because that mapping
 * is the whole of rule #11 here: two of the three answers must be `not_recorded` and
 * neither may throw.
 */
describe('recordUnmetIntent', () => {
  function stub(result: { rows?: unknown[]; throws?: Error }) {
    const captured: { set?: Record<string, unknown> } = {};
    const database = {
      update: () => ({
        set: (values: Record<string, unknown>) => {
          captured.set = values;
          return {
            where: () => ({
              returning: async () => {
                if (result.throws) throw result.throws;
                return result.rows ?? [];
              },
            }),
          };
        },
      }),
    } as unknown as Database;
    return { database, captured };
  }

  const input = {
    channelMessageId: MESSAGE,
    familyId: FAMILY,
    lane: 'off_domain_general' as const,
    category: 'weather' as const,
  };

  it('stamps both columns together and reports the write', async () => {
    const { database, captured } = stub({ rows: [{ id: MESSAGE }] });

    expect(await recordUnmetIntent(database)(input)).toBe('recorded');
    expect(captured.set).toEqual({ unmetLane: 'off_domain_general', unmetCategory: 'weather' });
  });

  it('names a stamp that matched no row instead of claiming success', async () => {
    const { database } = stub({ rows: [] });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await recordUnmetIntent(database)(input)).toBe('not_recorded');
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('never lets a broken write escape as an exception', async () => {
    const { database } = stub({ throws: new Error('deadlock detected') });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await recordUnmetIntent(database)(input)).toBe('not_recorded');
    // Named, not swallowed: the failure class and the lane, and nothing else.
    expect(log.mock.calls[0]?.[0]).toEqual({ err: 'deadlock detected', lane: 'off_domain_general' });
    log.mockRestore();
  });
});
