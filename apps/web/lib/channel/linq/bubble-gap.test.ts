import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTurn, turnDeadlineSignal } from '~/lib/channel/router/deadline';
import {
  BUBBLE_GAP_MS,
  type BubbleGaps,
  OFF_TURN_GAPS,
  bubbleGaps,
  readBubbleGaps,
  sentUnlessThrown,
} from './bubble-gap';
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
function imessageGaps(log: Pick<Console, 'info' | 'warn'>, answerBy?: Date): BubbleGaps {
  const gaps = bubbleGaps({ chatId: CHAT, service: 'iMessage', log, answerBy });
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
    }, sentUnlessThrown);

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
      }, sentUnlessThrown),
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
      }, sentUnlessThrown),
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
    }, sentUnlessThrown);
    const settled = sent.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(BUBBLE_GAP_MS);

    expect(await settled).toBe(refused);
    expect(linq.calls.map((call) => call.what)).toEqual([
      `POST /chats/${CHAT}/typing`,
      `DELETE /chats/${CHAT}/typing`,
    ]);
  });

  // A refusal handed back as a value (a permanent Linq refusal, a link that did not go) is
  // a bubble that did not go too: typing must not stay up with nothing after it.
  it('a send that returns without going clears typing and hands back its result', async () => {
    const { log } = quietLog();
    const refusal = { status: 'not_sent' as const };

    const sent = imessageGaps(log)(
      async (): Promise<{ status: 'sent' | 'not_sent' }> => refusal,
      (result) => result.status === 'sent',
    );
    await vi.advanceTimersByTimeAsync(BUBBLE_GAP_MS);

    expect(await sent).toBe(refusal);
    expect(linq.calls.map((call) => call.what)).toEqual([
      `POST /chats/${CHAT}/typing`,
      `DELETE /chats/${CHAT}/typing`,
    ]);
  });

  it('a typing start Linq answers late is not overtaken by its stop', async () => {
    const { log } = quietLog();
    const start = Date.now();
    const calls: Array<[number, string]> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        calls.push([Date.now() - start, `${init?.method} sent`]);
        if (init?.method === 'POST') await new Promise((resolve) => setTimeout(resolve, 3_000));
        calls.push([Date.now() - start, `${init?.method} answered`]);
        return new Response(null, { status: 204 });
      }),
    );

    const sent = imessageGaps(log)(
      async (): Promise<{ status: 'sent' | 'not_sent' }> => ({ status: 'not_sent' }),
      (result) => result.status === 'sent',
    );
    await vi.advanceTimersByTimeAsync(3_000);
    await sent;

    expect(calls).toEqual([
      [0, 'POST sent'],
      [3_000, 'POST answered'],
      [3_000, 'DELETE sent'],
      [3_000, 'DELETE answered'],
    ]);
  });

  it('positive control: a send that went leaves typing to the bubble itself', async () => {
    const { log } = quietLog();

    const sent = imessageGaps(log)(
      async (): Promise<{ status: 'sent' | 'not_sent' }> => ({ status: 'sent' }),
      (result) => result.status === 'sent',
    );
    await vi.advanceTimersByTimeAsync(BUBBLE_GAP_MS);

    expect(await sent).toEqual({ status: 'sent' });
    expect(linq.calls.map((call) => call.what)).toEqual([`POST /chats/${CHAT}/typing`]);
  });
});

/**
 * A notice in the drain runs outside any turn and any webhook: the set's own count of gaps
 * bounds it. The count is planned, not timed, so timer slack can never skip a gap.
 */
describe('bubbleGaps outside a turn or a webhook', () => {
  it('adds at most two gaps to one set: then the next bubble goes at once and says why', async () => {
    expect(OFF_TURN_GAPS).toBe(2);
    const { lines, log } = quietLog();
    const gaps = imessageGaps(log);
    const start = Date.now();
    const sends: number[] = [];
    const send = async () => {
      sends.push(Date.now());
    };

    // Four bubbles: the first goes before the pacer, so three are paced.
    const set = (async () => {
      await gaps(send, sentUnlessThrown);
      await gaps(send, sentUnlessThrown);
      await gaps(send, sentUnlessThrown);
    })();
    await vi.advanceTimersByTimeAsync(3 * BUBBLE_GAP_MS);
    await set;

    expect(sends).toEqual([start + 2_000, start + 4_000, start + 4_000]);
    expect(linq.calls.map((call) => call.at)).toEqual([start, start + 2_000]);
    expect(outcomes(lines)).toEqual(['gap_budget_spent']);
  });

  it('a typing call Linq holds does not stretch the pause past the gap', async () => {
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
    }, sentUnlessThrown);
    await vi.advanceTimersByTimeAsync(BUBBLE_GAP_MS);
    expect(sends).toEqual([start + BUBBLE_GAP_MS]);
    // Let the held typing call reach its own timeout, so nothing outlives the test.
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS);
    await sent;
  });

  it('positive control: inside a turn the count does not apply, the turn deadline does', async () => {
    const { lines, log } = quietLog();
    const gaps = imessageGaps(log);
    const start = Date.now();
    const sends: number[] = [];
    const send = async () => {
      sends.push(Date.now());
    };

    const set = runTurn(turnDeadlineSignal(60_000), async () => {
      await gaps(send, sentUnlessThrown);
      await gaps(send, sentUnlessThrown);
      await gaps(send, sentUnlessThrown);
    });
    await vi.advanceTimersByTimeAsync(3 * BUBBLE_GAP_MS);
    await set;

    expect(sends).toEqual([start + 2_000, start + 4_000, start + 6_000]);
    expect(outcomes(lines)).toEqual([]);
  });
});

