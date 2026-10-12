import type { AgentClient } from '@hale/agent';
import { pickModel } from '@hale/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AFTER_PROVISION_RETURN_ASK,
  CHEER_UP_REPLY,
  NO_CURRENT_SOURCE_YET,
} from '~/lib/channel/intake/live-lookup';
import {
  GENERAL_ANSWER_SEARCH_ENABLED_ENV,
  createGeneralAnswer,
  generalAnswerSearchEnabled,
  generalAnswerUserMessage,
  localDate,
  questionSanitizeUserMessage,
  searchUserMessage,
} from './answer';
import { EMERGENCY_REPLY, MENTAL_CRISIS_REPLY, SAFETY_REPLY } from './copy';
import { COMPOSE_MAX_TOKENS } from './medical';

/**
 * The general answer's MECHANICS. Not its judgement.
 *
 * Whether "did the leafs win last night" gets a correct, friendly answer is decided by
 * real models and measured in apps/worker/evals/run-general-answer-eval.mjs against real
 * cached Claude (rule #8). What is proven here is what the eval cannot reach: that the
 * parent's own words reach the sanitize call and nothing after it, that the search runs
 * only when it is lit and judged needed, that every way it does not run comes back NAMED
 * (rule #11), and that nothing unsendable ever leaves the stage.
 */

interface SystemBlock {
  type: string;
  text: string;
}

interface Captured {
  model?: string;
  max_tokens?: number;
  system?: string | SystemBlock[];
  tools?: Array<{ name?: string; type?: string; max_uses?: number }>;
  messages?: Array<{ role: string; content: string }>;
}

/** The instructions the model is given, whether they arrived as a string or as
 * cache-marked text blocks. */
function systemText(system: Captured['system']): string {
  if (typeof system === 'string') return system;
  return (system ?? []).map((block) => block.text).join('');
}

const SANITIZE_HEADING = 'Take the family out, keep the question';
const ANSWER_HEADING = 'A friend who knows, texting back';

const TODAY = 'monday, oct 12, 2026';
const ASK = 'whos the goat in football';

/** What each of the three calls returns. An Error is thrown by that call. */
interface Script {
  sanitize?: unknown;
  search?: unknown[] | Error;
  answer?: unknown;
}

interface Seen {
  sanitize: Captured[];
  search: Captured[];
  compose: Captured[];
}

const seenNothing = (): Seen => ({ sanitize: [], search: [], compose: [] });

const reading = (overrides: Record<string, unknown> = {}) => ({
  language: 'en',
  question: ASK,
  current_fact: 'none',
  needs_search: 'no',
  ...overrides,
});

const structured = (payload: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(payload) }],
  usage: { input_tokens: 10, output_tokens: 5 },
});

/**
 * The Fake behind the lane's one injected client. The two structured calls arrive on
 * `create` and are told apart by the skill each carries; the search arrives on `stream`,
 * which is the only way this lane sends it.
 */
function scripted(script: Script, seen: Seen = seenNothing()): () => AgentClient {
  return () =>
    ({
      messages: {
        async create(request: Captured) {
          const sanitizing = systemText(request.system).includes(SANITIZE_HEADING);
          (sanitizing ? seen.sanitize : seen.compose).push(request);
          const payload = sanitizing ? (script.sanitize ?? reading()) : script.answer;
          if (payload instanceof Error) throw payload;
          return structured(payload);
        },
        stream(request: Captured) {
          seen.search.push(request);
          return {
            async finalMessage() {
              if (script.search instanceof Error) throw script.search;
              return {
                content: script.search ?? [],
                usage: { input_tokens: 10, output_tokens: 5 },
              };
            },
          };
        },
      },
    }) as unknown as AgentClient;
}

/** A client that answers the question `answer`, needing no search. */
const clientReturning = (answer: unknown, seen?: Seen) => scripted({ answer }, seen);

const throwingClient = (): AgentClient => {
  throw new Error('ANTHROPIC_API_KEY is not set');
};

const outageClient = scripted({ sanitize: new Error('upstream 529') });

const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});
const quietWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

const LEAFS_URL = 'https://www.nhl.com/mapleleafs/news/recap';
const LEAFS_NOTES = 'The Maple Leafs beat the Senators 4-2 on October 11, per NHL.com.';

