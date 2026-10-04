import type { ReplyRoute } from '~/lib/channel/router/reply-route';
import { startLinqTyping, stopLinqTyping } from './transport';

/**
 * VIL-335 — the typing bubble on an iMessage turn.
 *
 * Linq holds one start for about 85 seconds and asks the caller to refresh
 * every 60 while composing is still going. A send clears the bubble on its
 * own; we stop first anyway, so a parent never sees typing land on top of the
 * reply, and we stop again when a turn thought and then sent nothing.
 *
 * Other doors are a no-op. A failure is logged and never thrown: a typing
 * blip must not eat the answer (the send is the thing the parent is owed).
 */

/** Linq's own refresh interval. One start lasts ~85s; this keeps it up. */
export const LINQ_TYPING_REFRESH_MS = 60_000;

/**
 * How long a new-parent turn waits before painting the bubble. A reply that
 * leaves sooner never starts it, so a postal ask does not flash typing and
 * then the text in the same instant.
 */
export const LINQ_TYPING_SHOW_DELAY_MS = 500;

/**
 * Arm the bubble for one iMessage turn. SMS and a missing chat id arm nothing.
 * `stop` cancels a bubble that has not appeared, or clears one that has.
 * A Linq miss is logged inside {@link signalImessageTyping} and never thrown.
 */
export function armDelayedImessageTyping(input: {
  channel: string;
  chatId: string | null;
  log: Pick<Console, 'warn'>;
  delayMs?: number;
}): { stop: () => Promise<void> } {
  if (input.channel !== 'imessage' || !input.chatId) {
    return { stop: async () => undefined };
  }
  // `to` is unused: the typing call is the chat id. replyTo stays null so the
  // indicator itself does not draw a connector.
  const route: ReplyRoute = {
    channel: 'imessage',
    to: '',
    chatId: input.chatId,
    replyToMessageId: null,
  };
  let phase: 'wait' | 'live' | 'done' = 'wait';
  let starting: Promise<void> | null = null;
  let refresh: ReturnType<typeof setInterval> | null = null;
  const delayMs = input.delayMs ?? LINQ_TYPING_SHOW_DELAY_MS;

  const begin = () => {
    if (phase !== 'wait') return;
    phase = 'live';
    const startOnce = () =>
      signalImessageTyping(route, 'start', input.log).catch((err: unknown) => {
        input.log.warn(
          { err: err instanceof Error ? err.name : 'unknown' },
          'linq: typing indicator did not start',
        );
      });
    starting = startOnce();
    refresh = setInterval(() => {
      void startOnce();
    }, LINQ_TYPING_REFRESH_MS);
    if (typeof refresh.unref === 'function') refresh.unref();
  };

  const timer = delayMs <= 0 ? null : setTimeout(begin, delayMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  if (delayMs <= 0) begin();

  return {
    stop: async () => {
      if (phase === 'done') return;
      const live = phase === 'live';
      phase = 'done';
      if (timer) clearTimeout(timer);
      if (refresh) clearInterval(refresh);
      if (starting) await starting;
      if (!live && !starting) return;
      try {
        await signalImessageTyping(route, 'stop', input.log);
      } catch (err) {
        input.log.warn(
          { err: err instanceof Error ? err.name : 'unknown' },
          'linq: typing indicator did not stop',
        );
      }
    },
  };
}

export async function signalImessageTyping(
  route: ReplyRoute,
  phase: 'start' | 'stop',
  log: Pick<Console, 'warn'>,
): Promise<void> {
  if (route.channel !== 'imessage') return;
  const result =
    phase === 'start'
      ? await startLinqTyping({ chatId: route.chatId })
      : await stopLinqTyping({ chatId: route.chatId });
  if (result.status === 'accepted') return;
  log.warn(
    {
      phase,
      outcome: result.status,
      ...(result.status === 'refused' ? { code: result.code } : {}),
      ...(result.status === 'unreachable' ? { reason: result.reason } : {}),
    },
    phase === 'start'
      ? 'linq: typing indicator did not start'
      : 'linq: typing indicator did not stop',
  );
}
