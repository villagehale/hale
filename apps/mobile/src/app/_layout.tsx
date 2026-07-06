import '@/global.css';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  useFonts,
} from '@expo-google-fonts/inter';
import { JetBrainsMono_500Medium } from '@expo-google-fonts/jetbrains-mono';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useRef, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SplashLoader } from '@/components/ui/splash-loader';
import { AuthProvider, useAuth } from '@/lib/auth';
import { submitOnboarding } from '@/lib/auth-api';
import { draftToOnboardingInput } from '@/lib/onboarding-draft';
import { onboardingDraftStore } from '@/lib/onboarding-draft-store';
import { usePushRegistration } from '@/lib/use-push-registration';

SplashScreen.preventAutoHideAsync();

/**
 * The routing gate. An UNAUTHENTICATED user lands in the (onboarding) group (the
 * welcome intro) — sign-in is reachable from there via "I already have an account".
 * They are also allowed to sit on /sign-in. An AUTHENTICATED user goes to (tabs);
 * if they're still parked in onboarding/sign-in, bounce them in.
 *
 * Loop-safety: the only pre-auth targets are (onboarding) and sign-in, and we
 * redirect ONLY when the current group is neither — so an unauthenticated user
 * already in (onboarding) or on /sign-in is left alone (no oscillation). Likewise
 * an authenticated user is redirected only while parked in those two groups.
 */
function useProtectedRoute(ready: boolean) {
  const { token } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!ready) return;
    const group = segments[0];
    const inPreAuth = group === '(onboarding)' || group === 'sign-in';
    if (!token && !inPreAuth) {
      router.replace('/(onboarding)/welcome');
    } else if (token && inPreAuth) {
      router.replace('/(tabs)');
    }
  }, [ready, token, segments, router]);
}

/**
 * Resume onboarding after email verification. Email sign-up doesn't mint a session
 * (verification is required), so the intake is kept in a local draft. Once the user
 * verifies out-of-app and signs in — OR on any first authed load with a draft still
 * saved — submit it. submitOnboarding is idempotent (a user who already has a
 * family gets `completed` with no re-provisioning), so a stale draft is safely
 * cleared. Runs once per authenticated session; the ref guards a re-entrant submit.
 */
function useResumeOnboarding(ready: boolean) {
  const { token } = useAuth();
  const submitting = useRef(false);

  useEffect(() => {
    if (!ready || !token || submitting.current) return;
    submitting.current = true;
    (async () => {
      const draft = await onboardingDraftStore.load();
      if (!draft || draft.children.length === 0) return;
      try {
        await submitOnboarding(draftToOnboardingInput(draft));
        await onboardingDraftStore.clear();
      } catch {
        // A 401 already bounced to sign-in; a transient failure leaves the draft in
        // place to retry on the next authed load. Never crash the shell.
      }
    })().finally(() => {
      submitting.current = false;
    });
  }, [ready, token]);
}

function RootNavigator() {
  const { isLoading, token } = useAuth();
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    JetBrainsMono_500Medium,
  });
  const [minElapsed, setMinElapsed] = useState(false);
  const ready = fontsLoaded && !isLoading;
  // Hold the animated splash for a short minimum so it reads as a deliberate intro,
  // not a flash — then hand off to Get started / sign-in / the app.
  const showSplash = !ready || !minElapsed;

  useProtectedRoute(ready);
  useResumeOnboarding(ready);
  usePushRegistration(ready && !!token);

  useEffect(() => {
    const timer = setTimeout(() => setMinElapsed(true), 1600);
    return () => clearTimeout(timer);
  }, []);

  // Hand off from the native splash the instant fonts are ready, so the animated
  // React splash (which needs those fonts) takes over with no white gap.
  useEffect(() => {
    if (fontsLoaded) SplashScreen.hideAsync();
  }, [fontsLoaded]);

  if (!fontsLoaded) return null;
  if (showSplash) return <SplashLoader />;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="(onboarding)" />
      <Stack.Screen name="sign-in" />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <RootNavigator />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