/** A search turn that returned one real result and wrote its notes. */
const searchFound = (url = LEAFS_URL, notes = LEAFS_NOTES) => [
  { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'leafs' } },
  {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtoolu_1',
    content: [{ type: 'web_search_result', url, title: 'Recap', encrypted_content: 'x' }],
  },
  { type: 'text', text: notes },
];

const lit = () => vi.stubEnv(GENERAL_ANSWER_SEARCH_ENABLED_ENV, 'true');

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the three payloads', () => {
  /** The ONE call the parent's words reach. The eval replicates all three shapes, so a
   * change to any of them re-keys the cache. */
  it('hands the sanitize call the raw text and nothing else', () => {
    expect(questionSanitizeUserMessage(ASK)).toBe('{"text":"whos the goat in football"}');
  });

  it('hands the search the de-identified question and the date, and nothing else', () => {
    expect(searchUserMessage({ question: 'did the leafs win last night', today: TODAY })).toBe(
      '{"question":"did the leafs win last night","today":"monday, oct 12, 2026"}',
    );
  });

  it('hands the compose the question, the language, the date and what the search found', () => {
    expect(
      generalAnswerUserMessage({
        question: 'did the leafs win last night',
        language: 'en',
        today: TODAY,
        search: 'searched',
        notes: LEAFS_NOTES,
      }),
    ).toBe(
      `{"question":"did the leafs win last night","language":"en","today":"monday, oct 12, 2026","live":"searched","research_notes":"${LEAFS_NOTES}"}`,
    );
  });

  /** The three ways a needed search did not happen are one thing to the writer: nothing
   * could be checked. Which one it was is the log's and the outcome's to carry. */
  it.each(['search_off', 'search_failed', 'nothing_usable'] as const)(
    'tells the compose only that nothing could be checked when the search was %s',
    (search) => {
      expect(
        generalAnswerUserMessage({
          question: 'q',
          language: 'fr',
          today: TODAY,
          search,
          notes: '',
        }),
      ).toBe(
        '{"question":"q","language":"fr","today":"monday, oct 12, 2026","live":"unavailable"}',
      );
    },
  );
});

describe('localDate', () => {
  /** The day is the FAMILY's, not the server's: at 02:30 UTC it is still the evening
   * before on the west coast and already mid-morning in Tokyo. */
  it('names the weekday and the date in the zone it is given', () => {
    const instant = new Date('2026-10-13T02:30:00Z');
    expect(localDate(instant, 'America/Vancouver')).toBe('monday, oct 12, 2026');
    expect(localDate(instant, 'Asia/Tokyo')).toBe('tuesday, oct 13, 2026');
  });
});

describe('GENERAL_ANSWER_SEARCH_ENABLED', () => {
  it('is dark by default', () => {
    expect(generalAnswerSearchEnabled()).toBe(false);
  });

  it('is lit by exactly true', () => {
    lit();
    expect(generalAnswerSearchEnabled()).toBe(true);
  });

  /** A piped `vercel env add` stores 'true\n'. No trim, so that stays dark. */
  it.each(['True', 'true\n', ' true', '1', 'on', ''])('stays dark for %j', (value) => {
    vi.stubEnv(GENERAL_ANSWER_SEARCH_ENABLED_ENV, value);
    expect(generalAnswerSearchEnabled()).toBe(false);
  });
});

