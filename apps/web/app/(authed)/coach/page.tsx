import { auth } from '~/auth';
import { CoachConversation } from '~/components/hale/coach-conversation';
import { connectorChips } from '~/components/hale/coach-context-panel';
import { authConfigured } from '~/lib/auth-config';
import { loadThreadShellForRequest } from '~/lib/coach/thread';
import { loadFamilyConnectors } from '~/lib/integrations/load';

/** The signed-in parent's name for the empty-state greeting ("Hi Alex, …"). In
 * preview (auth off) there is no session, so the greeting degrades to the bare
 * invite — mirrors the Home hero's viewerName. */
async function viewerName(): Promise<string | null> {
  if (!authConfigured()) return null;
  const session = await auth();
  return session?.user?.name ?? null;
}

export default async function CoachPage({
  searchParams,
}: {
  searchParams: Promise<{ child?: string }>;
}) {
  const canAsk = authConfigured();
  const [askSeed, connections, name] = await Promise.all([
    loadThreadShellForRequest(),
    loadFamilyConnectors(),
    viewerName(),
  ]);
  const connectors = connectorChips(connections);
  const { child } = await searchParams;
  // Contextual entry (e.g. from a child's companion page): pre-scope to that child,
  // but only if it's actually one of this family's children (no arbitrary id).
  const initialFocusedChildId = askSeed.children.some((c) => c.id === child)
    ? (child ?? null)
    : null;

  return (
    <CoachConversation
      canAsk={canAsk}
      seed={askSeed}
      connectors={connectors}
      initialFocusedChildId={initialFocusedChildId}
      viewerName={name}
    />
  );
}
