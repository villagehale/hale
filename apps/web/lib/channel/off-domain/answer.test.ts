import type { AgentClient } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import {
  AFTER_PROVISION_RETURN_ASK,
  CHEER_UP_REPLY,
  NO_CURRENT_SOURCE_YET,
} from '~/lib/channel/intake/live-lookup';
import { MAX_ANSWER_SEGMENTS, createGeneralAnswer, generalAnswerUserMessage } from './answer';
import { MENTAL_CRISIS_REPLY } from './copy';

/** GSM-7 concatenation part size (sms-segments.ts GSM7_CONCAT_PART). A GSM-7 body of
 * this many characters is exactly {@link MAX_ANSWER_SEGMENTS} segments; one more tips it
 * over. Kept local so the cap tests track the constant rather than a magic 306/307. */
const GSM7_CONCAT_PART = 153;

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
   * so the lane's fixed line is the better outcome, and it is a named one. The budget is
   * SEGMENTS, so it holds in whatever currency the body's encoding is billed in.
   */
  it('refuses an answer past the segment budget instead of truncating it', async () => {
    const log = quiet();
    const tooLong = 'a'.repeat(MAX_ANSWER_SEGMENTS * GSM7_CONCAT_PART + 1);

    expect(await createGeneralAnswer(clientReturning({ answer: tooLong })).compose(ASK)).toEqual({
      status: 'unavailable',
      reason: 'unsendable',
    });
    log.mockRestore();
  });

  it('accepts an answer exactly at the segment budget', async () => {
    const exact = 'a'.repeat(MAX_ANSWER_SEGMENTS * GSM7_CONCAT_PART);
    expect(await createGeneralAnswer(clientReturning({ answer: exact })).compose(ASK)).toEqual({
      status: 'composed',
      reply: exact,
    });
  });

  it('refuses an answer that is empty once flattened', async () => {
    const log = quiet();
    expect(
      await createGeneralAnswer(clientReturning({ answer: '  **  ** ' })).compose(ASK),
    ).toEqual({ status: 'unavailable', reason: 'unsendable' });
    log.mockRestore();
  });

  /**
   * The gate is UCS-2-aware, not GSM-7-only: a parent who writes in French or Chinese is
   * answered in kind (general-answer.md), and an accented or CJK body — which is UCS-2 —
   * SHIPS as long as it fits the segment budget. This is the capability the old
   * `not_gsm7` reject silently blocked; it fell every such answer closed to the English
   * line. `plainText` still folds a gratuitous curly quote or em dash to ASCII, but the é
   * and the Chinese character are content, not flourish, so they survive.
   */
  it('ships a short accented-French answer (UCS-2 within budget)', async () => {
    // "drôle" carries ô, which is outside GSM-7 (é/è/à are not) — so this body is genuinely
    // UCS-2, the exact case the old not_gsm7 reject would have fallen closed.
    expect(
      await createGeneralAnswer(
        clientReturning({ answer: "A mon avis, c'est un peu drôle mais délicieux." }),
      ).compose('cest quoi ton avis'),
    ).toEqual({ status: 'composed', reply: "A mon avis, c'est un peu drôle mais délicieux." });
  });

  it('ships a short Chinese answer (UCS-2 within budget)', async () => {
    expect(
      await createGeneralAnswer(clientReturning({ answer: '梅西,无可争议。' })).compose(
        '足球界谁最强',
      ),
    ).toEqual({ status: 'composed', reply: '梅西,无可争议。' });
  });

  /** The segment budget bites in UCS-2 too: a long Chinese body is three segments at 135
   * characters where an English one takes 460, and it is refused just the same. */
  it('refuses a Chinese answer that runs past the segment budget', async () => {
    const log = quiet();
    const tooLong = '中'.repeat(MAX_ANSWER_SEGMENTS * 67 + 1);
    expect(await createGeneralAnswer(clientReturning({ answer: tooLong })).compose(ASK)).toEqual({
      status: 'unavailable',
      reason: 'unsendable',
    });
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

/**
 * Skill audit P0 #3. The screen sends "off_domain_general" for a question about the
 * world, but the world sometimes turns out to be a hurt child mid-sentence — and the
 * skill's answer to that today is a siren the model writes itself. It cannot: this
 * branch carries no text, so the fixed line in copy.ts is the only thing the lane can
 * put on the wire (see lane.test.ts for the words).
 */
describe('after provision leftover facts · VIL-327', () => {
  it('does not leave a current-source leftover fact in trivia', async () => {
    const notes = 'Argentina won the 2022 FIFA World Cup.';
    const client = () =>
      ({
        messages: {
          create: async (req: { tools?: Array<{ type?: string }> }) => {
            if (req.tools?.[0]?.type === 'web_search_20250305') {
              return {
                content: [
                  { type: 'text', text: notes },
                  {
                    type: 'web_search_tool_result',
                    tool_use_id: 'srvtu_3',
                    content: [
                      {
                        type: 'web_search_result',
                        url: 'https://www.fifa.com',
                        title: 'World Cup',
                      },
                    ],
                  },
                ],
              };
            }
            throw new Error('after-provision leftover facts must not invent from memory');
          },
        },
      }) as unknown as AgentClient;

    const outcome = await createGeneralAnswer(client).compose('who won the World Cup?');
    expect(outcome.status).toBe('composed');
    if (outcome.status !== 'composed') return;
    expect(outcome.reply).toContain('Argentina');
    expect(outcome.reply).toContain(AFTER_PROVISION_RETURN_ASK);
    expect(outcome.reply).not.toMatch(/https?:\/\//);
  });

  it('says no current source yet, then returns to the kids / the week', async () => {
    const exploding = () =>
      ({
        messages: {
          create: () => {
            throw new Error('search down');
          },
        },
      }) as unknown as AgentClient;
    const log = quiet();
    const outcome = await createGeneralAnswer(exploding).compose('Who is the US president?');
    log.mockRestore();
    expect(outcome.status).toBe('composed');
    if (outcome.status !== 'composed') return;
    expect(outcome.reply).toContain(NO_CURRENT_SOURCE_YET);
    expect(outcome.reply).toContain(AFTER_PROVISION_RETURN_ASK);
  });

  it('answers a cheer-up with warmth and a line back to the week', async () => {
    const exploding = () =>
      ({
        messages: {
          create: () => {
            throw new Error('cheer-up is reviewed copy');
          },
        },
      }) as unknown as AgentClient;
    const outcome = await createGeneralAnswer(exploding).compose('cheer me up');
    expect(outcome.status).toBe('composed');
    if (outcome.status !== 'composed') return;
    expect(outcome.reply).toContain(CHEER_UP_REPLY);
    expect(outcome.reply).toContain(AFTER_PROVISION_RETURN_ASK);
    expect(outcome.reply).not.toMatch(/diagnos|treatment plan|I'?m a therapist/i);
  });

  it('answers a crisis with safety and no return ask', async () => {
    const exploding = () =>
      ({
        messages: {
          create: () => {
            throw new Error('a crisis must not reach a model');
          },
        },
      }) as unknown as AgentClient;
    expect(await createGeneralAnswer(exploding).compose('I want to die')).toEqual({
      status: 'composed',
      reply: MENTAL_CRISIS_REPLY,
    });
    expect(MENTAL_CRISIS_REPLY).not.toContain('?');
    expect(MENTAL_CRISIS_REPLY).not.toContain('811');
    expect(MENTAL_CRISIS_REPLY).not.toContain("not something I should advise on");
  });
});

describe('safety refusal', () => {
  it.each(['Not medical advice, but 811 can help any time.', 'That needs a person - call 911.'])(
    'hands a composed referral to the fixed line instead of sending it: %s',
    async (body) => {
      quiet();

      expect(await createGeneralAnswer(clientReturning({ answer: body })).compose(ASK)).toEqual({
        status: 'safety',
      });
    },
  );
});
