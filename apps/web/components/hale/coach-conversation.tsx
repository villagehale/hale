import { ConciergeThread } from '~/components/hale/concierge-thread';
import type { ConnectorChip } from '~/components/hale/coach-context-panel';
import type { ThreadSeed } from '~/lib/coach/thread';

/**
 * The full /coach Concierge thread — the editorial surface of the ONE shared
 * conversation component (`ConciergeThread`). It shares state, rehydrated history,
 * the running conversationId, auto-scroll, and focus-after-send with the Home
 * hero; only the layout differs. The Cowork layout also carries the family's
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
    <ConciergeThread
      canAsk={canAsk}
      seed={seed}
      variant="full"
      connectors={connectors}
      initialFocusedChildId={initialFocusedChildId}
    />
  );
}
