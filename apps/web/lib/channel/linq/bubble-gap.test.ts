import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTurn, turnDeadlineSignal } from '~/lib/channel/router/deadline';
import { BUBBLE_GAP_MS, sendAfterBubbleGap } from './bubble-gap';

/**
 * The pause before the next bubble of one message on iMessage (VIL-682 K5): typing up,
 * about two seconds, then the bubble. Linq is reached through a stubbed fetch, so the
 * typing call under test is the real one, not a stand-in.
 */

const CHAT = 'chat-1';

type Call = { at: number; what: string };

function linqRecorder() {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.replace(/^.*\/chats\//, '/chats/');
    calls.push({ at: Date.now(), what: `${init?.method} ${path}` });
    return new Response(null, { status: 204 });
  });
  return { calls, fetch };
}

function quietLog() {
  const lines: unknown[][] = [];
  return {
    lines,
    log: {
      info: (...args: unknown[]) => lines.push(args),
      warn: (...args: unknown[]) => lines.push(args),
    } as unknown as Pick<Console, 'info' | 'warn'>,
  };
}

let linq: ReturnType<typeof linqRecorder>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  linq = linqRecorder();
  vi.stubGlobal('fetch', linq.fetch);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('sendAfterBubbleGap', () => {
  it('is about two seconds', () => {
    expect(BUBBLE_GAP_MS).toBe(2_000);
  });

  it('puts typing up, then sends the bubble once the gap has passed', async () => {
    const { log } = quietLog();
    const start = Date.now();
    const sends: number[] = [];

    const sent = sendAfterBubbleGap({ chatId: CHAT, log }, async () => {
      sends.push(Date.now());
      return 'out-2';
    });

    await vi.advanceTimersByTimeAsync(BUBBLE_GAP_MS - 1);
    expect(sends).toEqual([]);
    expect(linq.calls).toEqual([{ at: start, what: `POST /chats/${CHAT}/typing` }]);

    await vi.advanceTimersByTimeAsync(1);
    expect(await sent).toBe('out-2');
    expect(sends).toEqual([start + 2_000]);
  });

  it('near the turn deadline sends at once, with no typing, and names it', async () => {
    const { lines, log } = quietLog();
    const sends: number[] = [];
    const start = Date.now();

    // Ten seconds left: not enough for the pause and the send after it.
    const sent = await runTurn(turnDeadlineSignal(10_000), () =>
      sendAfterBubbleGap({ chatId: CHAT, log }, async () => {
        sends.push(Date.now());
        return 'out-2';
      }),
    );

    expect(sent).toBe('out-2');
    expect(sends).toEqual([start]);
    expect(linq.calls).toEqual([]);
    expect(lines).toContainEqual([
      expect.objectContaining({ outcome: 'deadline_near' }),
      expect.any(String),
    ]);
  });

  it('positive control: with a minute left in the turn the gap is taken', async () => {
    const { lines, log } = quietLog();
    const sends: number[] = [];
    const start = Date.now();

    const sent = runTurn(turnDeadlineSignal(60_000), () =>
      sendAfterBubbleGap({ chatId: CHAT, log }, async () => {
        sends.push(Date.now());
        return 'out-2';
      }),
    );
    await vi.advanceTimersByTimeAsync(BUBBLE_GAP_MS);

    expect(await sent).toBe('out-2');
    expect(sends).toEqual([start + 2_000]);
    expect(linq.calls.map((call) => call.what)).toEqual([`POST /chats/${CHAT}/typing`]);
    expect(lines.flat()).not.toContainEqual(expect.objectContaining({ outcome: 'deadline_near' }));
  });

  it('a bubble that does not go clears typing and rethrows the send’s own error', async () => {
    const { log } = quietLog();
    const refused = new Error('provider refused');

    const sent = sendAfterBubbleGap({ chatId: CHAT, log }, async () => {
      throw refused;
    });
    const settled = sent.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(BUBBLE_GAP_MS);

    expect(await settled).toBe(refused);
    expect(linq.calls.map((call) => call.what)).toEqual([
      `POST /chats/${CHAT}/typing`,
      `DELETE /chats/${CHAT}/typing`,
    ]);
  });
});