/**
 * Intake's map goes out inside Linq's webhook, which Linq stops waiting for at its
 * response timeout. A gap is taken only when it and the bubble's own send both fit before
 * that moment.
 */
describe('bubbleGaps inside Linq’s webhook', () => {
  it.each([
    ['less than the gap', BUBBLE_GAP_MS - 1],
    ['the gap, with no time for the send after it', BUBBLE_GAP_MS + 1],
    ['all but a millisecond of the gap and the send', BUBBLE_GAP_MS + SEND_TIMEOUT_MS - 1],
  ])('with %s left, the gap is skipped, with no typing, and named', async (_label, leftMs) => {
    const { lines, log } = quietLog();
    const start = Date.now();
    const sends: number[] = [];

    const sent = imessageGaps(log, new Date(start + leftMs))(async () => {
      sends.push(Date.now());
    }, sentUnlessThrown);
    await vi.advanceTimersByTimeAsync(BUBBLE_GAP_MS);
    await sent;

    expect(sends).toEqual([start]);
    expect(linq.calls).toEqual([]);
    expect(outcomes(lines)).toEqual(['deadline_near']);
  });

  it('positive control: the deadline bounds the set, not the gap count', async () => {
    const { lines, log } = quietLog();
    const start = Date.now();
    // Room for three gaps, the last of them with exactly its send's time after it.
    const gaps = imessageGaps(log, new Date(start + 3 * BUBBLE_GAP_MS + SEND_TIMEOUT_MS));
    const sends: number[] = [];
    const send = async () => {
      sends.push(Date.now());
    };

    const set = (async () => {
      for (let i = 0; i < 4; i += 1) await gaps(send, sentUnlessThrown);
    })();
    await vi.advanceTimersByTimeAsync(4 * BUBBLE_GAP_MS);
    await set;

    // Three gaps fit with their sends before the deadline (one more than the count would
    // allow); the fourth would leave its send too little time.
    expect(sends).toEqual([start + 2_000, start + 4_000, start + 6_000, start + 6_000]);
    expect(outcomes(lines)).toEqual(['deadline_near']);
  });
});

/**
 * Where a set reads its chat's service from the ledger, that read only decides the pacing:
 * a read that fails must never stop a send.
 */
describe('readBubbleGaps', () => {
  it('a service read that fails leaves the set unpaced and names it', async () => {
    const { lines, log } = quietLog();
    const gaps = await readBubbleGaps({
      chatId: CHAT,
      readService: async () => {
        throw new Error('connection reset');
      },
      log,
    });

    expect(gaps).toBeNull();
    expect(outcomes(lines)).toEqual(['pacing_read_failed']);
  });

  it('positive control: a read that says iMessage paces the set, with nothing logged', async () => {
    const { lines, log } = quietLog();
    const gaps = await readBubbleGaps({ chatId: CHAT, readService: async () => 'iMessage', log });
    if (!gaps) throw new Error('an iMessage chat must be paced');
    const start = Date.now();
    const sends: number[] = [];

    const sent = gaps(async () => {
      sends.push(Date.now());
    }, sentUnlessThrown);
    await vi.advanceTimersByTimeAsync(BUBBLE_GAP_MS);
    await sent;

    expect(sends).toEqual([start + BUBBLE_GAP_MS]);
    expect(outcomes(lines)).toEqual([]);
  });
});

/**
 * The gate on round 2 found that on a real clock only the first gap ever ran: the budget
 * was measured with Date.now() around a real setTimeout, and timer slack spent it. No fake
 * timers here.
 */
describe('bubbleGaps on a real clock', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it(
    'every gap of a three-bubble set outside a turn runs',
    async () => {
      const { lines, log } = quietLog();
      const gaps = imessageGaps(log);
      const sends = [Date.now()];
      const send = async () => {
        sends.push(Date.now());
      };

      await gaps(send, sentUnlessThrown);
      await gaps(send, sentUnlessThrown);

      expect(sends).toHaveLength(3);
      const between = sends.slice(1).map((at, i) => at - (sends[i] as number));
      for (const gap of between) expect(gap).toBeGreaterThanOrEqual(1_900);
      expect(outcomes(lines)).toEqual([]);
    },
    3 * BUBBLE_GAP_MS + 5_000,
  );
});
