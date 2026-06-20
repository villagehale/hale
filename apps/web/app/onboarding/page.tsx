import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
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

  return (
    <OnboardingWizard
      authReady={authReady}
      signedIn={Boolean(session?.user?.id)}
      startAtSetup={step === 'setup'}
    />
  );
}