describe('createGeneralAnswer', () => {
  it('composes the answer the model wrote', async () => {
    const answer = createGeneralAnswer(
      clientReturning({ answer: 'Messi, for me - the closest thing to a complete player.' }),
    );

    expect(await answer.compose(ASK, TODAY)).toEqual({
      status: 'composed',
      reply: 'Messi, for me - the closest thing to a complete player.',
      search: 'not_needed',
    });
  });

  /**
   * The privacy property this stage is BUILT on, asserted structurally rather than
   * promised in a comment: an off-topic answer needs nothing about the children, so
   * nothing about them is loaded and nothing about them can be sent. Anything a future
   * edit splices into a request has to break this test first.
   */
  it('sends each call its skill and its payload, and nothing about the family', async () => {
    const seen = seenNothing();
    await createGeneralAnswer(
      scripted(
        {
          sanitize: reading({ question: 'what is the capital of peru' }),
          answer: { answer: 'Lima.' },
        },
        seen,
      ),
    ).compose('whats the capital of peru', TODAY);

    expect(seen.sanitize.map((request) => request.messages)).toEqual([
      [{ role: 'user', content: '{"text":"whats the capital of peru"}' }],
    ]);
    expect(seen.compose.map((request) => request.messages)).toEqual([
      [
        {
          role: 'user',
          content:
            '{"question":"what is the capital of peru","language":"en","today":"monday, oct 12, 2026","live":"not_needed"}',
        },
      ],
    ]);
    const instructions = systemText(seen.compose[0]?.system);
    expect(instructions).toContain(ANSWER_HEADING);
    // The skill body is the whole cached prefix: no context block spliced after it.
    expect(instructions.endsWith('point at an app.')).toBe(true);
  });

  it('names a missing client rather than throwing', async () => {
    quiet();
    expect(await createGeneralAnswer(throwingClient).compose(ASK, TODAY)).toEqual({
      status: 'unavailable',
      reason: 'client_unavailable',
    });
  });

  it('names a provider outage rather than throwing', async () => {
    quiet();
    expect(await createGeneralAnswer(outageClient).compose(ASK, TODAY)).toEqual({
      status: 'unavailable',
      reason: 'model_failed',
    });
  });

  it('names a compose that came back unparseable rather than throwing', async () => {
    quiet();
    expect(await createGeneralAnswer(clientReturning('sure')).compose(ASK, TODAY)).toEqual({
      status: 'unavailable',
      reason: 'model_failed',
    });
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
    ).compose(ASK, TODAY);

    expect(result).toEqual({
      status: 'composed',
      reply: "Messi - he's the one I'd pick.",
      search: 'not_needed',
    });
  });

  /**
   * LENGTH IS NOT A REFUSAL. A correct answer that ran long used to be swapped for the
   * fixed could-not-get-to-it line, which is a deflect sent in place of an answer. What
   * the model wrote is what goes out, in any script.
   */
  it.each([
    ['a long English answer', 'a'.repeat(700)],
    ['a long Chinese answer', '中'.repeat(300)],
  ])('sends %s rather than the fixed line', async (_label, body) => {
    expect(
      await createGeneralAnswer(clientReturning({ answer: body })).compose(ASK, TODAY),
    ).toEqual({ status: 'composed', reply: body, search: 'not_needed' });
  });

  /**
   * The budget is where a reply is bounded, and a reply cut off there never arrives: the
   * seam throws and the parent gets the fixed line. Live, a compose handed long research
   * notes wrote past 256 tokens of text. So it gets the medical compose's budget, which is
   * generous for that reason.
   */
  it("gives the compose the medical compose's token budget", async () => {
    const seen = seenNothing();
    await createGeneralAnswer(clientReturning({ answer: 'Lima.' }, seen)).compose(ASK, TODAY);

    expect(COMPOSE_MAX_TOKENS).toBe(1024);
    expect(seen.compose[0]?.max_tokens).toBe(COMPOSE_MAX_TOKENS);
  });

  it('refuses an answer that is empty once flattened', async () => {
    const log = quiet();
    expect(
      await createGeneralAnswer(clientReturning({ answer: '  **  ** ' })).compose(ASK, TODAY),
    ).toEqual({ status: 'unavailable', reason: 'unsendable' });
    expect(log.mock.calls).toEqual([
      [
        { reason: 'unsendable', detail: 'empty' },
        'off-domain answer: falling back to the fixed line',
      ],
    ]);
  });

  /** A parent who writes in French or Chinese is answered in kind (general-answer.md).
   * `plainText` still folds a gratuitous curly quote or em dash to ASCII, but the é and
   * the Chinese character are content, not flourish, so they survive. */
  it('ships an accented-French answer', async () => {
    expect(
      await createGeneralAnswer(
        clientReturning({ answer: "A mon avis, c'est un peu drôle mais délicieux." }),
      ).compose('cest quoi ton avis', TODAY),
    ).toMatchObject({
      status: 'composed',
      reply: "A mon avis, c'est un peu drôle mais délicieux.",
    });
  });

  it('ships a Chinese answer', async () => {
    expect(
      await createGeneralAnswer(clientReturning({ answer: '梅西,无可争议。' })).compose(
        '足球界谁最强',
        TODAY,
      ),
    ).toMatchObject({ status: 'composed', reply: '梅西,无可争议。' });
  });

  /**
   * Sloane's finding 5. The eval's recorded `melatonin-adults` reply points at a
   * pharmacist or a doctor, and production runs one gate the eval does not mirror:
   * `reachesForTheHealthLine`, which swaps a reply for the fixed safety line. That gate
   * reads the two numbers and nothing else, so a pointer to a person passes it and the
   * reply the judge graded is the reply the parent gets.
   */
  it('sends the recorded melatonin reply as written, not the fixed health line', async () => {
    const recorded =
      "Short term, for most healthy adults it's generally considered low risk, but I'm not a doctor, so check with a pharmacist or doctor first if you take other medicines or have a health condition.";

    expect(
      await createGeneralAnswer(clientReturning({ answer: recorded })).compose(
        'is melatonin safe for adults',
        TODAY,
      ),
    ).toEqual({ status: 'composed', reply: recorded, search: 'not_needed' });
  });

  /** A provider error can echo the request back, so only named details survive — never
   * the parent's words, raw or de-identified (rule #1). */
  it('never logs the question, on any path', async () => {
    const secret = 'is the Riverdale Montessori on Boulton any good';
    const log = quiet();
    const warn = quietWarn();
    lit();

    await createGeneralAnswer(outageClient).compose(secret, TODAY);
    await createGeneralAnswer(throwingClient).compose(secret, TODAY);
    await createGeneralAnswer(clientReturning({ answer: '  ' })).compose(secret, TODAY);
    await createGeneralAnswer(
      scripted({
        sanitize: reading({ question: secret, needs_search: 'yes' }),
        search: new Error(`400 invalid_request_error: ${secret}`),
        answer: { answer: `See https://example.com about ${secret}` },
      }),
    ).compose(secret, TODAY);

    const logged = JSON.stringify([...log.mock.calls, ...warn.mock.calls]);
    expect(logged).not.toContain('Riverdale');
    expect(logged).not.toContain(secret);
  });

  /**
   * Every request this stage sends holds the parent's question in one form or another,
   * and a provider error can quote the request back in its MESSAGE. So a failed call is
   * logged by the phase it failed in, the error's name, and why a structured answer was
   * unusable, and by nothing else.
   */
  it('logs a failed model call by phase and error name, never the provider message', async () => {
    const secret = 'is the Riverdale Montessori on Boulton any good';
    const echo = new Error(`400 invalid_request_error: {"text":"${secret}"}`);
    const truncated = (): AgentClient =>
      ({
        messages: {
          async create() {
            return { content: [], stop_reason: 'max_tokens', usage: {} };
          },
        },
      }) as unknown as AgentClient;
    const log = quiet();

    await createGeneralAnswer(scripted({ sanitize: echo })).compose(secret, TODAY);
    await createGeneralAnswer(truncated).compose(secret, TODAY);
    await createGeneralAnswer(scripted({ answer: echo })).compose(secret, TODAY);

    expect(log.mock.calls).toEqual([
      [
        { reason: 'model_failed', detail: 'sanitize_failed:Error' },
        'off-domain answer: falling back to the fixed line',
      ],
      [
        { reason: 'model_failed', detail: 'sanitize_failed:StructuredOutputError:truncated' },
        'off-domain answer: falling back to the fixed line',
      ],
      [
        { reason: 'model_failed', detail: 'Error' },
        'off-domain answer: falling back to the fixed line',
      ],
    ]);
  });
});

