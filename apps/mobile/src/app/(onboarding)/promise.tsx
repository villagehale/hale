import { router } from 'expo-router';
import { View } from 'react-native';

import { OnboardingScreen, ProgressDots } from '@/components/onboarding/onboarding-screen';
import { VillageHouses } from '@/components/illustrations/village-houses';
import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';

/**
 * Info 1 of 3 — the promise. The village Hale rebuilds is the point, not the tooling.
 * Opens the three-beat triptych; continues into "here's tomorrow".
 */
export default function PromiseScreen() {
  return (
    <OnboardingScreen onSkip={() => router.push('/(onboarding)/child')}>
      <AppText variant="display" className="mt-6 text-center text-[27px] leading-[35px]">
        Parenting was never meant to be done alone.
      </AppText>

      <View className="flex-1 items-center justify-center">
        <VillageHouses width={230} />
      </View>

      <View className="gap-1">
        <AppText variant="body" className="text-center text-[14.5px] leading-[23px] text-ink-2">
          For generations, families relied on grandparents, neighbours and friends.
        </AppText>
        <AppText variant="section" className="text-center text-[14.5px] leading-[23px]">
          We're rebuilding that village.
        </AppText>
      </View>

      <View className="mt-6">
        <ProgressDots total={3} active={0} />
      </View>
      <Button
        label="Continue"
        onPress={() => router.push('/(onboarding)/tomorrow')}
        className="mt-5"
      />
    </OnboardingScreen>
  );
}
