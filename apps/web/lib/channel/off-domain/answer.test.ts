import type { AgentClient } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import { MAX_ANSWER_CHARS, createGeneralAnswer, generalAnswerUserMessage } from './answer';

/**
 * Boundary v3 — the general answer's MECHANICS. Not its judgement.
 *
 * Whether "who is the GOAT" gets a good answer is decided by a real model and measured
 * in apps/worker/evals/run-general-answer-eval.mjs against real cached Claude (rule #8).
 * What is proven here is what the eval cannot reach: that every way this stage breaks
 * comes back NAMED so the lane can fall back to the fixed line (rule #11), that nothing
 * unsendable ever leaves it, and that the model is handed the parent's question and
 * NOTHING about their family.
 */

interface Captured {
  system?: string;
  messages?: Array<{ role: string; content: string }>;
}

/** A client whose one tool call returns `input`, recording what it was asked. */
function clientReturning(input: unknown, seen: Captured = {}): () => AgentClient {
  return () =>
    ({
      messages: {
        async create(request: Captured) {
          seen.system = request.system;
          seen.messages = request.messages;
          return {
            content: [{ type: 'tool_use', name: 'answer', input }],
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

const ASK = 'whos the goat in football';

describe('generalAnswerUserMessage', () => {
  /** The same shape the screen uses, and the same reason: the model gets the question
   * and nothing else (rule #1). The eval replicates this, so a change re-keys the cache. */
  it('hands the model the question and nothing else', () => {
    expect(generalAnswerUserMessage(ASK)).toBe('{"text":"whos the goat in football"}');
  });
});

describe('createGeneralAnswer', () => {
  it('composes the answer the model wrote', async () => {
    const answer = createGeneralAnswer(
      clientReturning({ answer: 'Messi, for me - the closest thing to a complete player.' }),
    );

    expect(await answer.compose(ASK)).toEqual({
      status: 'composed',
      reply: 'Messi, for me - the closest thing to a complete player.',
    });
  });

  /**
   * The privacy property this stage is BUILT on, asserted structurally rather than
   * promised in a comment: a trivia answer needs nothing about the children, so nothing
   * about them is loaded and nothing about them can be sent. Anything a future edit
   * splices into the request has to break this test first.
   */
  it('sends the skill and the question, and nothing about the family', async () => {
    const seen: Captured = {};
    await createGeneralAnswer(clientReturning({ answer: 'Lima.' }, seen)).compose(
      'whats the capital of peru',
    );

    expect(seen.messages).toEqual([
      { role: 'user', content: '{"text":"whats the capital of peru"}' },
    ]);
    expect(seen.system).toContain('One good answer, then stop');
    // The skill body is the whole system prompt: no context block spliced after it.
    expect(seen.system?.endsWith('Say the useful thing first and stop.')).toBe(true);
  });

  it('names a missing client rather than throwing', async () => {
    const log = quiet();
    expect(await createGeneralAnswer(throwingClient).compose(ASK)).toEqual({
      status: 'unavailable',
      reason: 'client_unavailable',
    });
    log.mockRestore();
  });

  it('names a provider outage rather than throwing', async () => {
    const log = quiet();
    expect(await createGeneralAnswer(outageClient).compose(ASK)).toEqual({
      status: 'unavailable',
      reason: 'model_failed',
    });
    log.mockRestore();
  });

  it('names a response with no tool call rather than throwing', async () => {
    const log = quiet();
    const noToolCall = () =>
      ({
        messages: {
          async create() {
            return { content: [{ type: 'text', text: 'sure' }], usage: {} };
          },
        },
      }) as unknown as AgentClient;

    expect(await createGeneralAnswer(noToolCall).compose(ASK)).toEqual({
      status: 'unavailable',
      reason: 'model_failed',
    });
    log.mockRestore();
  });

  /**
   * The typographic characters a model reaches for cost more than twice what their ASCII
   * twins do (sms-segments.ts). They are transliterated rather than refused: a curly
   * apostrophe is invisible to the reader and must not be what costs a parent their
   * answer. Markdown goes the same way — a phone prints the asterisks.
   */
  it('flattens curly punctuation and markdown instead of refusing them', async () => {
    const result = await createGeneralAnswer(
      clientReturning({ answer: '**Messi** — he’s the one I’d pick.' }),
    ).compose(ASK);

    expect(result).toEqual({ status: 'composed', reply: "Messi - he's the one I'd pick." });
  });

  /**
   * The cap is a REFUSAL, not a trim. A trivia answer cut mid-clause reads as broken
   * software, and unlike the coach's reply there is no app link to hand the rest to —
   * so the lane's fixed line is the better outcome, and it is a named one.
   */
  it('refuses an answer past the character cap instead of truncating it', async () => {
    const log = quiet();
    const tooLong = `${'a'.repeat(MAX_ANSWER_CHARS)} and one more clause.`;

    expect(await createGeneralAnswer(clientReturning({ answer: tooLong })).compose(ASK)).toEqual({
      status: 'unavailable',
      reason: 'unsendable',
    });
    log.mockRestore();
  });

  it('accepts an answer exactly at the cap', async () => {
    const exact = 'a'.repeat(MAX_ANSWER_CHARS);
    expect(await createGeneralAnswer(clientReturning({ answer: exact })).compose(ASK)).toEqual({
      status: 'composed',
      reply: exact,
    });
  });

  it('refuses an answer that is empty once flattened', async () => {
    const log = quiet();
    expect(await createGeneralAnswer(clientReturning({ answer: '  **  ** ' })).compose(ASK)).toEqual(
      { status: 'unavailable', reason: 'unsendable' },
    );
    log.mockRestore();
  });

  /** An emoji has no ASCII twin to fold to, and one of them re-encodes the whole body to
   * UCS-2. Nothing is guessed at: the answer is refused and the fixed line goes out. */
  it('refuses an answer that is still outside GSM-7 after flattening', async () => {
    const log = quiet();
    expect(
      await createGeneralAnswer(clientReturning({ answer: 'Messi, no contest 🐐' })).compose(ASK),
    ).toEqual({ status: 'unavailable', reason: 'unsendable' });
    log.mockRestore();
  });

  /** A provider error can echo the request back, so only the class and the message
   * survive — never the parent's words (rule #1). */
  it('never logs the question, on any path', async () => {
    const secret = 'is the Riverdale Montessori on Boulton any good';
    const log = quiet();

    await createGeneralAnswer(outageClient).compose(secret);
    await createGeneralAnswer(throwingClient).compose(secret);
    await createGeneralAnswer(clientReturning({ answer: 'x'.repeat(400) })).compose(secret);

    expect(JSON.stringify(log.mock.calls)).not.toContain('Riverdale');
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    log.mockRestore();
  });
});

/** The skill says "No links, ever" — this makes it structural rather than requested
 * (skill-audit doctrine, 2026-08-12): a URL the model composes is a URL it invented,
 * and the lane's fixed line beats an invented destination every time. */
describe('link refusal', () => {
  it('refuses an answer carrying any URL shape', async () => {
    for (const body of [
      'Check https://espn.com for the full debate.',
      'See www.consumerlab.com - they reviewed it.',
      'It is at http://parks.ca today.',
    ]) {
      expect(await createGeneralAnswer(clientReturning({ answer: body })).compose(ASK)).toEqual({
        status: 'unavailable',
        reason: 'unsendable',
      });
    }
  });
});
