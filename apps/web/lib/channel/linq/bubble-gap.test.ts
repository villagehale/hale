import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTurn, turnDeadlineSignal } from '~/lib/channel/router/deadline';
import { BUBBLE_GAP_MS, type BubbleGaps, OFF_TURN_GAP_BUDGET_MS, bubbleGaps } from './bubble-gap';
import { SEND_TIMEOUT_MS } from './transport';

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

/** The gaps for an iMessage chat. Throws if they are not paced, which would be the bug. */
function imessageGaps(log: Pick<Console, 'info' | 'warn'>): BubbleGaps {
  const gaps = bubbleGaps({ chatId: CHAT, service: 'iMessage', log });
  if (!gaps) throw new Error('an iMessage chat must be paced');
  return gaps;
}

const outcomes = (lines: unknown[][]) =>
  lines.flatMap(([fields]) =>
    fields && typeof fields === 'object' && 'outcome' in fields ? [fields.outcome] : [],
  );

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

describe('bubbleGaps', () => {
  it('is about two seconds', () => {
    expect(BUBBLE_GAP_MS).toBe(2_000);
  });

  it('puts typing up, then sends the bubble once the gap has passed', async () => {
    const { log } = quietLog();
    const start = Date.now();
    const sends: number[] = [];

    const sent = imessageGaps(log)(async () => {
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

  // Linq relays green-bubble SMS and RCS chats on the same line, and reports them as
  // `imessage` too. Only a chat Linq said is iMessage keeps several bubbles in order.
  it.each([['SMS'], ['RCS'], ['other'], [null], [undefined]] as const)(
    'a chat Linq said is %s is not paced',
    (service) => {
      const { log } = quietLog();
      expect(bubbleGaps({ chatId: CHAT, service, log })).toBeNull();
    },
  );

  it('near the turn deadline sends at once, with no typing, and names it', async () => {
    const { lines, log } = quietLog();
    const sends: number[] = [];
    const start = Date.now();

    // Ten seconds left: not enough for the pause and the send after it.
    const sent = await runTurn(turnDeadlineSignal(10_000), () =>
      imessageGaps(log)(async () => {
        sends.push(Date.now());
        return 'out-2';
      }),
    );

    expect(sent).toBe('out-2');
    expect(sends).toEqual([start]);
    expect(linq.calls).toEqual([]);
    expect(outcomes(lines)).toEqual(['deadline_near']);
  });

  it('positive control: with a minute left in the turn the gap is taken', async () => {
    const { lines, log } = quietLog();
    const sends: number[] = [];
    const start = Date.now();

    const sent = runTurn(turnDeadlineSignal(60_000), () =>
      imessageGaps(log)(async () => {
        sends.push(Date.now());
        return 'out-2';
      }),
    );
    await vi.advanceTimersByTimeAsync(BUBBLE_GAP_MS);

    expect(await sent).toBe('out-2');
    expect(sends).toEqual([start + 2_000]);
    expect(linq.calls.map((call) => call.what)).toEqual([`POST /chats/${CHAT}/typing`]);
    expect(outcomes(lines)).toEqual([]);
  });

  it('a bubble that does not go clears typing and rethrows the send’s own error', async () => {
    const { log } = quietLog();
    const refused = new Error('provider refused');

    const sent = imessageGaps(log)(async () => {
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

/**
 * Outside a router turn (intake's map inside Linq's webhook, a notice in the drain) no
 * turn deadline bounds the set, so the set's own budget does.
 */
describe('bubbleGaps outside a turn', () => {
  it('spends at most the budget on one set: then the next bubble goes at once and says why', async () => {
    expect(OFF_TURN_GAP_BUDGET_MS).toBe(2 * BUBBLE_GAP_MS);
    const { lines, log } = quietLog();
    const gaps = imessageGaps(log);
    const start = Date.now();
    const sends: number[] = [];
    const send = async () => {
      sends.push(Date.now());
    };

    const set = (async () => {
      await gaps(send);
      await gaps(send);
      await gaps(send);
    })();
    await vi.advanceTimersByTimeAsync(3 * BUBBLE_GAP_MS);
    await set;

    expect(sends).toEqual([start + 2_000, start + 4_000, start + 4_000]);
    expect(linq.calls.map((call) => call.at)).toEqual([start, start + 2_000]);
    expect(outcomes(lines)).toEqual(['gap_budget_spent']);
  });

  it('a typing call Linq holds does not stretch the pause past the budget', async () => {
    const { log } = quietLog();
    // Linq never answers the typing call; the client gives up at SEND_TIMEOUT_MS.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            );
          }),
      ),
    );
    const start = Date.now();
    const sends: number[] = [];

    const sent = imessageGaps(log)(async () => {
      sends.push(Date.now());
    });
    await vi.advanceTimersByTimeAsync(OFF_TURN_GAP_BUDGET_MS);
    expect(sends).toEqual([start + OFF_TURN_GAP_BUDGET_MS]);
    // Let the held typing call reach its own timeout, so nothing outlives the test.
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS);
    await sent;
  });

  it('positive control: inside a turn the set budget does not apply, the turn deadline does', async () => {
    const { lines, log } = quietLog();
    const gaps = imessageGaps(log);
    const start = Date.now();
    const sends: number[] = [];
    const send = async () => {
      sends.push(Date.now());
    };

    const set = runTurn(turnDeadlineSignal(60_000), async () => {
      await gaps(send);
      await gaps(send);
      await gaps(send);
    });
    await vi.advanceTimersByTimeAsync(3 * BUBBLE_GAP_MS);
    await set;

    expect(sends).toEqual([start + 2_000, start + 4_000, start + 6_000]);
    expect(outcomes(lines)).toEqual([]);
  });
});
