import { readFileSync } from 'node:fs';
import type { AgentClient } from '@hale/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isStage, structuredReply } from '~/lib/testing/structured-reply';
import { HOLDING_LINE_JUDGE_TOOL } from './holding-line-judge';

const skillLoad = vi.hoisted(() => ({
  error: null as Error | null,
  failName: null as string | null,
}));
vi.mock('~/lib/cron/skill', async (actual) => {
  const real = await actual<typeof import('~/lib/cron/skill')>();
  return {
    ...real,
    loadCronSkill: async (name: string) => {
      if (skillLoad.failName === name) throw new Error('echo: her daughter is wheezing');
      if (skillLoad.error) throw skillLoad.error;
      return real.loadCronSkill(name);
    },
  };
});
import {
  HOLDING_LINE_ENABLED_ENV,
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
    expect(refusals('我在处理，答复会来。')).toEqual([]);
  });

  // A time or an app is meaning, in any language. These used to be English patterns.
  it.each([
    ['an English time', "I'm on it and will have it shortly."],
    ['an English app', "I'm on it, your week is in the app."],
    ['a French time', "Je m'en occupe, ce sera bientôt prêt."],
    ['a French app', "Je m'en occupe. C'est dans l'application."],
    ['a Chinese time', '我马上就回你。'],
    ['a Chinese website', '详情在网站上。'],
  ])('does not decide %s by pattern', (_name, body) => {
    expect(refusals(body)).toEqual([]);
  });

  it.each([
    ['nothing at all', '', 'empty'],
    ['a number', "I'm on it, give me 2 minutes.", 'carries_number'],
    ['a link', "I'm on it, see https://villagehale.com meanwhile.", 'carries_link'],
  ])('refuses %s', (_name, body, reason) => {
    expect(refusals(body)).toContain(reason);
  });

  // Only facts are gated. How the line is worded — its sentences, a question, its length —
  // is the model's, and a long line is the transport's to split, never a refusal.
  it.each([
    ['two sentences', "I'm on it. Your answer is coming."],
    ['a question', "I'm on it - you good to hang on?"],
    [
      'a line longer than one text',
      `I'm on it ${'and still working through your answer '.repeat(5)}`,
    ],
  ])('sends %s as written', (_name, body) => {
    expect(refusals(body)).toEqual([]);
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

type ScriptedJudge =
  | { promises_a_time: 'yes' | 'no'; points_at_an_app: 'yes' | 'no' }
  | 'throw'
  | 'garbage';

function userText(request: unknown): string {
  const content = (request as { messages?: { content?: unknown }[] }).messages?.[0]?.content;
  return typeof content === 'string' ? content : '';
}

function clientSaying(
  lines: string[],
  seen: unknown[] = [],
  judge: ScriptedJudge | ((line: string) => ScriptedJudge) = {
    promises_a_time: 'no',
    points_at_an_app: 'no',
  },
): () => AgentClient {
  const queue = [...lines];
  return () =>
    ({
      messages: {
        create: vi.fn(async (request: unknown) => {
          seen.push(request);
          if (isStage(request, HOLDING_LINE_JUDGE_TOOL, 'promises_a_time')) {
            const script = typeof judge === 'function' ? judge(userText(request)) : judge;
            if (script === 'throw') throw new Error('echo: her daughter is wheezing');
            const verdict =
              script === 'garbage'
                ? { reason: '', promises_a_time: 'maybe', points_at_an_app: 'no' }
                : { reason: 'scripted', ...script };
            return structuredReply(request, HOLDING_LINE_JUDGE_TOOL, verdict);
          }
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
      clientSaying(['On it, back in 2.', 'On it, back in 2.'], seen),
    ).compose('en');
    expect(outcome).toEqual({ status: 'unavailable', reason: 'gate_exhausted' });
    expect(seen).toHaveLength(MAX_COMPOSE_ATTEMPTS);
    expect(
      seen.some((request) => isStage(request, HOLDING_LINE_JUDGE_TOOL, 'promises_a_time')),
    ).toBe(false);
    const second = seen[1] as { messages: { content: string }[] };
    expect(JSON.parse(second.messages[0]?.content ?? '{}').rejected[0].problems).toEqual([
      'carries_number',
    ]);
    quiet.mockRestore();
  });

  it('asks the judge before a mechanically clean line goes out, and sends that line', async () => {
    const seen: unknown[] = [];
    const outcome = await createHoldingLine(clientSaying(["I'm on it."], seen)).compose('en');
    expect(outcome).toEqual({ status: 'composed', line: "I'm on it." });
    const judged = seen.filter((request) =>
      isStage(request, HOLDING_LINE_JUDGE_TOOL, 'promises_a_time'),
    );
    expect(judged).toHaveLength(1);
    expect(JSON.parse(userText(judged[0] ?? {})).line).toBe("I'm on it.");
  });

  it('feeds a judged time or app back, and sends nothing when the gate never clears', async () => {
    const seen: unknown[] = [];
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outcome = await createHoldingLine(
      clientSaying(["Je m'en occupe, ce sera bientôt prêt.", '详情在网站上。'], seen, (user) =>
        user.includes('网站')
          ? { promises_a_time: 'no', points_at_an_app: 'yes' }
          : { promises_a_time: 'yes', points_at_an_app: 'no' },
      ),
    ).compose('fr');
    expect(outcome).toEqual({ status: 'unavailable', reason: 'gate_exhausted' });
    expect(outcome).not.toHaveProperty('line');
    const writers = seen.filter((request) => isStage(request, 'holding_line', 'line'));
    expect(writers).toHaveLength(MAX_COMPOSE_ATTEMPTS);
    expect(JSON.parse(userText(writers[1] ?? '{}')).rejected[0].problems).toEqual([
      'promised_a_time',
    ]);
    expect(JSON.stringify(outcome)).not.toContain('网站');
    quiet.mockRestore();
  });

  it('sends nothing when the judge errors, and does not substitute a line', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: unknown[] = [];
    const outcome = await createHoldingLine(clientSaying(["I'm on it."], seen, 'throw')).compose(
      'en',
    );
    expect(outcome).toEqual({ status: 'unavailable', reason: 'judge_failed' });
    expect(outcome).not.toHaveProperty('line');
    expect(seen.filter((request) => isStage(request, 'holding_line', 'line'))).toHaveLength(1);
    expect(JSON.stringify(quiet.mock.calls)).not.toContain("I'm on it.");
    expect(JSON.stringify(quiet.mock.calls)).not.toContain('wheezing');
    quiet.mockRestore();
  });

  it('sends nothing when the judge skill cannot be loaded', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    skillLoad.failName = 'holding-line-judge';
    try {
      const outcome = await createHoldingLine(clientSaying(["I'm on it."])).compose('en');
      expect(outcome).toEqual({ status: 'unavailable', reason: 'judge_unavailable' });
      expect(quiet.mock.calls).toEqual([
        [{ reason: 'judge_unavailable', detail: undefined }, 'holding line: no line composed'],
      ]);
    } finally {
      skillLoad.failName = null;
      quiet.mockRestore();
    }
  });

  it('names a missing client rather than throwing', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outcome = await createHoldingLine(() => {
      throw new Error('no key');
    }).compose('en');
    expect(outcome).toEqual({ status: 'unavailable', reason: 'client_unavailable' });
    quiet.mockRestore();
  });

  // A provider error can carry the request back; the log names the reason, never the text.
  it.each([
    [
      'client_unavailable',
      () => {
        throw new Error('echo: her daughter is wheezing');
      },
    ],
    ['skill_unavailable', () => ({}) as AgentClient],
    [
      'model_failed',
      () =>
        ({
          messages: {
            create: vi.fn(async () => {
              throw new Error('echo: her daughter is wheezing');
            }),
          },
        }) as unknown as AgentClient,
    ],
  ] as const)('logs %s by name, without the provider message', async (reason, client) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    if (reason === 'skill_unavailable')
      skillLoad.error = new Error('echo: her daughter is wheezing');
    try {
      const outcome = await createHoldingLine(client).compose('en');
      expect(outcome).toEqual({ status: 'unavailable', reason });
      expect(log.mock.calls).toEqual([[{ reason }, 'holding line: no line composed']]);
    } finally {
      skillLoad.error = null;
      log.mockRestore();
    }
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

describe('the composer does not keep an English time or app pattern', () => {
  it('names neither pattern', () => {
    const src = readFileSync(new URL('./holding-line.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/PROMISED_TIME|APP_POINTER/);
    expect(src).not.toMatch(/\b(shortly|momentarily|jiffy|dashboard|villagehale)\b/i);
    expect(src).not.toMatch(/\w+\|\w+/);
  });
});

describe('armHoldingLine — one line, only on a slow turn', () => {
  beforeEach(() => {
    vi.stubEnv(HOLDING_LINE_ENABLED_ENV, 'true');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('dark unless HOLDING_LINE_ENABLED is exactly true: composes nothing and settles as lane_off', async () => {
    vi.stubEnv(HOLDING_LINE_ENABLED_ENV, 'True');
    vi.useFakeTimers();
    const c = composer("I'm on it.");
    const send = vi.fn();
    const l = log();
    const holding = armHoldingLine({ afterMs: 8_000, language: 'en', composer: c, send, log: l });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await holding.settle()).toBe('lane_off');
    expect(c.calls).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(l.info).toHaveBeenCalledWith({ outcome: 'lane_off' }, expect.any(String));
  });

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
