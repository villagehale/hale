import type { Database } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import type { GeneralAnswerFallback, GeneralAnswerOutcome } from './answer';
import { ANSWER_UNAVAILABLE_REPLY, PROVIDER_ACCESS_REPLY, SAFETY_REPLY } from './copy';
import {
  type OffDomainPorts,
  type UnmetSignalOutcome,
  offDomainLane,
  recordUnmetIntent,
} from './lane';
import type { LaneReading, LaneScreenFallback } from './screen';

/**
 * VIL-273 / boundary v3 — the lane's decisions, with no model and no database.
 *
 * The screen's QUALITY is not asserted here and cannot be: a faked classifier can only
 * ever confirm that our own fixture came back (rule #8). What it decides is measured in
 * apps/worker/evals/run-inbound-lane-eval.mjs, and what the general answer says is
 * measured in run-general-answer-eval.mjs, both against real cached Claude. What is
 * asserted here is everything AROUND them — which of the three terminals a lane reaches,
 * what the lane is allowed to look up before sending it, that a composed answer never
 * costs the founder their demand signal, and that a failed compose still leaves the
 * parent with a reply.
 */

const FAMILY = '11111111-1111-4111-8111-111111111111';
const MESSAGE = '33333333-3333-4333-8333-333333333333';
const ANSWER = "Messi, for me - the closest thing to a complete player I've watched.";

function reading(overrides: Partial<LaneReading> = {}): LaneReading {
  return { lane: 'off_domain_general', category: 'weather', fallback: null, ...overrides };
}

interface Recorded {
  lane: string;
  category: string;
  channelMessageId: string;
}

interface Harness extends OffDomainPorts {
  composeCalls: number;
  recorded: Recorded[];
}

function ports(
  overrides: {
    read?: LaneReading;
    signal?: UnmetSignalOutcome;
    answer?: GeneralAnswerOutcome;
  } = {},
): Harness {
  const read = overrides.read ?? reading();
  const signal = overrides.signal ?? 'recorded';
  const answer = overrides.answer ?? ({ status: 'composed', reply: ANSWER } as const);
  const harness: Harness = {
    composeCalls: 0,
    recorded: [],
    screen: { read: async () => read },
    answer: {
      compose: async () => {
        harness.composeCalls += 1;
        return answer;
      },
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

  /**
   * BOUNDARY V3, the whole point of it. A question about the world is ANSWERED — the
   * charm deflect that used to stand here read as a product that could not rather than
   * one that chose not to.
   */
  it('answers an off-domain ask with the composed answer, not the deflect', async () => {
    const p = ports();

    const verdict = await consider(p);

    expect(verdict).toMatchObject({
      status: 'deflected',
      reply: ANSWER,
      replySource: 'composed',
    });
    expect(p.composeCalls).toBe(1);
  });

  /**
   * The fallback, and the promise under it (rule #11): a parent always gets SOMETHING.
   * Each way the composer can fail is carried out by name rather than folded into one
   * "it didn't work", because a missing key and a provider outage need different humans.
   */
  it.each([
    'client_unavailable',
    'skill_unavailable',
    'model_failed',
    'unsendable',
  ] as GeneralAnswerFallback[])('falls back to the fixed line when the answer %s', async (reason) => {
    const p = ports({ answer: { status: 'unavailable', reason } });

    const verdict = await consider(p);

    expect(verdict).toMatchObject({
      status: 'deflected',
      reply: ANSWER_UNAVAILABLE_REPLY,
      replySource: reason,
    });
  });

  /** The two doors are FIXED copy, and the way to keep them that way is for the composer
   * never to be woken for them — not for a prompt to be asked nicely to decline. */
  it.each(['safety_critical', 'provider_access'] as const)(
    'never asks the model to compose a %s answer',
    async (lane) => {
      const p = ports({ read: reading({ lane, category: 'emergency' }) });

      await consider(p);

      expect(p.composeCalls).toBe(0);
    },
  );

  /**
   * Skill audit P0 #4. The line that used to stand here appended "2 things are waiting
   * on your OK in the app" to every deflection — an app-point on the one surface that
   * must never need one. Neither terminal may reach for it, and the lane no longer has
   * a reader that could.
   */
  it.each([
    ['composed', { status: 'composed', reply: ANSWER } as const],
    ['fallback', { status: 'unavailable', reason: 'model_failed' } as const],
  ])('never points the %s reply at the app', async (_name, answer) => {
    const verdict = await consider(ports({ answer }));

    if (verdict.status !== 'deflected') throw new Error('x');
    expect(verdict.reply).not.toMatch(/\bthe app\b/i);
    expect(verdict.reply).not.toMatch(/waiting on your OK/i);
  });
});

describe('in-domain is the fall-through', () => {
  it('hands the turn on without composing, recording, or querying anything', async () => {
    const p = ports({ read: { lane: 'in_domain', category: null, fallback: null } });

    const verdict = await consider(p);

    expect(verdict).toEqual({ status: 'in_domain', fallback: null });
    expect(p.composeCalls).toBe(0);
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

  it('records every terminal, whichever lane it was', async () => {
    for (const lane of ['off_domain_general', 'safety_critical', 'provider_access'] as const) {
      const p = ports({ read: reading({ lane, category: 'other' }) });
      await consider(p);
      expect(p.recorded).toHaveLength(1);
    }
  });

  /**
   * THE SIGNAL SURVIVES THE FLIP. An answered general question is still a countable
   * thing a parent asked Hale for — the bucket now reads "questions parents bring us"
   * rather than "things we turned down", and the founder's weekly digest is built on
   * these two columns (loop/health-digest.ts). Composing an answer must not be what
   * quietly empties it.
   */
  it('still records the demand signal when the answer was composed', async () => {
    const p = ports({ read: reading({ lane: 'off_domain_general', category: 'general-knowledge' }) });

    const verdict = await consider(p);

    expect(verdict).toMatchObject({ replySource: 'composed', signal: 'recorded' });
    expect(p.recorded).toEqual([
      { lane: 'off_domain_general', category: 'general-knowledge', channelMessageId: MESSAGE },
    ]);
  });

  /**
   * A telemetry row is not worth a parent's answer. The write is best-effort, and its
   * failure comes back NAMED so the founder's weekly count can be read as short by one
   * rather than silently wrong (rule #11).
   */
  it('still answers when the signal could not be written, and says so', async () => {
    const p = ports({ signal: 'not_recorded' });

    const verdict = await consider(p);

    expect(verdict).toMatchObject({ status: 'deflected', signal: 'not_recorded' });
    if (verdict.status !== 'deflected') throw new Error('x');
    expect(verdict.reply).toBe(ANSWER);
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
