import '@/global.css';
import {
  InstrumentSans_400Regular,
  InstrumentSans_500Medium,
  InstrumentSans_600SemiBold,
  InstrumentSans_700Bold,
  useFonts,
} from '@expo-google-fonts/instrument-sans';
import {
  SourceSerif4_500Medium,
  SourceSerif4_600SemiBold,
} from '@expo-google-fonts/source-serif-4';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useRef, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SplashLoader } from '@/components/ui/splash-loader';
import { AuthProvider, useAuth } from '@/lib/auth';
import { submitOnboarding } from '@/lib/auth-api';
import { postAuthHold, setPostAuthHold } from '@/lib/post-auth-hold';
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
 *
 * The post-auth HOLD (a synchronous module ref, see post-auth-hold.ts) suppresses
 * the tabs-bounce for a JUST-onboarded user: create-account sets it BEFORE the
 * token commits (React state cannot win that same-flush race), and the resume
 * effect provisions the family then routes to /connect itself, releasing the hold
 * on every exit. `/connect` is a top-level route (neither pre-auth group), so once
 * the user is there the gate leaves them alone.
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
    } else if (token && inPreAuth && !postAuthHold()) {
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
 *
 * A JUST-onboarded user (a draft was present) is then handed to the post-account
 * /connect step — but only AFTER provisioning lands, because connecting a Google
 * account needs the family to exist. While that submit is in flight the post-auth
 * HOLD (set by create-account before the token committed) suppresses the gate's
 * tabs-bounce; every exit path here releases it and navigates explicitly.
 */
function useResumeOnboarding(ready: boolean) {
  const { token } = useAuth();
  const router = useRouter();
  const submitting = useRef(false);

  useEffect(() => {
    if (!ready || !token || submitting.current) return;
    submitting.current = true;
    (async () => {
      const held = postAuthHold();
      const draft = await onboardingDraftStore.load();
      if (!draft || draft.children.length === 0) {
        if (held) {
          // Hold set but nothing to submit (draft vanished): release and land in
          // the app — the gate's bounce already deferred to us.
          setPostAuthHold(false);
          router.replace('/(tabs)');
        }
        return;
      }
      try {
        await submitOnboarding(draftToOnboardingInput(draft));
        await onboardingDraftStore.clear();
        setPostAuthHold(false);
        router.replace('/connect');
      } catch {
        // A 401 already bounced to sign-in; a transient failure leaves the draft in
        // place to retry on the next authed load. Never crash the shell.
        if (held) {
          setPostAuthHold(false);
          router.replace('/(tabs)');
        }
      }
    })().finally(() => {
      submitting.current = false;
    });
  }, [ready, token, router]);
}

function RootNavigator() {
  const { isLoading, token } = useAuth();
  const [fontsLoaded] = useFonts({
    SourceSerif4_500Medium,
    SourceSerif4_600SemiBold,
    InstrumentSans_400Regular,
    InstrumentSans_500Medium,
    InstrumentSans_600SemiBold,
    InstrumentSans_700Bold,
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
      <Stack.Screen name="(details)" />
      <Stack.Screen name="(onboarding)" />
      <Stack.Screen name="connect" />
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
