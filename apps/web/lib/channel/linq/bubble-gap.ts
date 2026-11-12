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
 * The most gaps one set of bubbles may add outside a router turn and outside Linq's
 * webhook: a notice in the drain. Counted, not timed, so timer slack can never skip one.
 * Each such pause is the gap itself, so the set adds at most this many gaps' time.
 */
export const OFF_TURN_GAPS = 2;

/**
 * Sends one bubble of a set after the gap. The set's first bubble is not passed here.
 * `went` says whether the result is a bubble that went: a refusal handed back as a value
 * takes typing down just as a thrown one does.
 *
 * `send` is the whole send, with anything that must sit right before its transport call
 * inside it: a sign-up ask's stamp draws the order number of the text it brackets
 * (signup/store.ts `askStamp`), so a stamp drawn before the gap would rank this bubble
 * below a text another sender started during the gap.
 */
export type BubbleGaps = <T>(send: () => Promise<T>, went: (result: T) => boolean) => Promise<T>;

/** `went` for a send that throws whenever it does not go: anything it returns went. */
export const sentUnlessThrown = (): boolean => true;

/**
 * The gaps for one set of bubbles on one chat, or null when the chat is not paced.
 *
 * Only a chat Linq said is iMessage (`service`) is paced. Linq relays green-bubble SMS and
 * RCS chats on the same line and reports them as `imessage`, so the transport cannot say.
 * Null or absent: Linq did not say, which is not a yes.
 *
 * Typing starts with the gap. A bubble that goes clears typing on its own; one that does
 * not, thrown or handed back (`went`), clears it here, so a set that stops partway does
 * not leave Hale typing. A typing call that fails is logged and the bubble still goes.
 *
 * One bound per set, by where it runs:
 * - Inside a router turn the gap comes out of the turn's deadline, and the send waits for
 *   the typing call too. With too little left for the pause and the send after it, the
 *   bubble goes at once and `deadline_near` is logged.
 * - Inside Linq's webhook (`answerBy`, intake), a gap is taken only when it and the
 *   bubble's own send (SEND_TIMEOUT_MS) both fit before the moment Linq stops waiting.
 *   Otherwise the bubble goes at once and `deadline_near` is logged. Linq's whole timeout
 *   (LINQ_WEBHOOK_TIMEOUT_MS) is no more than that, so no gap is taken inside it today.
 * - Elsewhere the set takes at most {@link OFF_TURN_GAPS} gaps; after that the bubble goes
 *   at once and `gap_budget_spent` is logged.
 * Outside a turn the pause is the gap itself: a typing call Linq has not answered by then
 * does not hold the bubble.
 */
export function bubbleGaps(input: {
  chatId: string;
  service: LinqChatService | null | undefined;
  log: Pick<Console, 'info' | 'warn'>;
  /** When Linq stops waiting for the webhook this set answers. Absent: none waits. */
  answerBy?: Date | null;
  /** Test seam. Production uses {@link BUBBLE_GAP_MS}. */
  gapMs?: number;
}): BubbleGaps | null {
  if (input.service !== 'iMessage') return null;
  const gapMs = input.gapMs ?? BUBBLE_GAP_MS;
  const answerBy = input.answerBy ?? null;
  const log = input.log;
  // `to` is unused: the typing call is the chat id (as in presence.ts).
  const route: ReplyRoute = {
    channel: 'imessage',
    to: '',
    chatId: input.chatId,
    replyToMessageId: null,
  };
  let gapsLeft = OFF_TURN_GAPS;
  const goNow = <T>(send: () => Promise<T>, fields: Record<string, number | string>) => {
    log.info(fields, 'bubbles: the next bubble goes without the gap');
    return send();
  };
  return async (send, went) => {
    const turnLeft = turnRemainingMs();
    if (turnLeft !== undefined) {
      // The pause lasts as long as the gap or the typing call, and Linq stops that call at
      // SEND_TIMEOUT_MS. The bubble's own send can take as long again.
      if (turnLeft < Math.max(gapMs, SEND_TIMEOUT_MS) + SEND_TIMEOUT_MS) {
        return goNow(send, { outcome: 'deadline_near', remainingMs: turnLeft });
      }
    } else if (answerBy) {
      const webhookLeft = answerBy.getTime() - Date.now();
      if (webhookLeft < gapMs + SEND_TIMEOUT_MS) {
        return goNow(send, { outcome: 'deadline_near', remainingMs: webhookLeft });
      }
    } else if (gapsLeft === 0) {
      return goNow(send, { outcome: 'gap_budget_spent', gaps: OFF_TURN_GAPS });
    } else {
      gapsLeft -= 1;
    }
    const typed = typing(route, 'start', log);
    await (turnLeft === undefined ? sleep(gapMs) : Promise.all([typed, sleep(gapMs)]));
    // A stop never overtakes its own start.
    const typingDown = async () => {
      await typed;
      await typing(route, 'stop', log);
    };
    let result: Awaited<ReturnType<typeof send>>;
    try {
      result = await send();
    } catch (err) {
      await typingDown();
      throw err;
    }
    if (!went(result)) await typingDown();
    return result;
  };
}

/**
 * {@link bubbleGaps} for a set that reads its chat's service (messaging-door.ts
 * `chatServiceSaid`). That read only decides the pacing, so one that fails leaves the set
 * unpaced, logged as `pacing_read_failed`, and never stops a send.
 */
export async function readBubbleGaps(
  input: Omit<Parameters<typeof bubbleGaps>[0], 'service'> & {
    readService: () => Promise<LinqChatService | null>;
  },
): Promise<BubbleGaps | null> {
  const { readService, ...rest } = input;
  let service: LinqChatService | null;
  try {
    service = await readService();
  } catch (err) {
    rest.log.warn(
      { outcome: 'pacing_read_failed', err: err instanceof Error ? err.name : 'unknown' },
      'bubbles: the chat service read failed - this set goes unpaced',
    );
    return null;
  }
  return bubbleGaps({ ...rest, service });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
