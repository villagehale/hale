import { CoachConversation } from '~/components/hale/coach-conversation';
import { connectorChips } from '~/components/hale/coach-context-panel';
import { PageCorner } from '~/components/hale/page-corner';
import { authConfigured } from '~/lib/auth-config';
import { loadThreadShellForRequest } from '~/lib/coach/thread';
import { loadFamilyConnectors } from '~/lib/integrations/load';

export default async function CoachPage({
  searchParams,
}: {
  searchParams: Promise<{ child?: string }>;
}) {
  const canAsk = authConfigured();
  const [askSeed, connections] = await Promise.all([
    loadThreadShellForRequest(),
    loadFamilyConnectors(),
  ]);
  const connectors = connectorChips(connections);
  const { child } = await searchParams;
  // Contextual entry (e.g. from a child's companion page): pre-scope to that child,
  // but only if it's actually one of this family's children (no arbitrary id).
  const initialFocusedChildId = askSeed.children.some((c) => c.id === child)
    ? (child ?? null)
    : null;

  return (
    <>
      <PageCorner section="Hale" />
      <CoachConversation
        canAsk={canAsk}
        seed={askSeed}
        connectors={connectors}
        initialFocusedChildId={initialFocusedChildId}
      />
    </>
  );
}
