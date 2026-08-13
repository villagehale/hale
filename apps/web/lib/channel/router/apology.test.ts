import Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import { smsEncoding } from '~/lib/channel/sms-segments';
import {
  MAX_APOLOGY_CHARS,
  MAX_COMPOSE_ATTEMPTS,
  apologyUserMessage,
  createTurnApology,
  refusals,
} from './apology';

const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

/**
 * The gates, and the request shape the eval replicates. The composer's own control flow
 * (three attempts, then out) is driven through a stub client in the second half — hard
 * rule #8 forbids mocking the LLM to judge what it WROTE, which is what the cached eval
 * does with the real skill; these tests judge only what the code does with an answer it
 * has already been handed.
 */

describe('what may not be sent as an apology', () => {
  it('passes the shape the skill asks for', () => {
    expect(refusals('That one broke on my end - nothing changed on your side.')).toEqual([]);
    expect(refusals("Sorry, I couldn't get that done and nothing was changed.")).toEqual([]);
  });

  it.each([
    ['nothing at all', '', 'empty'],
    [
      'two sentences',
      'That broke on my end. Nothing was changed.',
      'not_one_sentence',
    ],
    [
      'a question',
      'That one broke on my end - want to try again?',
      'carries_question',
    ],
    ['a typographic dash', 'That one broke on my end — nothing changed.', 'not_gsm7'],
    [
      'a link',
      'That one broke on my end, see https://villagehale.com for your week.',
      'carries_link',
    ],
    ['an invented number', 'That one broke on my end, try again in 5 minutes.', 'invented_number'],
  ])('refuses %s', (_name, body, reason) => {
    expect(refusals(body)).toContain(reason);
  });

  it('refuses a body over one segment', () => {
    const long = `${'that one broke on my end and nothing at all was changed, '.repeat(4)}truly`;
    expect(long.length).toBeGreaterThan(MAX_APOLOGY_CHARS);
    expect(refusals(long)).toContain('over_char_cap');
  });

  /** A trailing terminator is the sentence's own; an INTERNAL one is a second sentence.
   * The distinction is the whole gate — "Sorry. My fault." must fail and
   * "Sorry, my fault." must pass. */
  it('counts sentences by internal terminators, not by the final one', () => {
    expect(refusals('That one broke on my end.')).toEqual([]);
    expect(refusals('That one broke on my end')).toEqual([]);
    expect(refusals('Sorry. My fault, nothing changed.')).toContain('not_one_sentence');
    expect(refusals('Sorry! Nothing changed.')).toContain('not_one_sentence');
  });

  it('names every problem at once so one recompose can fix them all', () => {
    expect(refusals('Broke. Retry in 5? See www.villagehale.com')).toEqual(
      expect.arrayContaining([
        'not_one_sentence',
        'carries_question',
        'carries_link',
        'invented_number',
      ]),
    );
  });

  it('keeps the sendable shape it demands — one GSM-7 segment', () => {
    const body = 'That one broke on my end - nothing changed on your side.';
    expect(smsEncoding(body)).toBe('gsm7');
    expect(body.length).toBeLessThanOrEqual(MAX_APOLOGY_CHARS);
  });
});

describe('the request the model gets', () => {
  /** Rule #1 at its cheapest: there is nothing in the payload to leak. The parent's
   * words never reach this stage, so a composer bug cannot repeat them back. */
  it('carries the situation and nothing else', () => {
    expect(JSON.parse(apologyUserMessage())).toEqual({
      situation: 'turn_failed_nothing_changed',
    });
  });

  it('hands back every refused attempt with its reasons', () => {
    const payload = JSON.parse(
      apologyUserMessage([{ apology: 'Broke. Retry?', problems: ['not_one_sentence'] }]),
    );
    expect(payload.rejected).toEqual([
      { apology: 'Broke. Retry?', problems: ['not_one_sentence'] },
    ]);
  });
});

// ── the composer's control flow ──────────────────────────────────────────────

interface Captured {
  system?: string;
  messages?: Array<{ role: string; content: string }>;
}

/** A client that answers with each body in turn, recording what it was asked each time. */
function clientSaying(bodies: string[], seen: Captured[] = []): () => AgentClient {
  let call = 0;
  return () =>
    ({
      messages: {
        async create(request: Captured) {
          seen.push({ system: request.system, messages: request.messages });
          const apology = bodies[Math.min(call, bodies.length - 1)];
          call += 1;
          return {
            content: [{ type: 'tool_use', name: 'apology', input: { apology } }],
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        },
      },
    }) as unknown as AgentClient;
}

function throwingClient(err: unknown): () => AgentClient {
  return () =>
    ({
      messages: {
        create: async () => {
          throw err;
        },
      },
    }) as unknown as AgentClient;
}

describe('composing the apology', () => {
  it('sends back the first body that clears the gates', async () => {
    const seen: Captured[] = [];
    const outcome = await createTurnApology(
      clientSaying(['That one broke on my end - nothing changed on your side.'], seen),
    ).compose();

    expect(outcome).toEqual({
      status: 'composed',
      reply: 'That one broke on my end - nothing changed on your side.',
    });
    expect(seen).toHaveLength(1);
  });

  it('recomposes a refused body, telling the model exactly what was wrong', async () => {
    quiet();
    const seen: Captured[] = [];
    const outcome = await createTurnApology(
      clientSaying(
        ['Broke. Try again in 5?', 'That one broke on my end - nothing changed.'],
        seen,
      ),
    ).compose();

    expect(outcome).toEqual({
      status: 'composed',
      reply: 'That one broke on my end - nothing changed.',
    });
    expect(seen).toHaveLength(2);
    const second = JSON.parse(seen[1]?.messages?.[0]?.content ?? '{}');
    expect(second.rejected).toEqual([
      {
        apology: 'Broke. Try again in 5?',
        problems: expect.arrayContaining([
          'not_one_sentence',
          'carries_question',
          'invented_number',
        ]),
      },
    ]);
  });

  it('gives up after a bounded number of attempts rather than looping', async () => {
    quiet();
    const seen: Captured[] = [];
    const outcome = await createTurnApology(clientSaying(['Broke. Retry?'], seen)).compose();

    expect(outcome).toEqual({ status: 'unavailable', reason: 'gate_exhausted' });
    expect(seen).toHaveLength(MAX_COMPOSE_ATTEMPTS);
  });

  /**
   * The reclassification the whole arc turns on: the model went down BETWEEN the coach
   * failing on a bug and the apology being written. There is no one to compose with, so
   * this is not a defect any more — it is an outage, and the router must defer the turn
   * rather than send nothing and call it done.
   */
  it('reports an unreachable model as its own outcome, not as a failure to compose', async () => {
    quiet();
    const outcome = await createTurnApology(
      throwingClient(new Anthropic.APIConnectionError({ message: 'Connection error.' })),
    ).compose();

    expect(outcome).toEqual({ status: 'unreachable' });
  });

  it('separates a defect in the apology request from an outage', async () => {
    quiet();
    const outcome = await createTurnApology(
      throwingClient(
        new Anthropic.APIError(400, { type: 'error' }, 'invalid request', undefined),
      ),
    ).compose();

    expect(outcome).toEqual({ status: 'unavailable', reason: 'model_failed' });
  });

  it('names a missing client rather than throwing out of the catch', async () => {
    quiet();
    const outcome = await createTurnApology(() => {
      throw new Error('ANTHROPIC_API_KEY is not set');
    }).compose();

    expect(outcome).toEqual({ status: 'unavailable', reason: 'client_unavailable' });
  });
});
