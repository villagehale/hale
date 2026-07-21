import { redirect } from 'next/navigation';
import { after } from 'next/server';
import { auth } from '~/auth';
import { AppShell } from '~/components/hale/app-shell';
import { AppTopBar } from '~/components/hale/app-topbar';
import { buildRootHeroes } from '~/components/hale/hero-map';
import { PageHero } from '~/components/hale/page-hero';
import { ScrollReset } from '~/components/hale/scroll-reset';
import { Sidebar } from '~/components/hale/sidebar';
import { TopHeader } from '~/components/hale/top-header';
import { IdentifyUser } from '~/lib/analytics/posthog-provider';
import { authConfigured } from '~/lib/auth-config';
import { loadNotifications } from '~/lib/dashboard/notifications';
import { loadFamilyBasics } from '~/lib/dashboard/queries';
import { db } from '~/lib/db';
import { loadViewerName, resolveFamilyForUser } from '~/lib/family';
import { homeGreeting } from '~/lib/home/greeting';
import { markFamilyActiveToday } from '~/lib/metrics/activity';
import { SHELL_COLLAPSED_KEY } from '~/lib/shell';
import { loadAreaSwitcher } from '~/lib/village/switcher';

// authConfigured()/auth() read runtime secrets and the live session — never bake
// them at build time, or every authed page freezes to the build-time auth state.
export const dynamic = 'force-dynamic';

// Runs before first paint to mirror the stored sidebar-collapse choice onto the
// root element, so the rail never flashes full-width before hydration. Mirrors
// AppShell; kept inline because it must execute before React mounts.
const NO_FLASH_COLLAPSE = `(function(){try{document.documentElement.dataset.shellCollapsed=localStorage.getItem(${JSON.stringify(
  SHELL_COLLAPSED_KEY,
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

  // The foot child switcher + top-bar hero/bell/location read the same family-scoped
  // queries the authed pages use; every one degrades to an empty/absent state (no fake
  // child, no fake city, no fabricated notification) when there is no resolved family.
  const [basics, notifications, areaData, viewerName] = await Promise.all([
    loadFamilyBasics(),
    loadNotifications(),
    loadAreaSwitcher(),
    loadViewerName(),
  ]);
  const kids = basics.children.map((child) => ({
    id: child.id,
    name: child.name,
    ageLabel: child.stageLabel,
  }));

  // The top-bar hero copy is built server-side from live values: the time-of-day
  // greeting warmed with the viewer's name, and the companion child's name only when
  // the family has exactly one child (else a family-wide subtitle — never a fabricated
  // single name, rule #1).
  const singleChildName = basics.children.length === 1 ? (basics.children[0]?.name ?? null) : null;
  const roots = buildRootHeroes({ greeting: homeGreeting(viewerName), childName: singleChildName });

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
            parentImage={session?.user?.image ?? null}
            planTier={basics.planTier}
            kids={kids}
          />
        }
        header={
          <>
            <TopHeader />
            <AppTopBar roots={roots} notifications={notifications} areaData={areaData} />
          </>
        }
      >
        <main id="main-content" className="main-stage">
          <ScrollReset />
          {/* Narrow-viewport hero: the desktop top bar is hidden < 1024px, so the same
           * PageHero renders inline at the top of the stage there (CSS shows exactly
           * one). Pages carry no header of their own. */}
          <PageHero roots={roots} variant="stage" />
          {!authEnabled && (
            <output className="dev-preview-banner">
              Auth disabled — development preview. This route group is unprotected because Google
              OAuth is not configured.
            </output>
          )}
          {children}
        </main>
      </AppShell>
    </>
  );
}
