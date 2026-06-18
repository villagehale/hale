import { authConfigured } from '~/lib/auth-config';
import { OnboardingWizard } from './wizard';

export default function OnboardingPage() {
  return <OnboardingWizard authReady={authConfigured()} />;
}
