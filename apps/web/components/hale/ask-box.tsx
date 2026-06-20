import { AskHaleThread } from '~/components/hale/ask-hale-thread';
import type { ThreadSeed } from '~/lib/coach/thread';

/**
 * The Home hero entry to Ask Hale — the compact surface of the ONE shared
 * conversation component (`AskHaleThread`). It shares state, rehydrated history,
 * the running conversationId, auto-scroll, and focus-after-send with the full
 * /coach thread; only the layout differs.
 */
export function AskBox({ canAsk, seed }: { canAsk: boolean; seed: ThreadSeed }) {
  return <AskHaleThread canAsk={canAsk} seed={seed} variant="compact" />;
}
