import { AskHaleThread } from '~/components/hale/ask-hale-thread';
import type { ConnectorChip } from '~/components/hale/coach-context-panel';
import type { ThreadSeed } from '~/lib/coach/thread';

/**
 * The full /coach Ask Hale thread — the editorial surface of the ONE shared
 * conversation component (`AskHaleThread`). It shares state, rehydrated history,
 * the running conversationId, auto-scroll, and focus-after-send with the Home
 * hero; only the layout differs. The full surface also carries the family's
 * connectors for its Context panel.
 */
export function CoachConversation({
  canAsk,
  seed,
  connectors,
  initialFocusedChildId = null,
}: {
  canAsk: boolean;
  seed: ThreadSeed;
  /** The family's connectors, for the /coach Context panel. */
  connectors: ConnectorChip[];
  /** Pre-scope the conversation to a child (contextual entry), or null for the family. */
  initialFocusedChildId?: string | null;
}) {
  return (
    <AskHaleThread
      canAsk={canAsk}
      seed={seed}
      variant="full"
      connectors={connectors}
      initialFocusedChildId={initialFocusedChildId}
    />
  );
}