/**
 * Phase 0. The raw message reaches the sanitize call and nothing after it: the search is
 * a cross-border send (rule #1) and the compose has no use for who is asking.
 */
describe('the sanitize phase', () => {
  const RAW = 'my neighbour Priya says the leafs won last night, did they';
  const DEIDENTIFIED = 'did the leafs win last night';

  it('keeps a name in the raw text out of the search and out of the compose', async () => {
    lit();
    const seen = seenNothing();
    await createGeneralAnswer(
      scripted(
        {
          sanitize: reading({ question: DEIDENTIFIED, needs_search: 'yes' }),
          search: searchFound(),
          answer: { answer: 'Yep, 4-2 over the Senators.' },
        },
        seen,
      ),
    ).compose(RAW, TODAY);

    expect(JSON.stringify(seen.sanitize)).toContain('Priya');
    expect(seen.search).toHaveLength(1);
    expect(seen.compose).toHaveLength(1);
    expect(JSON.stringify(seen.search)).not.toContain('Priya');
    expect(JSON.stringify(seen.compose)).not.toContain('Priya');
    expect(seen.search[0]?.messages).toEqual([
      { role: 'user', content: `{"question":"${DEIDENTIFIED}","today":"${TODAY}"}` },
    ]);
  });

  /**
   * The medical lane's deterministic backstop (scrubResidualPii), under the sanitizer.
   * It is the floor for the identifier classes a pattern can hold - an email, a phone
   * number, a postal code - and it runs before the question goes anywhere. A NAME is
   * free-form and stays the sanitizer's job.
   */
  it('scrubs an identifier the sanitizer left in before the question goes anywhere', async () => {
    lit();
    const seen = seenNothing();
    await createGeneralAnswer(
      scripted(
        {
          sanitize: reading({
            question: 'will it rain near L7G 4S6, text me at 416-555-0142 or pat@example.com',
            needs_search: 'yes',
          }),
          search: searchFound(),
          answer: { answer: 'Looks dry.' },
        },
        seen,
      ),
    ).compose('anything', TODAY);

    const downstream = JSON.stringify([seen.search, seen.compose]);
    expect(downstream).not.toContain('L7G');
    expect(downstream).not.toContain('555-0142');
    expect(downstream).not.toContain('pat@example.com');
    expect(seen.search[0]?.messages?.[0]?.content).toBe(
      `{"question":"will it rain near [redacted], text me at [redacted] or [redacted]","today":"${TODAY}"}`,
    );
  });

  it('answers in the language the sanitizer read, and in English when it read none', async () => {
    const seen = seenNothing();
    await createGeneralAnswer(
      scripted({ sanitize: reading({ language: 'fr' }), answer: { answer: 'Oui.' } }, seen),
    ).compose('cest ok', TODAY);
    await createGeneralAnswer(
      scripted(
        { sanitize: reading({ language: 'not a language code' }), answer: { answer: 'Yes.' } },
        seen,
      ),
    ).compose('is it ok', TODAY);

    expect(
      seen.compose.map((request) => JSON.parse(request.messages?.[0]?.content ?? '{}').language),
    ).toEqual(['fr', 'en']);
  });

  /** Nothing is composed from a question nobody de-identified: the raw text may not go
   * to the compose, and there is no other question to hand it. */
  it('names a failed sanitize and sends nothing onward', async () => {
    lit();
    quiet();
    const seen = seenNothing();

    expect(
      await createGeneralAnswer(scripted({ sanitize: new Error('upstream 529') }, seen)).compose(
        RAW,
        TODAY,
      ),
    ).toEqual({ status: 'unavailable', reason: 'model_failed' });
    expect(seen.search).toHaveLength(0);
    expect(seen.compose).toHaveLength(0);
  });

  it('names a sanitize that returned no question', async () => {
    const log = quiet();
    const seen = seenNothing();

    expect(
      await createGeneralAnswer(scripted({ sanitize: reading({ question: '  ' }) }, seen)).compose(
        RAW,
        TODAY,
      ),
    ).toEqual({ status: 'unavailable', reason: 'model_failed' });
    expect(log.mock.calls).toEqual([
      [
        { reason: 'model_failed', detail: 'sanitize_failed:empty_question' },
        'off-domain answer: falling back to the fixed line',
      ],
    ]);
    expect(seen.compose).toHaveLength(0);
  });
});

