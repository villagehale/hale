import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  EMERGENCY_TOKENS,
  MENTAL_CRISIS_REPLY,
  SAFETY_REPLY,
  namesAnEmergency,
} from '~/lib/channel/off-domain/copy';
import { ChannelTurnFailed } from './coach-runtime';
import {
  type SmokeAlarmClaim,
  type SmokeAlarmOutcome,
  classifyTurnFailure,
  considerSmokeAlarm,
  modelIsUnreachable,
} from './smoke-alarm';

const FAMILY = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';
const MESSAGE = '33333333-3333-4333-8333-333333333333';

/** An Anthropic APIError of a given status, built the way the SDK builds one. */
function apiError(status: number, message: string): InstanceType<typeof Anthropic.APIError> {
  return new Anthropic.APIError(
    status,
    { type: 'error', error: { type: 'overloaded_error', message } },
    message,
    undefined,
  );
}

/** How the coach actually hands a provider failure to the router: wrapped, with the
 * provider error as `cause` (channel/coach/runtime.ts). Every classification below has
 * to survive that wrapper or the alarm is dead code in production. */
function asCoachSees(cause: unknown): ChannelTurnFailed {
  return new ChannelTurnFailed('channel coach: agent loop failed', {
    cause,
    draftedActionIds: [],
  });
}

// ── the token list ───────────────────────────────────────────────────────────

describe('the emergency tokens', () => {
  it.each([
    ['she is not breathing', true],
    ['he went unconscious', true],
    ['baby is unresponsive', true],
    ['I think she is choking', true],
    ['he had a seizure', true],
    ['should I call 911', true],
    ['NOT BREATHING', true],
    ['Unconscious.', true],
  ])('fires on %j', (text, expected) => {
    expect(namesAnEmergency(text)).toBe(expected);
  });

  it.each([
    'what should we do this weekend',
    'swim class is at 9:11 tomorrow',
    'the invoice came to $911',
    'our unit number is 9110',
    'call me at 647-555-0911',
    'she is breathing fine now',
  ])('stays quiet on %j', (text) => {
    expect(namesAnEmergency(text)).toBe(false);
  });

  /**
   * The two halves of the boundary the brief names. A price and a unit number contain
   * the digits and are not the number; the emergency number is worth the false positive
   * and those are not it.
   */
  it('separates the emergency number from digits that merely contain it', () => {
    expect(namesAnEmergency('call 911 now')).toBe(true);
    expect(namesAnEmergency('911')).toBe(true);
    expect(namesAnEmergency('911.')).toBe(true);
    expect(namesAnEmergency('$911')).toBe(false);
    expect(namesAnEmergency('9110')).toBe(false);
    expect(namesAnEmergency('19110')).toBe(false);
  });

  /** A token must not fire from inside a longer word, but must survive an ordinary
   * inflection — "seizures" is the same emergency as "seizure". */
  it('reads whole words, and their plurals', () => {
    expect(namesAnEmergency('she is having seizures')).toBe(true);
    expect(namesAnEmergency('he is unresponsive')).toBe(true);
    expect(namesAnEmergency('unchoking')).toBe(false);
    expect(namesAnEmergency('preseizure')).toBe(false);
  });

  it('is the short, conservative list the doctrine fixed', () => {
    expect([...EMERGENCY_TOKENS]).toEqual([
      'not breathing',
      'unconscious',
      'unresponsive',
      'choking',
      'seizure',
      '911',
    ]);
  });
});

// ── the outage classifier ────────────────────────────────────────────────────

