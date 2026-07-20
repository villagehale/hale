import { AskHaleThread } from '~/components/hale/ask-hale-thread';
import type { ConnectorChip } from '~/components/hale/coach-context-panel';
import type { ConversationSummary } from '~/lib/coach/history';
import type { ThreadSeed } from '~/lib/coach/thread';

/**
 * The full /coach Ask Hale thread — the surface of the shared conversation component
 * (`AskHaleThread`). It shares state, rehydrated history, the running conversationId,
 * auto-scroll, and focus-after-send with the Home hero; only the layout differs. The
 * full surface also carries the family's connectors for its Context rail and the
 * session list for its history rail.
 */
export function CoachConversation({
  canAsk,
  seed,
  connectors,
  initialConversations = [],
  initialFocusedChildId = null,
  viewerName = null,
}: {
  canAsk: boolean;
  seed: ThreadSeed;
  /** The family's connectors, for the /coach Context rail. */
  connectors: ConnectorChip[];
  /** The family's Ask sessions, for the /coach history rail (RSC-seeded); empty is a
   * valid honest state (no past chats yet). */
  initialConversations?: ConversationSummary[];
  /** Pre-scope the conversation to a child (contextual entry), or null for the family. */
  initialFocusedChildId?: string | null;
  /** Signed-in parent's name, for the empty-state greeting ("Good evening, Alex."). */
  viewerName?: string | null;
}) {
  return (
    <AskHaleThread
      canAsk={canAsk}
      seed={seed}
      variant="full"
      connectors={connectors}
      initialConversations={initialConversations}
      initialFocusedChildId={initialFocusedChildId}
      viewerName={viewerName}
    />
  );
}