/**
 * Phase 1. The search runs only when it is lit AND the sanitizer judged the answer needs
 * something current. Every other way through is named in the outcome and in the log
 * (rule #11), and none of them costs the parent a reply: the compose is told nothing could
 * be checked.
 */
describe('the live search', () => {
  const CURRENT = reading({ question: 'did the leafs win last night', needs_search: 'yes' });
  const live = (seen: Seen) => JSON.parse(seen.compose[0]?.messages?.[0]?.content ?? '{}').live;

  it('searches when lit and needed, on a streamed web_search turn, and composes from what it found', async () => {
    lit();
    const seen = seenNothing();

    expect(
      await createGeneralAnswer(
        scripted(
          { sanitize: CURRENT, search: searchFound(), answer: { answer: 'Yep, 4-2.' } },
          seen,
        ),
      ).compose('did the leafs win last night', TODAY),
    ).toEqual({ status: 'composed', reply: 'Yep, 4-2.', search: 'searched' });

    expect(seen.search).toHaveLength(1);
    expect(seen.search[0]?.model).toBe(pickModel('extract'));
    expect(seen.search[0]?.tools).toEqual([
      { name: 'web_search', type: 'web_search_20250305', max_uses: 2 },
    ]);
    expect(systemText(seen.search[0]?.system)).toContain('Look it up, write down what you found');
    expect(JSON.parse(seen.compose[0]?.messages?.[0]?.content ?? '{}')).toEqual({
      question: 'did the leafs win last night',
      language: 'en',
      today: TODAY,
      live: 'searched',
      research_notes: LEAFS_NOTES,
    });
  });

  it('makes no search call while the flag is dark, and names it', async () => {
    const warn = quietWarn();
    const seen = seenNothing();

    expect(
      await createGeneralAnswer(
        scripted(
          { sanitize: CURRENT, answer: { answer: "I can't check scores right now." } },
          seen,
        ),
      ).compose('did the leafs win last night', TODAY),
    ).toEqual({
      status: 'composed',
      reply: "I can't check scores right now.",
      search: 'search_off',
    });

    expect(seen.search).toHaveLength(0);
    expect(live(seen)).toBe('unavailable');
    expect(warn.mock.calls).toEqual([
      [{ search: 'search_off', detail: undefined }, 'off-domain answer: no live search this turn'],
    ]);
  });

  it('makes no search call for a question that needs nothing current, lit or not', async () => {
    lit();
    const warn = quietWarn();
    const seen = seenNothing();

    expect(
      await createGeneralAnswer(
        scripted({ sanitize: reading({ needs_search: 'no' }), answer: { answer: 'Lima.' } }, seen),
      ).compose('whats the capital of peru', TODAY),
    ).toEqual({ status: 'composed', reply: 'Lima.', search: 'not_needed' });

    expect(seen.search).toHaveLength(0);
    expect(live(seen)).toBe('not_needed');
    expect(warn).not.toHaveBeenCalled();
  });

  /** Only an explicit `no` skips the search. A stale fact stated flat is the failure
   * worth avoiding, so anything the sanitizer was not sure of gets looked up. */
  it.each(['unsure', 'maybe later', null, undefined])(
    'searches when the reading is %j',
    async (needs_search) => {
      lit();
      const seen = seenNothing();
      await createGeneralAnswer(
        scripted(
          { sanitize: reading({ needs_search }), search: searchFound(), answer: { answer: 'x' } },
          seen,
        ),
      ).compose(ASK, TODAY);

      expect(seen.search).toHaveLength(1);
    },
  );

  it('names a search that failed, by the error name, and still composes the honest reply', async () => {
    lit();
    const warn = quietWarn();
    const seen = seenNothing();

    expect(
      await createGeneralAnswer(
        scripted(
          {
            sanitize: CURRENT,
            search: new Error('connection reset: did the leafs win last night'),
            answer: { answer: "I can't check that right now." },
          },
          seen,
        ),
      ).compose('did the leafs win last night', TODAY),
    ).toEqual({
      status: 'composed',
      reply: "I can't check that right now.",
      search: 'search_failed',
    });

    expect(live(seen)).toBe('unavailable');
    expect(warn.mock.calls).toEqual([
      [{ search: 'search_failed', detail: 'Error' }, 'off-domain answer: no live search this turn'],
    ]);
  });

  /**
   * The result items actually returned are counted, the way the medical lane counts them.
   * A search block that came back as an ERROR carries an object, not a list, and a turn
   * that never searched carries no block at all: neither is a search.
   */
  it.each([
    ['the model never searched', [{ type: 'text', text: 'The Leafs won 4-2.' }], 'no_results'],
    [
      'the search came back as an error',
      [
        {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: { type: 'web_search_tool_result_error', error_code: 'unavailable' },
        },
        { type: 'text', text: 'The Leafs won 4-2.' },
      ],
      'no_results',
    ],
    [
      'the search matched nothing',
      [{ type: 'web_search_tool_result', tool_use_id: 's', content: [] }],
      'no_results',
    ],
    ['results came back and nothing was written down', searchFound(LEAFS_URL, '  '), 'empty_notes'],
  ])(
    'names nothing usable when %s, and hands the compose no notes',
    async (_label, content, detail) => {
      lit();
      const warn = quietWarn();
      const seen = seenNothing();

      expect(
        await createGeneralAnswer(
          scripted(
            { sanitize: CURRENT, search: content, answer: { answer: "Can't check right now." } },
            seen,
          ),
        ).compose('did the leafs win last night', TODAY),
      ).toEqual({ status: 'composed', reply: "Can't check right now.", search: 'nothing_usable' });

      expect(JSON.parse(seen.compose[0]?.messages?.[0]?.content ?? '{}')).toEqual({
        question: 'did the leafs win last night',
        language: 'en',
        today: TODAY,
        live: 'unavailable',
      });
      expect(warn.mock.calls).toEqual([
        [{ search: 'nothing_usable', detail }, 'off-domain answer: no live search this turn'],
      ]);
    },
  );
});

