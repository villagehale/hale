import { router } from 'expo-router';
import { View } from 'react-native';

import { StepScreen } from '@/components/onboarding/step-screen';
import { Field } from '@/components/ui/field';
import { useOnboardingDraft } from '@/lib/use-onboarding-draft';

/**
 * Screen 7 — "Where should I look for your village?" A coarse area only (rule #1):
 * a city and an optional postal code, never a precise address. No map — the
 * pre-auth flow has no honest map to show (the map proxy is authed + candidate-
 * keyed), so the copy carries the neighbourhood idea instead. Both fields are
 * optional; discovery just narrows with more.
 */
export default function AreaScreen() {
  const { draft, update } = useOnboardingDraft();

  return (
    <StepScreen
      step={3}
      total={5}
      eyebrow="Your area"
      title="Where should I look for your village?"
      hint="A neighbourhood, not an address — Hale only ever needs a coarse area to find what's nearby."
      onContinue={() => router.push('/(onboarding)/intents')}
    >
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
    </StepScreen>
  );
}
