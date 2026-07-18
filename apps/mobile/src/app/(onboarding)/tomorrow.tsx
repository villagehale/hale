import { router } from 'expo-router';
import { View } from 'react-native';

import { CapabilityRow } from '@/components/onboarding/capability-row';
import { OnboardingScreen, ProgressDots } from '@/components/onboarding/onboarding-screen';
import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';

/**
 * Info 2 of 3 — "here's tomorrow." A single card previewing the kind of small,
 * timely help Hale surfaces once the family is set up. These rows are ILLUSTRATIVE
 * (an onboarding pitch, not the family's data or live connectors) — honest by nature,
 * so no per-row disclosure. Continues to the one-place beat.
 */
export default function TomorrowScreen() {
  return (
    <OnboardingScreen onSkip={() => router.push('/(onboarding)/child')}>
      <AppText variant="display" className="mt-6 text-center text-[26px] leading-[33px]">
        Here's what Hale{'\n'}quietly does for you.
      </AppText>

      <View className="mt-5 rounded-[20px] border border-rule bg-card p-4">
        <AppText variant="eyebrow" className="mb-3">
          Tomorrow
        </AppText>
        <View className="gap-3.5">
          <CapabilityRow icon="shield" tint="red" title="Vaccine reminder" sub="Due in 2 days" />
          <CapabilityRow
            icon="book-open"
            tint="yellow"
            title="Storytime nearby"
            sub="10 min from you"
          />
          <CapabilityRow icon="mail" tint="red" title="Draft daycare email" sub="Ready to review" />
          <CapabilityRow
            icon="calendar"
            tint="yellow"
            title="Weekly family plan"
            sub="All in one place"
          />
        </View>
      </View>

      <View className="flex-1" />
      <ProgressDots total={3} active={1} />
      <Button
        label="Continue"
        onPress={() => router.push('/(onboarding)/one-place')}
        className="mt-5"
      />
    </OnboardingScreen>
  );
}
