import { Stack } from 'expo-router';

/**
 * The pre-account onboarding flow: story → steps → preview → consent → create
 * account. A plain stack with no header — each screen owns its own chrome. The
 * routing gate in the root layout lands an unauthenticated user here; /sign-in is
 * reachable from the intro's "I already have an account".
 */
export default function OnboardingLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
