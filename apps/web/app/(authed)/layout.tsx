import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { after } from 'next/server';
import { auth } from '~/auth';
import { buildRootHeroes } from '~/components/hale/hero-map';
import { PortalShell } from '~/components/portal/shell';
import { IdentifyUser } from '~/lib/analytics/posthog-provider';
import { authConfigured } from '~/lib/auth-config';
import { RETURN_PATH_HEADER, signInHref } from '~/lib/auth/redirect';
import { loadFamilyBasics } from '~/lib/dashboard/queries';
import { db } from '~/lib/db';
import { loadViewerName, resolveFamilyForUser } from '~/lib/family';
import { homeGreeting } from '~/lib/home/greeting';
import { markFamilyActiveToday } from '~/lib/metrics/activity';
import { PASSPORT_DEMO_HEADER, interestPassportDemo } from '~/lib/passport/demo';

// authConfigured()/auth() read runtime secrets and the live session — never bake
// them at build time, or every authed page freezes to the build-time auth state.
export const dynamic = 'force-dynamic';

export default async function AuthedLayout({ children }: { children: React.ReactNode }) {
  // Preview demo of the Mia/Leo passport. The middleware is the only writer of
  // this header, and only on /family and the two fixture kids. No session, no
  // database, no real family under the page.
  // headers() for the demo runs only when that gate is already true. A signed-out
  // request reads headers only to recover the return path the middleware stamped,
  // then redirects before any family read. The no-family arm below still redirects
  // with no return path, so it cannot loop back onto the page that bounced it.
  if (interestPassportDemo()) {
    const demoHeaders = await headers();
    if (demoHeaders.get(PASSPORT_DEMO_HEADER) === '1') {
      return (
        <>
          <a href="#main-content" className="skip-link">
            Skip to content
          </a>
          <PortalShell canSignOut roots={buildRootHeroes({ greeting: 'Hi', childName: null })}>
            {children}
          </PortalShell>
        </>
      );
    }
  }

  const authEnabled = authConfigured();
  const session = authEnabled ? await auth() : null;
  if (authEnabled && !session?.user?.id) {
    const gateHeaders = await headers();
    redirect(signInHref(gateHeaders.get(RETURN_PATH_HEADER)));
  }

  // A signed-in user with no family has no app to be shown — provisioning is what
  // writes the users/families rows, and a bare Google sign-in never does. That used
  // to mean "send them to the wizard to finish"; since F14 deleted the wizard it
  // means the account is one no front door produces any more (an old test login, a
  // half-finished web signup). /sign-in is the phone door that can reach a real
  // family, and it renders rather than redirecting, so this cannot become a loop.
  if (authEnabled && session?.user?.id) {
    const familyId = await resolveFamilyForUser(session.user.id, db());
    if (!familyId) {
      redirect('/sign-in');
    }
    // Day-grain retention substrate; after() so the paint never waits on it.
    after(() => markFamilyActiveToday(db(), familyId));
  }

  const [basics, viewerName] = await Promise.all([loadFamilyBasics(), loadViewerName()]);

  // The greeting is warmed with the viewer's name, and the companion child's name
  // only when the family has exactly one child (else a family-wide subtitle — never
  // a fabricated single name, rule #1).
  const singleChildName = basics.children.length === 1 ? (basics.children[0]?.name ?? null) : null;
  const roots = buildRootHeroes({ greeting: homeGreeting(viewerName), childName: singleChildName });

  const shellBanner = !authEnabled ? (
    <output className="dev-preview-banner">
      Auth disabled — development preview. This route group is unprotected because Google OAuth is
      not configured.
    </output>
  ) : null;

  return (
    <>
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      {session?.user?.id ? <IdentifyUser userId={session.user.id} /> : null}
      <PortalShell canSignOut={authEnabled} roots={roots}>
        {shellBanner}
        {children}
      </PortalShell>
    </>
  );
}
