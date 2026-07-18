import { router } from 'expo-router';
import { View } from 'react-native';

import { ChatBubble } from '@/components/onboarding/chat-bubble';
import { OnboardingScreen } from '@/components/onboarding/onboarding-screen';
import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Icon } from '@/components/ui/icon';
import { useMeadowColor } from '@/constants/meadow';
import { useOnboardingDraft } from '@/lib/use-onboarding-draft';

/**
 * Step 8 — "Where should I look for your village?" A coarse area only (rule #1): a
 * city and an optional postal code, never a precise address. The handoff draws a map
 * slot + "use my current location" rows; the honest mechanism the app actually has is
 * these two coarse fields (no device geolocation is wired, and precise coordinates
 * would violate rule #1), so the map slot is an illustrative placeholder over the
 * same city/postalCode draft the previous steps used. Both fields optional; discovery
 * just narrows with more.
 */
export default function AreaScreen() {
  const { draft, update } = useOnboardingDraft();
  const accent = useMeadowColor('accentFill');

  return (
    <OnboardingScreen scroll>
      <ChatBubble prompt="Where should I look for your village?" />

      <View className="my-5 h-[150px] items-center justify-center gap-2 rounded-[20px] bg-accent-tint">
        <Icon name="map-pin" size={28} color={accent} />
        <AppText variant="meta" className="text-ink-3">
          A neighbourhood, not an address
        </AppText>
      </View>

      <View className="gap-3">
        <Field
          label="City"
          value={draft.location.city ?? ''}
          onChangeText={(city) => update({ location: { ...draft.location, city } })}
          placeholder="Toronto"
          autoCapitalize="words"
        />
        <Field
          label="Postal code"
          value={draft.location.postalCode ?? ''}
          onChangeText={(postalCode) => update({ location: { ...draft.location, postalCode } })}
          placeholder="M5V 2T6"
          autoCapitalize="characters"
          hint="Drives neighbourhood discovery — never a precise address. Optional."
        />
      </View>

      <View className="flex-1" />
      <Button
        label="Continue"
        onPress={() => router.push('/(onboarding)/intents')}
        className="mt-6"
      />
      <AppText variant="meta" className="mt-3 text-center text-caption">
        We never store your exact address.
      </AppText>
    </OnboardingScreen>
  );
}
