import type { Database } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import type { GeneralAnswerFallback, GeneralAnswerOutcome } from './answer';
import {
  ANSWER_UNAVAILABLE_REPLY,
  ANSWER_UNAVAILABLE_REPLY_BY_LANGUAGE,
  DIRECT_ACCESS_EYE_REPLY,
  PROVIDER_ACCESS_REPLY,
  PROVIDER_ACCESS_REPLY_BY_LANGUAGE,
  SAFETY_REPLY,
  SAFETY_REPLY_BY_LANGUAGE,
} from './copy';
import {
  type OffDomainPorts,
  type ReplySource,
  type UnmetSignalOutcome,
  offDomainLane,
  recordUnmetIntent,
} from './lane';
import type { MedicalReply } from './medical';
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
const MEDICAL_ANSWER =
  'A fever like this is often viral at this age; fluids and rest usually help. Call 811 any time, or go to the ER / call 911 if she has trouble breathing.';

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
  medicalCalls: number;
  medicalSeen: string[];
  recorded: Recorded[];
}

function ports(
  overrides: {
    read?: LaneReading;
    signal?: UnmetSignalOutcome;
    answer?: GeneralAnswerOutcome;
    medical?: MedicalReply;
  } = {},
): Harness {
  const read = overrides.read ?? reading();
  const signal = overrides.signal ?? 'recorded';
  const answer = overrides.answer ?? ({ status: 'composed', reply: ANSWER } as const);
  const medical =
    overrides.medical ?? ({ reply: MEDICAL_ANSWER, replySource: 'web_grounded' } as const);
  const harness: Harness = {
    composeCalls: 0,
    medicalCalls: 0,
    medicalSeen: [],
    recorded: [],
    screen: { read: async () => read },
    answer: {
      compose: async () => {
        harness.composeCalls += 1;
        return answer;
      },
    },
    medical: {
      answer: async (text) => {
        harness.medicalCalls += 1;
        harness.medicalSeen.push(text);
        return medical;
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

const consider = (p: OffDomainPorts, text = 'anything') =>
  offDomainLane(p).consider({ familyId: FAMILY, channelMessageId: MESSAGE, text });

describe('what each lane says', () => {
  /** Every safety_critical category EXCEPT medical-symptom still gets the fixed line,
   * with no model between a parent and what they are told about a crisis. medical-symptom
   * moved to its own answered lane (see the dedicated describe below). */
  it.each(['mental-health', 'child-safety', 'emergency'] as const)(
    'answers a %s safety ask with the fixed line, exactly',
    async (category) => {
      const p = ports({ read: reading({ lane: 'safety_critical', category }) });

      const verdict = await consider(p);

      expect(verdict).toMatchObject({
        status: 'deflected',
        reply: SAFETY_REPLY,
        replySource: 'fixed',
      });
      expect(SAFETY_REPLY).toContain('811');
      expect(SAFETY_REPLY).toContain('911');
      // The medical composer is only for medical-symptom — never woken for these.
      expect(p.medicalCalls).toBe(0);
    },
  );

  /**
   * Skill audit P0 #3. The general terminal has a fourth outcome: the composer wrote a
   * referral. The words are not its to carry — `{ status: 'safety' }` has no reply
   * field — so what goes out is the same reviewed sentence a screened symptom gets, and
   * `replySource` says `fixed` rather than crediting the model for words it did not send.
   */
  it('sends the fixed line, exactly, when the composer reached for a referral', async () => {
    const p = ports({ answer: { status: 'safety' } });

    const verdict = await consider(p);

    expect(verdict).toMatchObject({
      status: 'deflected',
      reply: SAFETY_REPLY,
      replySource: 'fixed',
    });
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
   * The founder's live-gate defect. "Find me an optometrist" was answered with Health
   * Care Connect, which is Ontario's registry for a family doctor, a nurse practitioner
   * or a primary care team and has nothing to do with optometry — so the parent was sent
   * to wait on a list that would never call, for a booking they could have made that
   * afternoon. Both halves are asserted: the right answer goes out, and the wrong one
   * cannot.
   */
  it('answers an eye-care ask with the direct-access truth, not the doctor registry', async () => {
    const p = ports({
      read: reading({ lane: 'provider_access', category: 'specialist-access' }),
    });

    const verdict = await consider(p, 'find me an optometrist');

    expect(verdict).toMatchObject({ status: 'deflected', reply: DIRECT_ACCESS_EYE_REPLY });
    expect(DIRECT_ACCESS_EYE_REPLY).not.toContain('Health Care Connect');
    expect(DIRECT_ACCESS_EYE_REPLY).not.toContain('811');
  });

  it('leaves the family-doctor ask on the registry line it was always right for', async () => {
    const p = ports({ read: reading({ lane: 'provider_access', category: 'doctor-access' }) });

    const verdict = await consider(p, 'we just moved and need a pediatrician');

    expect(verdict).toMatchObject({ status: 'deflected', reply: PROVIDER_ACCESS_REPLY });
  });

  /**
   * An ophthalmologist is a physician specialist and IS the referral case, so the
   * direct-access line would be the same class of wrong answer in the other direction.
   */
  it('does not claim direct access for an ophthalmologist', async () => {
    const p = ports({
      read: reading({ lane: 'provider_access', category: 'specialist-access' }),
    });

    const verdict = await consider(p, 'we need an ophthalmologist for her');

    expect(verdict).toMatchObject({ reply: PROVIDER_ACCESS_REPLY });
  });

  /**
   * The four claims the reply stands on, each traceable to a source in copy.ts's
   * docblock, plus the one link it is allowed. "Per calendar year" is a different and
   * wrong promise from "every 12 months", so the wording is pinned.
   */
  it('carries the verified eye-care facts and exactly one address', () => {
    expect(DIRECT_ACCESS_EYE_REPLY).toContain('no referral needed');
    expect(DIRECT_ACCESS_EYE_REPLY).toContain('every 12 months');
    expect(DIRECT_ACCESS_EYE_REPLY).toContain('19 and under');
    expect(DIRECT_ACCESS_EYE_REPLY).toContain('FindAnEyeDoctor.ca');
    expect(DIRECT_ACCESS_EYE_REPLY).not.toContain('calendar year');
    // One address, and no scheme — a bare domain is shorter and every phone links it.
    expect(DIRECT_ACCESS_EYE_REPLY.match(/[\w-]+\.(?:ca|com|org)\b/g)).toEqual([
      'FindAnEyeDoctor.ca',
    ]);
    expect(DIRECT_ACCESS_EYE_REPLY).not.toMatch(/https?:/);
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

/**
 * The medical-symptom answer lane (founder-locked 2026-08-17). A symptom is no longer
 * deflected to a fixed line — Hale ANSWERS it with a web-grounded composer. The composer's
 * QUALITY (does it triage correctly) is measured against real cached Claude in
 * apps/worker/evals/run-medical-symptom-eval.mjs; its mechanics and fail-closed behaviour
 * in medical.test.ts. What is asserted HERE is the routing: only medical-symptom reaches
 * the composer, its answer is sent, and it is never stamped as an unmet intent.
 */
describe('the medical-symptom answer lane', () => {
  it('answers a medical-symptom text with the web-grounded composer, not the fixed line', async () => {
    const p = ports({ read: reading({ lane: 'safety_critical', category: 'medical-symptom' }) });

    const verdict = await consider(p, 'she has had a fever for three days');

    expect(verdict).toMatchObject({
      status: 'deflected',
      lane: 'safety_critical',
      category: 'medical-symptom',
      reply: MEDICAL_ANSWER,
      replySource: 'web_grounded' satisfies ReplySource,
      // The value the router stamps on the reply it sends. Carried EXPLICITLY rather than
      // re-derived from replySource downstream: 'fixed' is also what the two fixed doors
      // and the general answer's safety fallback return, so a reader narrowing on it
      // would count a provider-access door as a medical fallback.
      medicalSource: 'web_grounded',
    });
    expect(p.medicalCalls).toBe(1);
    // The general-answer composer is a different lane and is never woken here.
    expect(p.composeCalls).toBe(0);
  });

  it('hands the composer the raw text — de-identification is the composer job, not the lane', async () => {
    const p = ports({ read: reading({ lane: 'safety_critical', category: 'medical-symptom' }) });

    await consider(p, 'my son Milo, exactly 2, has a fever of 39');

    expect(p.medicalSeen).toEqual(['my son Milo, exactly 2, has a fever of 39']);
  });

  /**
   * Decision #4: a medical-symptom Hale ANSWERS is no longer an unmet intent, so the
   * demand-signal write is skipped entirely and the outcome says `not_applicable` rather
   * than faking a failed write (rule #11). This is the one path that answers off-domain
   * WITHOUT a demand-signal row — deliberately, and named.
   */
  it('does NOT stamp an answered medical-symptom as an unmet intent', async () => {
    const p = ports({ read: reading({ lane: 'safety_critical', category: 'medical-symptom' }) });

    const verdict = await consider(p);

    expect(p.recorded).toEqual([]);
    expect(verdict).toMatchObject({ signal: 'not_applicable' });
  });

  /** The composer's own last-resort fixed line rides out unchanged, and STILL is not
   * recorded — the medical lane never writes a demand-signal row, answered or not. */
  it('carries the composer last-resort fixed line out, still unrecorded', async () => {
    const p = ports({
      read: reading({ lane: 'safety_critical', category: 'medical-symptom' }),
      medical: { reply: SAFETY_REPLY, replySource: 'fixed' },
    });

    const verdict = await consider(p);

    expect(verdict).toMatchObject({
      status: 'deflected',
      reply: SAFETY_REPLY,
      replySource: 'fixed',
      medicalSource: 'fixed',
      signal: 'not_applicable',
    });
    expect(p.recorded).toEqual([]);
  });
});

/**
 * The stamp the router writes on the reply. It exists so the founder scorecard's SAFETY
 * row can count how often a parent with a hurt child got the fixed 811/911 line instead
 * of an answer — a number that used to live only in memory. Every other branch must leave
 * it null, or a door Hale chose deliberately would be counted as a medical failure.
 */
describe('the medical stamp is set on the medical branch and nowhere else', () => {
  it.each([
    ['a safety-critical text that is not a symptom', 'safety_critical', 'child-safety'],
    ['the provider-access door', 'provider_access', 'doctor-access'],
    ['a composed general answer', 'off_domain_general', 'weather'],
  ] as const)('leaves it null for %s', async (_label, lane, category) => {
    const p = ports({ read: reading({ lane, category }) });

    const verdict = await consider(p, 'is it going to rain tomorrow');

    expect(verdict).toMatchObject({ status: 'deflected', medicalSource: null });
  });

  /** The positive control for the three above: the same field, through the same call,
   * is non-null exactly once. */
  it('sets it for the medical-symptom branch', async () => {
    const p = ports({ read: reading({ lane: 'safety_critical', category: 'medical-symptom' }) });

    const verdict = await consider(p);

    expect(verdict).toMatchObject({ medicalSource: 'web_grounded' });
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

/**
 * THE FRENCH DOORS.
 *
 * The choice of door is unchanged — that is the screen's job and it is measured by the
 * eval. What is asserted here is that once a door is chosen, the words that go through it
 * are in the language the parent used, and that the English twin still goes out for
 * everybody else. Both halves, every time: a lane that always answered in French would
 * pass the first assertion of each of these on its own.
 */
describe('the lane answers in the language the question was asked in', () => {
  it('sends the safety line in French to a French safety ask', async () => {
    const p = ports({ read: reading({ lane: 'safety_critical', category: 'child-safety' }) });

    const fr = await consider(p, "Ma fille a avale quelque chose, je fais quoi");
    expect(fr).toMatchObject({ reply: SAFETY_REPLY_BY_LANGUAGE.fr, replySource: 'fixed' });

    const en = await consider(p, 'my daughter swallowed something, what do I do');
    expect(en).toMatchObject({ reply: SAFETY_REPLY, replySource: 'fixed' });
  });

  it('sends the registry line in French to a French provider ask', async () => {
    const p = ports({ read: reading({ lane: 'provider_access', category: 'doctor-access' }) });

    const fr = await consider(p, 'Je cherche un medecin de famille pour mes enfants');
    expect(fr).toMatchObject({ reply: PROVIDER_ACCESS_REPLY_BY_LANGUAGE.fr });

    const en = await consider(p, 'we just moved and need a family doctor');
    expect(en).toMatchObject({ reply: PROVIDER_ACCESS_REPLY });
  });

  it('says in French that the answer could not be written', async () => {
    const p = ports({ answer: { status: 'unavailable', reason: 'model_failed' } });

    const fr = await consider(p, "Quel temps fait-il demain? J'aimerais aller au parc");
    expect(fr).toMatchObject({
      reply: ANSWER_UNAVAILABLE_REPLY_BY_LANGUAGE.fr,
      replySource: 'model_failed',
    });

    const en = await consider(p, "what's the weather tomorrow");
    expect(en).toMatchObject({ reply: ANSWER_UNAVAILABLE_REPLY, replySource: 'model_failed' });
  });

  /**
   * The composer reaching for a referral on a French question. The words are the reviewed
   * French ones, and `fixed` still says the model did not write them.
   */
  it('substitutes the French safety line when the composer reached for a referral', async () => {
    const p = ports({ answer: { status: 'safety' } });

    const fr = await consider(p, "Mon fils est tombe de la table, il pleure beaucoup");
    expect(fr).toMatchObject({ reply: SAFETY_REPLY_BY_LANGUAGE.fr, replySource: 'fixed' });
  });
});
