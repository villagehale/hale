import { redirect } from 'next/navigation';
import { after } from 'next/server';
import { auth } from '~/auth';
import { AppShell } from '~/components/hale/app-shell';
import { AppTopBar } from '~/components/hale/app-topbar';
import { Sidebar } from '~/components/hale/sidebar';
import { TopHeader } from '~/components/hale/top-header';
import { ScrollReset } from '~/components/hale/scroll-reset';
import { IdentifyUser } from '~/lib/analytics/posthog-provider';
import { authConfigured } from '~/lib/auth-config';
import { loadFamilyBasics } from '~/lib/dashboard/queries';
import { db } from '~/lib/db';
import { resolveFamilyForUser } from '~/lib/family';
import { markFamilyActiveToday } from '~/lib/metrics/activity';
import { SHELL_COLLAPSED_KEY } from '~/lib/shell';

// authConfigured()/auth() read runtime secrets and the live session — never bake
// them at build time, or every authed page freezes to the build-time auth state.
export const dynamic = 'force-dynamic';

// Runs before first paint to mirror the stored sidebar-collapse choice onto the
// root element, so the rail never flashes full-width before hydration. Mirrors
// AppShell; kept inline because it must execute before React mounts.
const NO_FLASH_COLLAPSE = `(function(){try{document.documentElement.dataset.shellCollapsed=localStorage.getItem(${JSON.stringify(
  SHELL_COLLAPSED_KEY
)})==='1'?'1':'0';}catch(e){}})();`;

export default async function AuthedLayout({ children }: { children: React.ReactNode }) {
  const authEnabled = authConfigured();
  const session = authEnabled ? await auth() : null;
  if (authEnabled && !session?.user?.id) {
    redirect('/sign-in');
  }

  // A signed-in user with no family hasn't finished onboarding (provisioning
  // creates the users/families rows). Route them there instead of an empty app —
  // a bare Google sign-in alone never writes a DB row.
  if (authEnabled && session?.user?.id) {
    const familyId = await resolveFamilyForUser(session.user.id, db());
    if (!familyId) {
      redirect('/onboarding');
    }
    // Day-grain retention substrate; after() so the paint never waits on it.
    after(() => markFamilyActiveToday(db(), familyId));
  }

  // The foot child switcher + top-bar location read the same family-basics query
  // the authed pages already use; both degrade to an empty/absent state (no fake
  // child, no fake city) when there is no resolved family yet.
  const basics = await loadFamilyBasics();
  const kids = basics.children.map((child) => ({
    id: child.id,
    name: child.name,
    ageLabel: child.stageLabel,
  }));
  const city = basics.location.city;

  return (
    <>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: pre-paint collapse script must run before hydration to avoid a rail flash */}
      <script dangerouslySetInnerHTML={{ __html: NO_FLASH_COLLAPSE }} />
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      {session?.user?.id ? <IdentifyUser userId={session.user.id} /> : null}
      <AppShell
        sidebar={
          <Sidebar
            authControls={authEnabled}
            signedIn={Boolean(session?.user?.id)}
            parentName={session?.user?.name ?? null}
            kids={kids}
          />
        }
        header={
          <>
            <TopHeader />
            <AppTopBar city={city} />
          </>
        }
      >
        <main id="main-content" className="main-stage">
          <ScrollReset />
          {!authEnabled && (
            <output className="dev-preview-banner">
              Auth disabled — development preview. This route group is unprotected
              because Google OAuth is not configured.
            </output>
          )}
          {children}
        </main>
      </AppShell>
    </>
  );
}
