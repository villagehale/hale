import { CoachConversation } from '~/components/hale/coach-conversation';
import { connectorChips } from '~/components/hale/coach-context-panel';
import { ASK_RAIL_LEFT_KEY, ASK_RAIL_RIGHT_KEY } from '~/lib/ask-rail';
import { authConfigured } from '~/lib/auth-config';
import { loadConversations } from '~/lib/coach/history';
import { loadThreadShellForRequest } from '~/lib/coach/thread';
import { loadViewerName } from '~/lib/family';
import { loadFamilyConnectors } from '~/lib/integrations/load';

/** The signed-in parent's first name for the empty-state greeting ("Good evening,
 * Alex."). Sourced robustly (session name → stored users.name) via loadViewerName. */
async function viewerName(): Promise<string | null> {
  return loadViewerName();
}

// Runs before first paint to mirror each Ask side rail's stored collapse choice onto a
// root data attribute, so a collapsed rail never flashes open on load (globals.css
// `.ask-rail-*` drives width + content off these). Default (absent key) is OPEN.
const NO_FLASH_RAILS = `(function(){try{var d=document.documentElement.dataset;d.askRailLeft=localStorage.getItem(${JSON.stringify(
  ASK_RAIL_LEFT_KEY,
)})==='1'?'1':'0';d.askRailRight=localStorage.getItem(${JSON.stringify(
  ASK_RAIL_RIGHT_KEY,
)})==='1'?'1':'0';}catch(e){}})();`;

export default async function CoachPage({
  searchParams,
}: {
  searchParams: Promise<{ child?: string }>;
}) {
  const canAsk = authConfigured();
  const [askSeed, connections, name, conversations] = await Promise.all([
    loadThreadShellForRequest(),
    loadFamilyConnectors(),
    viewerName(),
    loadConversations(),
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
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: pre-paint rail-collapse script must run before hydration to avoid a rail flash */}
      <script dangerouslySetInnerHTML={{ __html: NO_FLASH_RAILS }} />
      <CoachConversation
        canAsk={canAsk}
        seed={askSeed}
        connectors={connectors}
        initialConversations={conversations}
        initialFocusedChildId={initialFocusedChildId}
        viewerName={name}
      />
    </>
  );
}
