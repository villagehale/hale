import { redirect } from 'next/navigation';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db } from '~/lib/db';
import { resolveFamilyForUser } from '~/lib/family';
import { OnboardingWizard } from './wizard';

// authConfigured()/auth() read runtime secrets + the live session — never bake
// them at build time.
export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ step?: string }>;
}

export default async function OnboardingPage({ searchParams }: PageProps) {
  const { step } = await searchParams;
  const authReady = authConfigured();
  // Phase C (?step=setup) only renders against a real session — the OAuth
  // round-trip returns here signed in. The wizard never collects the full DOB
  // (sensitive, rule #1) until this is true.
  const session = authReady ? await auth() : null;

  // The inverse of the (authed) layout's no-family redirect: a family-having user
  // has nothing to onboard, and a repeat submit is a server-side no-op — their
  // edits would silently vanish behind a success screen. Send them to the app.
  if (session?.user?.id && process.env.DATABASE_URL) {
    const familyId = await resolveFamilyForUser(session.user.id, db());
    if (familyId) {
      redirect('/home');
    }
  }

  return (
    <OnboardingWizard
      authReady={authReady}
      signedIn={Boolean(session?.user?.id)}
      startAtSetup={step === 'setup'}
      sessionName={session?.user?.name ?? null}
    />
  );
}
