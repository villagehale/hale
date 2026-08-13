import type { AgentClient } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_COMPOSE_ATTEMPTS,
  createFollowupVoice,
  followupVoiceUserMessage,
  refusals,
} from './voice';

/**
 * The composer's MECHANICS. Not its judgement.
 *
 * Whether "How was Swim class? No pressure to reply." is a good text is decided by a real
 * model and measured in apps/worker/evals/run-followup-voice-eval.mjs against real cached
 * Claude (rule #8). What is proven here is what the eval cannot reach: that a refused body
 * is composed again with the refusal handed back, that every way this stage runs out comes
 * back NAMED as a deferral rather than as a canned message (founder doctrine: no preset
 * bodies), and that the model is handed the activity's name and NOTHING about the family.
 */

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
          const ask = bodies[Math.min(call, bodies.length - 1)];
          call += 1;
          return {
            content: [{ type: 'tool_use', name: 'ask', input: { ask } }],
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        },
      },
    }) as unknown as AgentClient;
}

const throwingClient = (): AgentClient => {
  throw new Error('ANTHROPIC_API_KEY is not set');
};

const outageClient = (): AgentClient =>
  ({
    messages: {
      async create() {
        throw new Error('upstream 529');
      },
    },
  }) as unknown as AgentClient;

const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

const ACTIVITY = { kind: 'activity', activity: 'Swim class' } as const;
const INTRO = { kind: 'intro' } as const;
const GOOD_ACTIVITY = 'How was Swim class? No pressure to reply.';

describe('refusals', () => {
  it('passes a one-question, in-budget, subject-naming ask', () => {
    expect(refusals(GOOD_ACTIVITY, ACTIVITY)).toEqual([]);
  });

  it.each([
    ['empty', '', ['empty']],
    ['over the one-segment budget', `${'How was Swim class, and '.repeat(9)}?`, ['over_char_cap']],
    ['a curly apostrophe', 'How was Swim class? Hope it’s been a good week.', ['not_gsm7']],
    ['a link', 'How was Swim class? More at www.example.com', ['carries_link']],
    ['a second question', 'How was Swim class? Going again?', ['not_one_question']],
    ['no question at all', 'Hope Swim class went well.', ['not_one_question']],
    ['a different activity', 'How was gymnastics? No pressure.', ['subject_missing']],
    ['a time it was never given', 'How was Swim class at 4pm? No pressure.', ['invented_number']],
  ])('refuses %s', (_label, body, expected) => {
    expect(refusals(body, ACTIVITY)).toEqual(expected);
  });

  /** Every problem at once, so a single recompose can fix all of them rather than
   * trading one round trip per gate. */
  it('names every problem a body has, not just the first', () => {
    expect(refusals('Was Swim class fun? Going back at 4? See www.x.com', ACTIVITY)).toEqual([
      'carries_link',
      'not_one_question',
      'invented_number',
    ]);
  });

  /** A number inside the title is Hale's own fact, handed to the model, not invented. */
  it('allows a number that is part of the activity name', () => {
    expect(refusals('How was Gym 2 Grow? No pressure.', { kind: 'activity', activity: 'Gym 2 Grow' })).toEqual([]);
  });

  /** The intro ask has no subject to name, so it has no subject gate — but every digit
   * in it is invented, because it was handed no facts at all. */
  it('holds the intro ask to no-subject, no-numbers', () => {
    expect(refusals('Did you end up connecting with the other family? No pressure.', INTRO)).toEqual([]);
    expect(refusals('Did the 2 of you connect?', INTRO)).toEqual(['invented_number']);
  });
});

