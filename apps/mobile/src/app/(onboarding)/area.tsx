import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { ChatBubble } from '@/components/onboarding/chat-bubble';
import { OnboardingScreen } from '@/components/onboarding/onboarding-screen';
import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Icon } from '@/components/ui/icon';
import { useMeadowColor } from '@/constants/meadow';
import { resolveCoarseLocation } from '@/lib/current-location';
import { useOnboardingDraft } from '@/lib/use-onboarding-draft';

/**
 * Step 8 — "Where should I look for your village?" A coarse area only (rule #1): a
 * city and an optional postal code, never a precise address. "Use my current location"
 * resolves the device location to a coarse {city, province} ON-DEVICE and fills the
 * city — precise coordinates never leave the phone (see resolveCoarseLocation). The map
 * slot reflects the chosen coarse area rather than a precise pin (a real city-centroid
 * map needs an on-device city→centroid geocode + native map, a follow-up); both fields
 * optional, discovery just narrows with more.
 */
export default function AreaScreen() {
  const { draft, update } = useOnboardingDraft();
  const accent = useMeadowColor('accentFill');
  const brandIcon = useMeadowColor('brand');
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState<string | null>(null);

  const city = draft.location.city?.trim() ?? '';

  const useCurrent = async () => {
    if (locating) return;
    setLocating(true);
    setLocError(null);
    try {
      const resolved = await resolveCoarseLocation();
      if (resolved.status === 'denied') {
        setLocError('Location permission is off — type your city instead.');
        return;
      }
      if (resolved.status === 'unavailable') {
        setLocError("We couldn't find your area — type your city instead.");
        return;
      }
      // Only the coarse city name is kept (the draft has no coordinate field, rule #1).
      update({ location: { ...draft.location, city: resolved.place.city } });
    } finally {
      setLocating(false);
    }
  };

  return (
    <OnboardingScreen scroll>
      <ChatBubble prompt="Where should I look for your village?" />

      <View className="my-5 h-[150px] items-center justify-center gap-2 rounded-[20px] bg-accent-tint">
        <Icon name="map-pin" size={28} color={accent} />
        {city ? (
          <AppText variant="title" className="text-ink">
            {city}
          </AppText>
        ) : null}
        <AppText variant="meta" className="text-ink-3">
          A neighbourhood, not an address
        </AppText>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Use my current location"
        accessibilityState={{ disabled: locating }}
        disabled={locating}
        onPress={useCurrent}
        className={`mb-3 min-h-12 flex-row items-center justify-center gap-2 rounded-[14px] border border-rule bg-card ${
          locating ? 'opacity-50' : 'active:opacity-80'
        }`}
      >
        <Icon name="crosshair" size={15} color={brandIcon} />
        <AppText
          variant="meta"
          className="text-brand"
          style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
        >
          {locating ? 'Finding your area…' : 'Use my current location'}
        </AppText>
      </Pressable>

      {locError ? (
        <AppText variant="meta" className="mb-3 text-ink-3" accessibilityLiveRegion="polite">
          {locError}
        </AppText>
      ) : null}

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