describe('what counts as the model being unreachable', () => {
  it.each([
    ['a connection error', new Anthropic.APIConnectionError({ message: 'Connection error.' })],
    ['a connection timeout', new Anthropic.APIConnectionTimeoutError({ message: 'timed out' })],
    ['529 overloaded', apiError(529, 'Overloaded')],
    ['500 internal', apiError(500, 'Internal server error')],
    ['503 unavailable', apiError(503, 'Service unavailable')],
  ])('%s is an outage', (_name, err) => {
    expect(modelIsUnreachable(err)).toBe(true);
    expect(modelIsUnreachable(asCoachSees(err))).toBe(true);
  });

  it.each([
    ['a plain bug', new Error('cannot read properties of undefined')],
    ['a validation error', apiError(400, 'invalid request')],
    ['an auth failure', apiError(401, 'invalid x-api-key')],
    ['a rate limit', apiError(429, 'rate limited')],
    ['a missing key', new Error('ANTHROPIC_API_KEY is not set')],
    ['a database failure', new Error('connection terminated unexpectedly')],
    ['nothing at all', undefined],
  ])('%s is NOT an outage', (_name, err) => {
    expect(modelIsUnreachable(err)).toBe(false);
    expect(modelIsUnreachable(asCoachSees(err))).toBe(false);
  });

  /** The turn that ran out of steps. The coach builds this one with NO cause, and it is
   * the failure most likely to be confused for an outage: the model answered, just not
   * usefully. A siren for it would fire on an ordinary bad turn. */
  it('is NOT an outage when the turn simply ran out of steps', () => {
    const noCause = new ChannelTurnFailed('channel coach: agent hit maxSteps without an answer', {
      draftedActionIds: [],
    });
    expect(modelIsUnreachable(noCause)).toBe(false);
  });

  it('finds the provider error however deeply the turn wrapped it', () => {
    const buried = asCoachSees(new Error('tool failed', { cause: apiError(529, 'Overloaded') }));
    expect(modelIsUnreachable(buried)).toBe(true);
  });

  it('terminates on a cause cycle rather than hanging the turn', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(modelIsUnreachable(a)).toBe(false);
  });
});

/**
 * The same reading, widened for the defer arc: the router does not ask "is this an
 * outage" and then guess at the rest — it asks what KIND of failure this is, and gets
 * one of exactly two answers. `defect` is the honest name for everything the positive
 * list does not recognise: our own request shape, a tool that threw, a dead query, a
 * bug. The model API was reachable for all of them, which is what makes composing an
 * apology possible on that branch and pointless on the other.
 */
describe('classifying a failed turn', () => {
  it.each([
    ['a connection error', new Anthropic.APIConnectionError({ message: 'Connection error.' })],
    ['529 overloaded', apiError(529, 'Overloaded')],
    ['502 from a proxy', apiError(502, 'Bad gateway')],
  ])('%s is model_unreachable, through the coach wrapper too', (_name, err) => {
    expect(classifyTurnFailure(err)).toBe('model_unreachable');
    expect(classifyTurnFailure(asCoachSees(err))).toBe('model_unreachable');
  });

  it.each([
    ['a 400 from our own request shape', apiError(400, 'invalid request')],
    ['a 429 burst of our own making', apiError(429, 'rate limited')],
    ['a zod crash', new Error('Invalid input: expected string')],
    ['a dead query', new Error('connection terminated unexpectedly')],
    ['nothing at all', undefined],
  ])('%s is a defect, through the coach wrapper too', (_name, err) => {
    expect(classifyTurnFailure(err)).toBe('defect');
    expect(classifyTurnFailure(asCoachSees(err))).toBe('defect');
  });

  /** One classifier, one home (#427's own instruction). The boolean the alarm reads and
   * the three-way the router branches on must never be able to disagree — so the
   * boolean IS the widened reading, not a second copy of the rules. */
  it('is the same reading modelIsUnreachable answers', () => {
    const cases: unknown[] = [
      new Anthropic.APIConnectionError({ message: 'Connection error.' }),
      apiError(503, 'Service unavailable'),
      apiError(401, 'invalid x-api-key'),
      new Error('ANTHROPIC_API_KEY is not set'),
      asCoachSees(apiError(500, 'Internal server error')),
      undefined,
    ];
    for (const err of cases) {
      expect(modelIsUnreachable(err)).toBe(classifyTurnFailure(err) === 'model_unreachable');
    }
  });
});

// ── the alarm ────────────────────────────────────────────────────────────────

function fakeClaim(fired = new Set<string>()): SmokeAlarmClaim & {
  reads: string[];
  recorded: unknown[];
} {
  const claim = {
    reads: [] as string[],
    recorded: [] as unknown[],
    async alreadyFired({ channelMessageId }: { channelMessageId: string }) {
      claim.reads.push(channelMessageId);
      return fired.has(channelMessageId);
    },
    async recordFired(input: { channelMessageId: string }) {
      claim.recorded.push(input);
      fired.add(input.channelMessageId);
    },
  };
  return claim;
}

