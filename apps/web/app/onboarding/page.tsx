import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { auth } from '~/auth';
import { LogoMark } from '~/components/hale/logo-mark';
import { ThemeToggle } from '~/components/hale/theme-toggle';
import { authConfigured, credentialsConfigured, googleConfigured } from '~/lib/auth-config';
import { db } from '~/lib/db';
import { resolveFamilyForUser } from '~/lib/family';
import { decideOnboardingEntry } from '~/lib/onboarding/resume';
import { OnboardingWizard } from './wizard';

// authConfigured()/auth() read runtime secrets + the live session — never bake
// them at build time.
export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
  const authReady = authConfigured();
  // Steps 1–6 are public (pre-auth). A session is present only once the parent has
  // returned from the auth hop (step 6) — the wizard then resumes at step 7.
  const session = authReady ? await auth() : null;
  const userId = session?.user?.id ?? null;

  let hasFamily = false;
  if (userId && process.env.DATABASE_URL) {
    hasFamily = Boolean(await resolveFamilyForUser(userId, db()));
  }

  // A signed-in parent who already has a family has nothing to onboard, and a repeat
  // submit is a server-side no-op — their edits would silently vanish. Rather than an
  // invisible bounce to /home (which reads as the wizard ending mid-flow — the founder
  // hit exactly this testing with his own onboarded account), show an honest terminal
  // card. The forward gate (no-family → /onboarding) still lives in the authed layout;
  // this is its inverse.
  const entry = decideOnboardingEntry(Boolean(userId), hasFamily);
  if (entry.kind === 'already-onboarded') {
    return <AlreadyOnboarded />;
  }

  return (
    <OnboardingWizard
      authReady={authReady}
      google={googleConfigured()}
      magicLink={credentialsConfigured()}
      signedIn={entry.signedIn}
      sessionName={session?.user?.name ?? null}
    />
  );
}

/** Terminal state for an already-onboarded parent who lands back on /onboarding —
 * an honest "you're set up" card instead of a silent redirect. */
function AlreadyOnboarded() {
  return (
    <main className="ob-shell">
      <div className="ob-theme">
        <ThemeToggle />
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
        <LogoMark size={70} className="shadow-[0_14px_32px_rgba(27,33,96,0.25)]" />
        <div className="space-y-2">
          <h1 className="font-display text-[2rem] font-medium leading-tight">
            You&rsquo;re already set up.
          </h1>
          <p className="text-lg text-slate-green leading-relaxed max-w-md">
            Your village is ready and waiting — pick up right where you left off.
          </p>
        </div>
        <Link href="/home" className="btn-primary">
          Open your village
          <ArrowRight size={18} strokeWidth={2} aria-hidden="true" />
        </Link>
      </div>
    </main>
  );
}
