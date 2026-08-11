import type { AgentClient } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
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
            content: [{ type: 'tool_use', name: 'lane', input }],
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
    });
  });

  it('drops the category for an in-domain reading — it is not an unmet intent', () => {
    expect(toReading({ lane: 'in_domain', category: 'weather' })).toEqual({
      lane: 'in_domain',
      category: null,
      fallback: null,
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
    });
    log.mockRestore();
  });

  it('buckets a category it cannot read as other, and still deflects', () => {
    expect(toReading({ lane: 'off_domain_general', category: 'crypto-prices' })).toEqual({
      lane: 'off_domain_general',
      category: 'other',
      fallback: null,
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
});

describe('createInboundLaneScreen · every failure hands the turn to the coach', () => {
  const READ = 'is there a good park nearby';

  it('reads a lane when the model answers', async () => {
    const screen = createInboundLaneScreen(
      clientReturning({ lane: 'off_domain_general', category: 'weather', reason: 'forecast' }),
    );

    expect(await screen.read(READ)).toEqual({
      lane: 'off_domain_general',
      category: 'weather',
      fallback: null,
    });
  });

  it('names a missing client rather than throwing', async () => {
    const log = quiet();
    expect(await createInboundLaneScreen(throwingClient).read(READ)).toEqual({
      lane: 'in_domain',
      category: null,
      fallback: 'client_unavailable',
    });
    log.mockRestore();
  });

  it('names a provider outage rather than throwing', async () => {
    const log = quiet();
    expect(await createInboundLaneScreen(outageClient).read(READ)).toEqual({
      lane: 'in_domain',
      category: null,
      fallback: 'model_failed',
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
    });
    log.mockRestore();
  });

  /**
   * The error object from a provider can echo the request back, so the log keeps the
   * message string only. A parent's words must not reach a log aggregator (rule #1).
   */
  it('never logs the message, on any path', async () => {
    const secret = 'is Mia contagious with hand foot and mouth';
    const log = quiet();

    await createInboundLaneScreen(outageClient).read(secret);
    await createInboundLaneScreen(throwingClient).read(secret);

    expect(JSON.stringify(log.mock.calls)).not.toContain('Mia');
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    log.mockRestore();
  });
});
