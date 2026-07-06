import { router } from 'expo-router';
import { Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { LogoMark } from '@/components/ui/logo-mark';
import { Screen } from '@/components/ui/screen';

/**
 * The warm branded welcome — the first thing a new (unauthenticated) parent sees.
 * The turtle chip + "Hale" wordmark + one-line value prop, a primary "Get started"
 * into the tutorial, and a quiet "I already have an account" into the existing
 * sign-in screen.
 */
export default function OnboardingIntroScreen() {
  return (
    <Screen className="justify-between">
      <View className="flex-1 items-center justify-center gap-5">
        <LogoMark size={96} />
        <View className="items-center gap-2">
          <AppText variant="display" className="text-sea">
            Hale
          </AppText>
          <AppText variant="body" className="max-w-[300px] text-center">
            The quiet village that helps your family through every stage of childhood.
          </AppText>
        </View>
      </View>

      <View className="gap-4 pb-2">
        <Button label="Get started" onPress={() => router.push('/(onboarding)/tutorial')} />
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="I already have an account, sign in"
          onPress={() => router.push('/sign-in')}
          className="flex-row items-center justify-center active:opacity-70"
        >
          <AppText variant="meta">Already have an account? </AppText>
          <AppText variant="meta" className="text-accent">
            Sign in
          </AppText>
        </Pressable>
      </View>
    </Screen>
  );
}
