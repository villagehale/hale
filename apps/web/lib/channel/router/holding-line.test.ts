import type { AgentClient } from '@hale/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { structuredReply } from '~/lib/testing/structured-reply';
import {
  type HoldingLineComposer,
  MAX_COMPOSE_ATTEMPTS,
  armHoldingLine,
  createHoldingLine,
  holdingLineUserMessage,
  refusals,
} from './holding-line';

/**
 * The holding line's gates, its request shape and its timing. What the model WRITES is the
 * cached eval's job (run-holding-line-eval.mjs, rule #8); these drive only what the code
 * does with an answer it has already been handed.
 */

afterEach(() => {
  vi.useRealTimers();
});

describe('what may not be sent as a holding line', () => {
  it('passes the shape the skill asks for', () => {
    expect(refusals("I'm on it - your answer is coming.")).toEqual([]);
    expect(refusals("J'y travaille, la réponse arrive.")).toEqual([]);
  });

  it.each([
    ['nothing at all', '', 'empty'],
    ['two sentences', "I'm on it. Your answer is coming.", 'not_one_sentence'],
    ['a question', "I'm on it - can you hold on?", 'carries_question'],
    ['a number', "I'm on it, give me 2 minutes.", 'carries_number'],
    ['a promised time', "I'm on it and will have it shortly.", 'promised_a_time'],
    ['a link', "I'm on it, see https://villagehale.com meanwhile.", 'carries_link'],
    ['an app pointer', "I'm on it, your week is in the app.", 'points_at_the_app'],
  ])('refuses %s', (_name, body, reason) => {
    expect(refusals(body)).toContain(reason);
  });

  it('refuses a line that needs more than one text', () => {
    expect(refusals(`I'm on it ${'and still working through your answer '.repeat(5)}`)).toContain(
      'over_one_segment',
    );
  });
});

describe('the request the model gets', () => {
  it('carries the situation and the language, and nothing the parent wrote', () => {
    expect(JSON.parse(holdingLineUserMessage('fr'))).toEqual({
      situation: 'answer_still_coming',
      language: 'fr',
    });
  });
});

function clientSaying(lines: string[], seen: unknown[] = []): () => AgentClient {
  const queue = [...lines];
  return () =>
    ({
      messages: {
        create: vi.fn(async (request: unknown) => {
          seen.push(request);
          return structuredReply(request, 'holding_line', { line: queue.shift() ?? '' });
        }),
      },
    }) as unknown as AgentClient;
}

describe('createHoldingLine', () => {
  it('composes a sendable line', async () => {
    const outcome = await createHoldingLine(clientSaying(["I'm on it."])).compose('en');
    expect(outcome).toEqual({ status: 'composed', line: "I'm on it." });
  });

  it('hands a refused line back with its reasons, and names the gate when it never passes', async () => {
    const seen: unknown[] = [];
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outcome = await createHoldingLine(
      clientSaying(['On it. Back soon?', 'On it. Back soon?', 'On it. Back soon?'], seen),
    ).compose('en');
    expect(outcome).toEqual({ status: 'unavailable', reason: 'gate_exhausted' });
    expect(seen).toHaveLength(MAX_COMPOSE_ATTEMPTS);
    const second = seen[1] as { messages: { content: string }[] };
    expect(JSON.parse(second.messages[0]?.content ?? '{}').rejected[0].problems).toEqual(
      expect.arrayContaining(['not_one_sentence', 'carries_question']),
    );
    quiet.mockRestore();
  });

  it('names a missing client rather than throwing', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outcome = await createHoldingLine(() => {
      throw new Error('no key');
    }).compose('en');
    expect(outcome).toEqual({ status: 'unavailable', reason: 'client_unavailable' });
    quiet.mockRestore();
  });
});

const log = () => ({ info: vi.fn(), warn: vi.fn() });

function composer(line: string | null): HoldingLineComposer & { calls: number } {
  const c = {
    calls: 0,
    async compose() {
      c.calls += 1;
      return line === null
        ? ({ status: 'unavailable', reason: 'model_failed' } as const)
        : ({ status: 'composed', line } as const);
    },
  };
  return c;
}

describe('armHoldingLine — one line, only on a slow turn', () => {
  it('a slow turn: sends ONE line once the wait passes, and the answer waits for it', async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const holding = armHoldingLine({
      afterMs: 8_000,
      language: 'en',
      composer: composer("I'm on it."),
      send: async (line) => {
        sent.push(line);
      },
      log: log(),
    });
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await holding.settle()).toBe('sent');
    expect(sent).toEqual(["I'm on it."]);
  });

  it('a fast turn: the answer settles it first and no line is composed or sent', async () => {
    vi.useFakeTimers();
    const c = composer("I'm on it.");
    const send = vi.fn();
    const holding = armHoldingLine({
      afterMs: 8_000,
      language: 'en',
      composer: c,
      send,
      log: log(),
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await holding.settle()).toBe('answered_first');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(c.calls).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('an answer that lands while the line is being composed wins, and the line is dropped', async () => {
    vi.useFakeTimers();
    let release: (() => void) | null = null;
    const slow: HoldingLineComposer = {
      compose: () =>
        new Promise((resolve) => {
          release = () => resolve({ status: 'composed', line: "I'm on it." });
        }),
    };
    const send = vi.fn();
    const holding = armHoldingLine({
      afterMs: 8_000,
      language: 'en',
      composer: slow,
      send,
      log: log(),
    });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await holding.settle()).toBe('answered_first');
    (release as unknown as () => void)();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('a line that cannot be composed is a named outcome and nothing is sent', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const l = log();
    const holding = armHoldingLine({
      afterMs: 8_000,
      language: 'en',
      composer: composer(null),
      send,
      log: l,
    });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await holding.settle()).toBe('compose_failed');
    expect(send).not.toHaveBeenCalled();
    expect(l.warn).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'compose_failed', reason: 'model_failed' }),
      expect.any(String),
    );
  });

  it('settling twice never sends a second line', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => undefined);
    const holding = armHoldingLine({
      afterMs: 8_000,
      language: 'en',
      composer: composer("I'm on it."),
      send,
      log: log(),
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await holding.settle();
    await holding.settle();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
