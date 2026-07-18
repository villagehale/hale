import { router } from 'expo-router';
import { Pressable, View } from 'react-native';

import { OnboardingScreen } from '@/components/onboarding/onboarding-screen';
import { TurtleMascot } from '@/components/illustrations/turtle-mascot';
import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { LogoMark } from '@/components/ui/logo-mark';

/**
 * Step 2 — "Hi, I'm Hale." The first beat on the warm canvas: the turtle chip, a
 * warm hello, and Kai the mascot. "Let's begin" opens the promise triptych; "Skip"
 * (top-right) jumps past the intro to the first setup step; "Sign in" is the escape
 * hatch to the existing account flow (reachable from the very start, per the routing
 * gate). The animated SplashLoader (step 1) precedes this on app open.
 */
export default function WelcomeScreen() {
  return (
    <OnboardingScreen onSkip={() => router.push('/(onboarding)/child')}>
      <LogoMark size={44} />
      <AppText variant="display" className="mt-5 text-[38px] leading-[44px]">
        Hi 👋{'\n'}I'm Hale.
      </AppText>
      <View className="mt-3 gap-2">
        <AppText variant="body" className="text-[16px] leading-[25px] text-ink-2">
          I'll quietly help your family, every day.
        </AppText>
        <AppText variant="body" className="text-[16px] leading-[25px] text-ink-2">
          Let's get to know each other.
        </AppText>
      </View>

      <View className="flex-1 items-center justify-center">
        <TurtleMascot width={200} />
      </View>

      <Button
        label="Let's begin"
        trailingIcon="arrow-right"
        onPress={() => router.push('/(onboarding)/promise')}
      />
      <Pressable
        accessibilityRole="link"
        accessibilityLabel="Already have an account? Sign in"
        onPress={() => router.push('/sign-in')}
        className="mt-3 flex-row items-center justify-center active:opacity-70"
      >
        <AppText variant="meta" className="text-caption">
          Already have an account?{' '}
        </AppText>
        <AppText variant="meta" className="text-brand">
          Sign in
        </AppText>
      </Pressable>
    </OnboardingScreen>
  );
}
