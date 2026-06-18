import { authConfigured } from '~/lib/auth-config';
import { OnboardingWizard } from './wizard';

// authConfigured() reads runtime secrets — never bake it at build time.
export const dynamic = 'force-dynamic';

export default function OnboardingPage() {
  return <OnboardingWizard authReady={authConfigured()} />;
}
