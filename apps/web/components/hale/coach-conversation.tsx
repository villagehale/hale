import { AskHaleThread } from '~/components/hale/ask-hale-thread';
import type { ThreadSeed } from '~/lib/coach/thread';

/**
 * The full /coach Ask Hale thread — the editorial surface of the ONE shared
 * conversation component (`AskHaleThread`). It shares state, rehydrated history,
 * the running conversationId, auto-scroll, and focus-after-send with the Home
 * hero; only the layout differs.
 */
export function CoachConversation({ canAsk, seed }: { canAsk: boolean; seed: ThreadSeed }) {
  return <AskHaleThread canAsk={canAsk} seed={seed} variant="full" />;
}
