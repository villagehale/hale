import { redirect } from 'next/navigation';
import { auth } from '~/auth';
import { authConfigured, credentialsConfigured, googleConfigured } from '~/lib/auth-config';
import { db } from '~/lib/db';
import { resolveFamilyForUser } from '~/lib/family';
import { OnboardingWizard } from './wizard';

// authConfigured()/auth() read runtime secrets + the live session — never bake
// them at build time.
export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
  const authReady = authConfigured();
  // Steps 1–6 are public (pre-auth). A session is present only once the parent has
  // returned from the auth hop (step 6) — the wizard then resumes at step 7.
  const session = authReady ? await auth() : null;

  // A family-having user has nothing to onboard, and a repeat submit is a
  // server-side no-op — their edits would silently vanish behind a success screen.
  // Send them to the app. (The inverse of the authed layout's no-family redirect.)
  if (session?.user?.id && process.env.DATABASE_URL) {
    const familyId = await resolveFamilyForUser(session.user.id, db());
    if (familyId) {
      redirect('/home');
    }
  }

  return (
    <OnboardingWizard
      authReady={authReady}
      google={googleConfigured()}
      magicLink={credentialsConfigured()}
      signedIn={Boolean(session?.user?.id)}
      sessionName={session?.user?.name ?? null}
    />
  );
}