describe('followupVoiceUserMessage', () => {
  /** The privacy property this stage is BUILT on, asserted structurally: the model gets
   * the kind and the calendar title, and there is no field here a family fact could
   * ride in on. The eval replicates this shape, so a change re-keys its cache. */
  it('hands the model the kind and the title and nothing else', () => {
    expect(followupVoiceUserMessage(ACTIVITY)).toBe('{"kind":"activity","activity":"Swim class"}');
    expect(followupVoiceUserMessage(INTRO)).toBe('{"kind":"intro"}');
  });

  it('carries the refused attempts and their named problems on a recompose', () => {
    expect(
      followupVoiceUserMessage(INTRO, [{ ask: 'Did you connect? Was it good?', problems: ['not_one_question'] }]),
    ).toBe('{"kind":"intro","rejected":[{"ask":"Did you connect? Was it good?","problems":["not_one_question"]}]}');
  });
});

describe('createFollowupVoice', () => {
  it('composes the ask the model wrote', async () => {
    const voice = createFollowupVoice(clientSaying([GOOD_ACTIVITY]));

    expect(await voice.compose(ACTIVITY)).toEqual({ status: 'composed', body: GOOD_ACTIVITY });
  });

  it('sends the model the activity title and nothing about the family', async () => {
    const seen: Captured[] = [];
    await createFollowupVoice(clientSaying([GOOD_ACTIVITY], seen)).compose(ACTIVITY);

    expect(seen[0]?.messages?.[0]?.content).toBe('{"kind":"activity","activity":"Swim class"}');
  });

  /**
   * The recompose loop, and the half that matters: the second request must CARRY the
   * refusal. A retry that just asks again is a retry that gets the same answer.
   */
  it('recomposes with the refusal fed back, and sends the fixed ask', async () => {
    const seen: Captured[] = [];
    const voice = createFollowupVoice(
      clientSaying(['How was Swim class? Going again?', GOOD_ACTIVITY], seen),
    );
    const restore = quiet();

    const outcome = await voice.compose(ACTIVITY);
    restore.mockRestore();

    expect(outcome).toEqual({ status: 'composed', body: GOOD_ACTIVITY });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.messages?.[0]?.content).toBe(
      '{"kind":"activity","activity":"Swim class","rejected":[{"ask":"How was Swim class? Going again?","problems":["not_one_question"]}]}',
    );
  });

  /**
   * Exhaustion DEFERS. There is no fixed line to fall back on by design, so the sweep
   * leaves its claim unspent and asks again on the next tick — a late real ask beats an
   * on-time canned one.
   */
  it('defers after every attempt is refused, without composing a body', async () => {
    const voice = createFollowupVoice(clientSaying(['How was Swim class? Going again?']));
    const restore = quiet();

    const outcome = await voice.compose(ACTIVITY);
    restore.mockRestore();

    expect(outcome).toEqual({ status: 'deferred', reason: 'gate_exhausted' });
  });

  it('gives the model exactly MAX_COMPOSE_ATTEMPTS tries before deferring', async () => {
    const seen: Captured[] = [];
    const voice = createFollowupVoice(clientSaying(['nope'], seen));
    const restore = quiet();

    await voice.compose(INTRO);
    restore.mockRestore();

    expect(seen).toHaveLength(MAX_COMPOSE_ATTEMPTS);
  });

  it.each([
    ['no client', throwingClient, 'client_unavailable'],
    ['an upstream outage', outageClient, 'model_failed'],
  ])('defers by name on %s', async (_label, client, reason) => {
    const restore = quiet();

    const outcome = await createFollowupVoice(client).compose(INTRO);
    restore.mockRestore();

    expect(outcome).toEqual({ status: 'deferred', reason });
  });

  /** An outage gets ONE attempt, not three: it will not have cleared inside one cron
   * request, and the sweep's next tick is the cheaper place to wait. */
  it('does not retry an outage', async () => {
    let calls = 0;
    const counting = (): AgentClient =>
      ({
        messages: {
          async create() {
            calls += 1;
            throw new Error('upstream 529');
          },
        },
      }) as unknown as AgentClient;
    const restore = quiet();

    await createFollowupVoice(counting).compose(INTRO);
    restore.mockRestore();

    expect(calls).toBe(1);
  });
});