function alarm(
  options: {
    err?: unknown;
    body?: string;
    claim?: SmokeAlarmClaim;
    say?: (body: string) => Promise<void>;
  } = {},
): { run: () => Promise<SmokeAlarmOutcome>; sent: string[]; claim: SmokeAlarmClaim } {
  const sent: string[] = [];
  const claim = options.claim ?? fakeClaim();
  return {
    sent,
    claim,
    run: () =>
      considerSmokeAlarm({
        claim,
        err: options.err ?? asCoachSees(apiError(529, 'Overloaded')),
        body: options.body ?? 'she is not breathing what do I do',
        familyId: FAMILY,
        parentUserId: PARENT,
        channelMessageId: MESSAGE,
        say:
          options.say ??
          (async (body: string) => {
            sent.push(body);
          }),
      }),
  };
}

describe('the smoke alarm', () => {
  it('sends the fixed safety line, verbatim, when the model is gone and the text is an emergency', async () => {
    const a = alarm();

    expect(await a.run()).toBe('fired');
    expect(a.sent).toEqual([SAFETY_REPLY]);
    // Strict equality against the one definition, not a substring: the whole point of
    // the line is that it is the reviewed sentence and not a near-miss of it.
    expect(a.sent[0]).toBe(SAFETY_REPLY);
  });

  it('sends the reviewed 988 line on a suicide crisis during an outage', async () => {
    const a = alarm({ body: 'I want to die' });
    expect(await a.run()).toBe('fired');
    expect(a.sent).toEqual([MENTAL_CRISIS_REPLY]);
    expect(a.sent[0]).not.toContain('?');
    expect(a.sent[0]).not.toContain('811');
    expect(a.sent[0]).not.toBe(SAFETY_REPLY);
  });

  /** Both conditions, independently insufficient. Either one alone is an ordinary
   * failed turn and must leave the router's existing honesty line in place. */
  it('stays quiet when the model is reachable, however bad the text is', async () => {
    const a = alarm({ err: new Error('tool blew up'), body: 'she is not breathing' });

    expect(await a.run()).toBe('not_an_outage');
    expect(a.sent).toEqual([]);
  });

  it('stays quiet during an outage when the text names no emergency', async () => {
    const a = alarm({ body: 'anything indoors this weekend?' });

    expect(await a.run()).toBe('no_emergency_token');
    expect(a.sent).toEqual([]);
  });

  it('records the alarm so the same message cannot set it off twice', async () => {
    const claim = fakeClaim();
    const first = alarm({ claim });
    expect(await first.run()).toBe('fired');
    expect(claim.recorded).toEqual([
      { familyId: FAMILY, parentUserId: PARENT, channelMessageId: MESSAGE },
    ]);

    const retry = alarm({ claim });
    expect(await retry.run()).toBe('already_fired');
    expect(retry.sent).toEqual([]);
    expect(claim.recorded).toHaveLength(1);
  });

  /**
   * Ordering, and it is the whole of the dedupe's correctness: the claim is written
   * AFTER the send. A claim written first would mean a send that failed is never
   * retried — the parent gets silence and the ledger says the alarm rang.
   */
  it('does not claim an alarm whose send failed, so the retry can ring it', async () => {
    const claim = fakeClaim();
    const failing = alarm({
      claim,
      say: async () => {
        throw new Error('twilio is down too');
      },
    });

    await expect(failing.run()).rejects.toThrow('twilio is down too');
    expect(claim.recorded).toEqual([]);

    const retry = alarm({ claim });
    expect(await retry.run()).toBe('fired');
    expect(retry.sent).toEqual([SAFETY_REPLY]);
  });

  /** The claim read is a query. It must not be spent on the overwhelmingly common
   * failure — an ordinary broken turn while Anthropic is perfectly healthy. */
  it('does not go to the database unless both conditions already hold', async () => {
    const notAnOutage = alarm({ err: new Error('boom') });
    await notAnOutage.run();
    const noToken = alarm({ body: 'what is on this weekend' });
    await noToken.run();

    expect((notAnOutage.claim as ReturnType<typeof fakeClaim>).reads).toEqual([]);
    expect((noToken.claim as ReturnType<typeof fakeClaim>).reads).toEqual([]);
  });

  it('never reaches a model of its own', async () => {
    // The alarm exists for the minutes when there is no model. Anything it called would
    // be the same call that just failed.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./smoke-alarm.ts', import.meta.url), 'utf8'),
    );
    expect(source).not.toMatch(/messages\.create|runAgent|pickModel|loadCronSkill|forceToolJson/);
  });
});
