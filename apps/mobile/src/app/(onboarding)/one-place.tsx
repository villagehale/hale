import { router } from 'expo-router';
import { View } from 'react-native';

import { CapabilityRow } from '@/components/onboarding/capability-row';
import { OnboardingScreen, ProgressDots } from '@/components/onboarding/onboarding-screen';
import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';

/**
 * Info 3 of 3 — everything in one place. Closes the triptych: the three things Hale
 * keeps for the child (health, milestones, routines). "Get started" hands off to the
 * first real setup step (the child form).
 */
export default function OnePlaceScreen() {
  return (
    <OnboardingScreen onSkip={() => router.push('/(onboarding)/child')}>
      <AppText variant="display" className="mt-6 text-center text-[26px] leading-[33px]">
        Everything about{'\n'}your child, in one place.
      </AppText>

      <View className="mt-5 rounded-[20px] border border-rule bg-card px-4">
        <View className="border-b border-hairline py-3">
          <CapabilityRow
            icon="shield"
            tint="green"
            title="Health & vaccines"
            sub="Timelines built on the Canadian schedule"
          />
        </View>
        <View className="border-b border-hairline py-3">
          <CapabilityRow
            icon="sparkle-filled"
            tint="yellow"
            title="Milestones"
            sub="Tracked gently, celebrated together"
          />
        </View>
        <View className="py-3">
          <CapabilityRow
            icon="moon"
            tint="blue"
            title="Routines & memories"
            sub="Naps, meals and firsts — logged in seconds"
          />
        </View>
      </View>

      <View className="flex-1" />
      <ProgressDots total={3} active={2} />
      <Button
        label="Get started"
        onPress={() => router.push('/(onboarding)/child')}
        className="mt-5"
      />
    </OnboardingScreen>
  );
}
