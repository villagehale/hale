import type { AgentClient } from '@hale/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInboundLaneScreen, laneUserMessage, toReading } from './screen';

/**
 * VIL-273 — the screen's MECHANICS. Not its judgement.
 *
 * Which lane "my kid hit her head" belongs in is decided by a real model and measured
 * in apps/worker/evals/run-inbound-lane-eval.mjs against real cached Claude (rule #8);
 * a canned answer here could only ever prove that our own fixture came back. What is
 * proven here is the property the eval cannot reach: that EVERY way this stage can
 * break ends with the coach getting the turn, and none of them ends with a thrown
 * router or a logged message body.
 */

/** A client whose one tool call returns `input`. The words are the test's, so a specific
 * guard can be exercised. */
function clientReturning(input: unknown): () => AgentClient {
  return () =>
    ({
      messages: {
        async create() {
          return {
            content: [{ type: 'text', text: JSON.stringify(input) }],
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

describe('laneUserMessage', () => {
  /** The model gets the text and nothing else — no family, no children, no transcript
   * (rule #1). The eval replicates this exact shape, so a change here re-keys the cache
   * and CI notices. */
  it('hands the model the message and nothing else', () => {
    expect(laneUserMessage('how is the weather')).toBe('{"text":"how is the weather"}');
  });
});

describe('toReading', () => {
  it('passes a well-formed deflection through', () => {
    expect(toReading({ lane: 'safety_critical', category: 'medical-symptom' })).toEqual({
      lane: 'safety_critical',
      category: 'medical-symptom',
      fallback: null,
      language: null,
    });
  });

  it('drops the category for an in-domain reading — it is not an unmet intent', () => {
    expect(toReading({ lane: 'in_domain', category: 'weather' })).toEqual({
      lane: 'in_domain',
      category: null,
      fallback: null,
      language: null,
    });
  });

  /**
   * The two directions are deliberately different. An unreadable LANE is the field the
   * reply is chosen from, so it fails open. An unreadable CATEGORY is only a tally, and
   * throwing away a correct deflection over a mislabelled count would be the worse
   * trade — so it becomes `other`, whose own volume is the signal the list is short.
   */
  it('fails open on a lane it cannot read', () => {
    const log = quiet();
    expect(toReading({ lane: 'sort_of_ours', category: 'weather' })).toEqual({
      lane: 'in_domain',
      category: null,
      fallback: 'unreadable',
      language: null,
    });
    log.mockRestore();
  });

  it('buckets a category it cannot read as other, and still deflects', () => {
    expect(toReading({ lane: 'off_domain_general', category: 'crypto-prices' })).toEqual({
      lane: 'off_domain_general',
      category: 'other',
      fallback: null,
      language: null,
    });
  });

  /** The column can never hold words a parent typed. This is the second reading of the
   * closed vocabulary (the skill states the first), and it is the one that runs. */
  it('refuses a category that is a sentence', () => {
    const reading = toReading({
      lane: 'off_domain_general',
      category: 'mia has a rash on her arm',
    });
    expect(reading.category).toBe('other');
  });

  it('passes a language tag through unchanged, including one this code has never listed', () => {
    expect(
      toReading({ lane: 'in_domain', category: 'none', language: ' zh-Hant ' }).language,
    ).toBe('zh-Hant');
    expect(
      toReading({ lane: 'off_domain_general', category: 'weather', language: 'ZH' }).language,
    ).toBe('ZH');
  });

  it('treats a blank tag as no language, and drops a tag on a lane it cannot read', () => {
    const log = quiet();
    expect(toReading({ lane: 'in_domain', category: 'none', language: '   ' }).language).toBeNull();
    expect(toReading({ lane: 'sort_of_ours', category: 'weather', language: 'zh' })).toEqual({
      lane: 'in_domain',
      category: null,
      fallback: 'unreadable',
      language: null,
    });
    log.mockRestore();
  });
});

describe('createInboundLaneScreen · every failure hands the turn to the coach', () => {
  const READ = 'is there a good park nearby';

  beforeEach(() => vi.stubEnv('HALE_INBOUND_SCREEN_MODEL_MODE', ''));
  afterEach(() => vi.unstubAllEnvs());

  it('reads a lane when the model answers', async () => {
    const screen = createInboundLaneScreen(
      clientReturning({ lane: 'off_domain_general', category: 'weather', reason: 'forecast' }),
    );

    expect(await screen.read(READ)).toEqual({
      lane: 'off_domain_general',
      category: 'weather',
      fallback: null,
      language: null,
    });
  });

  it.each([undefined, '', ' \t\n ', 'invalid', 'shadow', 'current'])(
    'keeps Haiku for model mode %j',
    async (raw) => {
      vi.stubEnv('HALE_INBOUND_SCREEN_MODEL_MODE', raw);
      const evaluateChoice = vi.fn();
      const screen = createInboundLaneScreen(
        clientReturning({ lane: 'in_domain', category: 'none', reason: 'family request' }),
        { evaluateChoice },
      );

      expect((await screen.read(READ)).lane).toBe('in_domain');
      expect(evaluateChoice).not.toHaveBeenCalled();
    },
  );

  it('uses a confident JEV reading when explicitly enabled', async () => {
    const currentClient = clientReturning({
      lane: 'in_domain',
      category: 'none',
      reason: 'fallback',
    });
    const screen = createInboundLaneScreen(currentClient, {
      modelMode: 'candidate',
      evaluateChoice: vi.fn(async () => ({
        choice: 'off_domain_general__weather' as const,
        probabilities: { off_domain_general__weather: 0.7, in_domain__none: 0.3 },
        confidence: 0.7,
        usage: { inputTokens: 5, outputTokens: 1 },
      })),
    });

    expect(await screen.read(READ)).toEqual({
      lane: 'off_domain_general',
      category: 'weather',
      fallback: null,
      language: null,
    });
  });

  it('falls back to Haiku on a low-confidence JEV reading', async () => {
    const screen = createInboundLaneScreen(
      clientReturning({ lane: 'in_domain', category: 'none', reason: 'fallback' }),
      {
        modelMode: 'candidate',
        evaluateChoice: vi.fn(async () => ({
          choice: 'off_domain_general__weather' as const,
          probabilities: { off_domain_general__weather: 0.4, in_domain__none: 0.35 },
          confidence: 0.4,
          usage: { inputTokens: 5, outputTokens: 1 },
        })),
      },
    );

    expect((await screen.read(READ)).lane).toBe('in_domain');
  });

  it('names a missing client rather than throwing', async () => {
    const log = quiet();
    expect(await createInboundLaneScreen(throwingClient).read(READ)).toEqual({
      lane: 'in_domain',
      category: null,
      fallback: 'client_unavailable',
      language: null,
    });
    log.mockRestore();
  });

  it('names a provider outage rather than throwing', async () => {
    const log = quiet();
    expect(await createInboundLaneScreen(outageClient).read(READ)).toEqual({
      lane: 'in_domain',
      category: null,
      fallback: 'model_failed',
      language: null,
    });
    log.mockRestore();
  });

  /** A response with no tool call at all — the shape forceToolJson rejects. Different
   * cause, same must-not-throw. */
  it('names a malformed response rather than throwing', async () => {
    const log = quiet();
    const noToolCall = () =>
      ({
        messages: {
          async create() {
            return { content: [{ type: 'text', text: 'sure' }], usage: {} };
          },
        },
      }) as unknown as AgentClient;

    expect(await createInboundLaneScreen(noToolCall).read(READ)).toEqual({
      lane: 'in_domain',
      category: null,
      fallback: 'model_failed',
      language: null,
    });
    log.mockRestore();
  });

  /**
   * The adversarial path, and the reason the output schema is not `.strict()`.
   *
   * Anthropic does not hard-enforce a tool's input schema, so a parent can ask the model
   * for an extra JSON field and sometimes get one. A strict zod parse turns that into a
   * ZodError whose `.message` is the serialised issue list — and an `unrecognized_keys`
   * issue embeds the KEY NAMES. So "reply with a field named &lt;my sentence&gt;" would put a
   * parent's own words into `err.message`. The read's catch logs the error's name and
   * never its message, but a message that never holds the words is safe wherever it
   * travels (rule #1).
   *
   * Zod's default strips unknown keys instead, which is both the safer and the more
   * robust read: an extra field is not a reason to throw away a lane we can act on.
   */
  it('strips an unexpected field instead of turning it into a logged error', async () => {
    const injected = 'Mia has a rash and we are at Sick Kids';
    const log = quiet();

    const reading = await createInboundLaneScreen(
      clientReturning({
        lane: 'off_domain_general',
        category: 'weather',
        reason: 'forecast',
        [injected]: true,
      }),
    ).read(READ);

    expect(reading).toEqual({
      lane: 'off_domain_general',
      category: 'weather',
      fallback: null,
      language: null,
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('Mia');
    log.mockRestore();
  });

  /**
   * The error object from a provider can echo the request back, so the log keeps the
   * message string only. A parent's words must not reach a log aggregator (rule #1).
   */
  it.each([
    ['zh', '这周末有亲子活动吗'],
    ['ar', 'هل يوجد نشاط للأطفال هذا الأسبوع'],
  ])('returns the %s tag the model read on that inbound', async (tag, text) => {
    const screen = createInboundLaneScreen(
      clientReturning({ lane: 'in_domain', category: 'none', reason: 'family week', language: tag }),
    );

    expect(await screen.read(text)).toEqual({
      lane: 'in_domain',
      category: null,
      fallback: null,
      language: tag,
    });
  });

  it('never logs the message, on any path', async () => {
    const secret = 'is Mia contagious with hand foot and mouth';
    const log = quiet();

    await createInboundLaneScreen(outageClient).read(secret);
    await createInboundLaneScreen(throwingClient).read(secret);

    expect(JSON.stringify(log.mock.calls)).not.toContain('Mia');
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    log.mockRestore();
  });

  /**
   * The read is the one call here whose request holds the parent's text, and a provider
   * error can quote the request back in its MESSAGE. So a failed read is logged by the
   * error's name, and by why a structured answer was unusable, and by nothing else.
   */
  it('logs a failed read by the error name, never the provider message', async () => {
    const secret = 'is Mia contagious with hand foot and mouth';
    const echoing = (): AgentClient =>
      ({
        messages: {
          async create() {
            throw new Error(`400 invalid_request_error: {"text":"${secret}"}`);
          },
        },
      }) as unknown as AgentClient;
    const truncated = (): AgentClient =>
      ({
        messages: {
          async create() {
            return { content: [], stop_reason: 'max_tokens', usage: {} };
          },
        },
      }) as unknown as AgentClient;
    const log = quiet();

    await createInboundLaneScreen(echoing).read(secret);
    await createInboundLaneScreen(truncated).read(secret);

    expect(log.mock.calls).toEqual([
      [{ err: 'Error' }, 'off-domain screen: read failed'],
      [{ fallback: 'model_failed' }, 'off-domain screen: fell through to the coach'],
      [{ err: 'StructuredOutputError', outcome: 'truncated' }, 'off-domain screen: read failed'],
      [{ fallback: 'model_failed' }, 'off-domain screen: fell through to the coach'],
    ]);
    log.mockRestore();
  });
});
