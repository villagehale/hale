import { ConciergeThread } from '~/components/hale/concierge-thread';
import type { ThreadSeed } from '~/lib/coach/thread';

/**
 * The Home hero entry to the Concierge — the compact surface of the ONE shared
 * conversation component (`ConciergeThread`). It shares state, rehydrated history,
 * the running conversationId, auto-scroll, and focus-after-send with the full
 * /coach thread; only the layout differs.
 */
export function AskBox({ canAsk, seed }: { canAsk: boolean; seed: ThreadSeed }) {
  return <ConciergeThread canAsk={canAsk} seed={seed} variant="compact" />;
}