/**
 * A URL in a reply is real only if this turn's search returned it. Before the lane could
 * search, any URL was one the model invented; now one can be the thing the parent asked
 * for, so the gate is which URL, not whether.
 */
describe('links', () => {
  const WHERE = reading({ question: 'where can I stream the euros', needs_search: 'yes' });
  const TSN = 'https://www.tsn.ca/soccer/euro';

  it('sends a link the search of this turn returned', async () => {
    lit();
    expect(
      await createGeneralAnswer(
        scripted({
          sanitize: WHERE,
          search: searchFound(TSN, 'TSN carries it in Canada.'),
          answer: { answer: `TSN has it: ${TSN}.` },
        }),
      ).compose('where can I stream the euros', TODAY),
    ).toEqual({ status: 'composed', reply: `TSN has it: ${TSN}.`, search: 'searched' });
  });

  it('refuses a link the search did not return, by name', async () => {
    lit();
    const log = quiet();

    expect(
      await createGeneralAnswer(
        scripted({
          sanitize: WHERE,
          search: searchFound(TSN, 'TSN carries it in Canada.'),
          answer: { answer: 'It is on https://www.tsn.ca/live-now today.' },
        }),
      ).compose('where can I stream the euros', TODAY),
    ).toEqual({ status: 'unavailable', reason: 'unsendable' });
    expect(log.mock.calls).toEqual([
      [
        { reason: 'unsendable', detail: 'link_not_from_search' },
        'off-domain answer: falling back to the fixed line',
      ],
    ]);
  });

  it('refuses any URL shape when no search ran', async () => {
    quiet();
    for (const body of [
      'Check https://espn.com for the full debate.',
      'See www.consumerlab.com - they reviewed it.',
      'It is at http://parks.ca today.',
    ]) {
      expect(
        await createGeneralAnswer(clientReturning({ answer: body })).compose(ASK, TODAY),
      ).toEqual({ status: 'unavailable', reason: 'unsendable' });
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

    const outcome = await createGeneralAnswer(client).compose('who won the World Cup?', TODAY);
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
    quiet();
    const outcome = await createGeneralAnswer(exploding).compose('Who is the US president?', TODAY);
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
    const outcome = await createGeneralAnswer(exploding).compose('cheer me up', TODAY);
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
    expect(await createGeneralAnswer(exploding).compose('I want to die', TODAY)).toEqual({
      status: 'composed',
      reply: MENTAL_CRISIS_REPLY,
    });
    expect(MENTAL_CRISIS_REPLY).not.toContain('?');
    expect(MENTAL_CRISIS_REPLY).not.toContain('811');
    expect(MENTAL_CRISIS_REPLY).not.toContain('not something I should advise on');
    expect(MENTAL_CRISIS_REPLY).not.toBe(EMERGENCY_REPLY);
  });

  it('answers a physical emergency with Call 911 now. and no return ask', async () => {
    const exploding = () =>
      ({
        messages: {
          create: () => {
            throw new Error('a physical emergency must not reach a model');
          },
        },
      }) as unknown as AgentClient;
    expect(await createGeneralAnswer(exploding).compose('she is not breathing', TODAY)).toEqual({
      status: 'composed',
      reply: EMERGENCY_REPLY,
    });
    expect(EMERGENCY_REPLY).toBe('Call 911 now.');
    expect(EMERGENCY_REPLY).not.toContain('811');
    expect(EMERGENCY_REPLY).not.toContain('Health811');
    expect(EMERGENCY_REPLY).not.toContain('988');
    expect(EMERGENCY_REPLY).not.toContain('?');
    expect(EMERGENCY_REPLY).not.toBe(SAFETY_REPLY);
  });
});

describe('safety refusal', () => {
  it.each(['Not medical advice, but 811 can help any time.', 'That needs a person - call 911.'])(
    'hands a composed referral to the fixed line instead of sending it: %s',
    async (body) => {
      quiet();

      expect(
        await createGeneralAnswer(clientReturning({ answer: body })).compose(ASK, TODAY),
      ).toEqual({ status: 'safety' });
    },
  );
});
