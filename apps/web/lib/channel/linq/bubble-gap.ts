import { turnRemainingMs } from '~/lib/channel/router/deadline';
import type { ReplyRoute } from '~/lib/channel/router/reply-route';
import { signalImessageTyping } from './presence';
import { SEND_TIMEOUT_MS } from './transport';

/**
 * The pause before the next bubble of one message on iMessage (VIL-682 K5): about as long
 * as a person takes to type a short line, so several bubbles arrive one by one instead of
 * all at once.
 */
export const BUBBLE_GAP_MS = 2_000;

/**
 * Send the next bubble of one message after the gap, with the typing bubble up meanwhile.
 *
 * Typing starts first and the gap runs beside that call. The send waits for both, so typing
 * never lands after the bubble it stands for. A send clears typing on its own; a send that
 * throws clears it here, so a set that stops partway does not leave Hale typing. A typing
 * call that fails is logged and the bubble still goes.
 *
 * The gap comes out of the turn's deadline. When the turn has too little left for the pause
 * and the send after it, the bubble goes at once and `deadline_near` is logged. Outside a
 * router turn (a notice, intake) there is no turn deadline to spend.
 */
export async function sendAfterBubbleGap<T>(
  input: {
    chatId: string;
    log: Pick<Console, 'info' | 'warn'>;
    /** Test seam. Production uses {@link BUBBLE_GAP_MS}. */
    gapMs?: number;
  },
  send: () => Promise<T>,
): Promise<T> {
  const gapMs = input.gapMs ?? BUBBLE_GAP_MS;
  const remaining = turnRemainingMs();
  // The pause lasts as long as the gap or the typing call, and Linq stops that call at
  // SEND_TIMEOUT_MS. The bubble's own send can take as long again.
  const needed = Math.max(gapMs, SEND_TIMEOUT_MS) + SEND_TIMEOUT_MS;
  if (remaining !== undefined && remaining < needed) {
    input.log.info(
      { outcome: 'deadline_near', remainingMs: remaining },
      'bubbles: the next bubble goes without the gap',
    );
    return send();
  }
  // `to` is unused: the typing call is the chat id (as in presence.ts).
  const route: ReplyRoute = {
    channel: 'imessage',
    to: '',
    chatId: input.chatId,
    replyToMessageId: null,
  };
  await Promise.all([
    typing(route, 'start', input.log),
    new Promise((resolve) => setTimeout(resolve, gapMs)),
  ]);
  try {
    return await send();
  } catch (err) {
    await typing(route, 'stop', input.log);
    throw err;
  }
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
