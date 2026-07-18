import { Stack } from 'expo-router';

import { useReducedMotion } from '@/lib/use-reduced-motion';

/**
 * The pre-account onboarding flow: story → steps → preview → consent → create
 * account. A plain stack with no header — each screen owns its own chrome. The
 * routing gate in the root layout lands an unauthenticated user here; /sign-in is
 * reachable from the intro's "I already have an account".
 *
 * Each step arrives with the handoff's fade-up (`fadeUp 0.4s ease`), degrading to a
 * plain cross-dissolve under Reduce Motion.
 */
export default function OnboardingLayout() {
  const reduced = useReducedMotion();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: reduced ? 'fade' : 'fade_from_bottom',
        animationDuration: 400,
      }}
    />
  );
}
