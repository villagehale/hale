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
