import { turnRemainingMs } from '~/lib/channel/router/deadline';
import type { ReplyRoute } from '~/lib/channel/router/reply-route';
import { signalImessageTyping } from './presence';
import { type LinqChatService, SEND_TIMEOUT_MS } from './transport';

/**
 * The pause before the next bubble of one message on iMessage (VIL-682 K5): about as long
 * as a person takes to type a short line, so several bubbles arrive one by one instead of
 * all at once.
 */
export const BUBBLE_GAP_MS = 2_000;

/**
 * The most the gaps may add to one set of bubbles outside a router turn. Intake's activity
 * map goes out inside Linq's webhook (see SEND_TIMEOUT_MS), and a notice holds a drain
 * job: two gaps, then any later bubble of the set goes at once.
 */
export const OFF_TURN_GAP_BUDGET_MS = 2 * BUBBLE_GAP_MS;

/** Sends one bubble of a set after the gap. The set's first bubble is not passed here. */
export type BubbleGaps = <T>(send: () => Promise<T>) => Promise<T>;

/**
 * The gaps for one set of bubbles on one chat, or null when the chat is not paced.
 *
 * Only a chat Linq said is iMessage (`service`) is paced. Linq relays green-bubble SMS and
 * RCS chats on the same line and reports them as `imessage`, so the transport cannot say.
 * Null or absent: Linq did not say, which is not a yes.
 *
 * Typing starts first and the gap runs beside that call. The send waits for both, so typing
 * never lands after the bubble it stands for. A send clears typing on its own; a send that
 * throws clears it here, so a set that stops partway does not leave Hale typing. A typing
 * call that fails is logged and the bubble still goes.
 *
 * Inside a router turn the gap comes out of the turn's deadline: with too little left for
 * the pause and the send after it, the bubble goes at once and `deadline_near` is logged.
 * Outside a turn the set spends at most {@link OFF_TURN_GAP_BUDGET_MS}: no pause outlasts
 * what is left of it, even one a slow typing call holds, and once it is spent the bubble
 * goes at once and `gap_budget_spent` is logged.
 */
export function bubbleGaps(input: {
  chatId: string;
  service: LinqChatService | null | undefined;
  log: Pick<Console, 'info' | 'warn'>;
  /** Test seam. Production uses {@link BUBBLE_GAP_MS}. */
  gapMs?: number;
}): BubbleGaps | null {
  if (input.service !== 'iMessage') return null;
  const gapMs = input.gapMs ?? BUBBLE_GAP_MS;
  const log = input.log;
  // `to` is unused: the typing call is the chat id (as in presence.ts).
  const route: ReplyRoute = {
    channel: 'imessage',
    to: '',
    chatId: input.chatId,
    replyToMessageId: null,
  };
  let spentMs = 0;
  return async (send) => {
    const turnLeft = turnRemainingMs();
    // The pause lasts as long as the gap or the typing call, and Linq stops that call at
    // SEND_TIMEOUT_MS. The bubble's own send can take as long again.
    if (turnLeft !== undefined && turnLeft < Math.max(gapMs, SEND_TIMEOUT_MS) + SEND_TIMEOUT_MS) {
      log.info(
        { outcome: 'deadline_near', remainingMs: turnLeft },
        'bubbles: the next bubble goes without the gap',
      );
      return send();
    }
    const budgetLeft = turnLeft === undefined ? OFF_TURN_GAP_BUDGET_MS - spentMs : null;
    if (budgetLeft !== null && budgetLeft < gapMs) {
      log.info(
        { outcome: 'gap_budget_spent', spentMs, budgetMs: OFF_TURN_GAP_BUDGET_MS },
        'bubbles: the next bubble goes without the gap',
      );
      return send();
    }
    const started = Date.now();
    const pause = Promise.all([typing(route, 'start', log), sleep(gapMs)]);
    await (budgetLeft === null ? pause : within(pause, budgetLeft));
    spentMs += Date.now() - started;
    try {
      return await send();
    } catch (err) {
      await typing(route, 'stop', log);
      throw err;
    }
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves when `work` does or when `ms` passes, whichever is first. */
function within(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work.then(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** A typing call that cannot stop the bubble or replace the send's own error: the caller
 * decides whether to retry from that error. Every miss is logged. */
async function typing(
  route: ReplyRoute,
  phase: 'start' | 'stop',
  log: Pick<Console, 'warn'>,
): Promise<void> {
  try {
    await signalImessageTyping(route, phase, log);
  } catch (err) {
    log.warn(
      { phase, err: err instanceof Error ? err.name : 'unknown' },
      phase === 'start'
        ? 'linq: typing indicator did not start'
        : 'linq: typing indicator did not stop',
    );
  }
}
