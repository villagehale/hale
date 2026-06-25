import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { auth } from '~/auth';
import { AppShell } from '~/components/hale/app-shell';
import { Sidebar } from '~/components/hale/sidebar';
import { TopHeader } from '~/components/hale/top-header';
import { FamilyHeader } from '~/components/hale/family-header';
import { IdentifyUser } from '~/lib/analytics/posthog-provider';
import { authConfigured } from '~/lib/auth-config';
import { loadFamilyName } from '~/lib/dashboard/queries';
import { db } from '~/lib/db';
import { resolveFamilyForUser } from '~/lib/family';
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
  }

  const familyName = await loadFamilyName();

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
            familyName={familyName}
          />
        }
        header={<TopHeader />}
      >
        <main id="main-content" className="main-stage">
          {!authEnabled && (
            <output className="dev-preview-banner">
              Auth disabled — development preview. This route group is unprotected
              because Google OAuth is not configured.
            </output>
          )}
          {/* The family band reads the DB; stream it so it never blocks the
           * shell's first paint. It renders nothing when there are no children,
           * so a null fallback is correct — no reserved space to reflow. This is
           * part of the nav-loading fix: without the boundary, every entry into
           * the group waited on this read before anything appeared. */}
          <Suspense fallback={null}>
            <FamilyHeader />
          </Suspense>
          {children}
        </main>
      </AppShell>
    </>
  );
}
