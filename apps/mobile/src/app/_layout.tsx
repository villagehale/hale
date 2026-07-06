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
import { useEffect, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SplashLoader } from '@/components/ui/splash-loader';
import { AuthProvider, useAuth } from '@/lib/auth';
import { usePushRegistration } from '@/lib/use-push-registration';

SplashScreen.preventAutoHideAsync();

function useProtectedRoute(ready: boolean) {
  const { token } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!ready) return;
    const onSignIn = segments[0] === 'sign-in';
    if (!token && !onSignIn) {
      router.replace('/sign-in');
    } else if (token && onSignIn) {
      router.replace('/');
    }
  }, [ready, token, segments, router]);
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
