import { router } from 'expo-router';
import { useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { LogoMark } from '@/components/ui/logo-mark';
import { useMeadowColor } from '@/constants/meadow';
import { onboardingChildName } from '@/lib/onboarding-child-name';

/**
 * Step 13 — "Your village is ready." The post-auth closer, and the LAST screen of
 * onboarding. Pure celebration: the account, consent, and family were already
 * created at the create-account step (that's where the tosAccepted act is captured
 * and the 4 provisioning consent records are written) — this screen records nothing,
 * it just confirms and hands the parent into the app. The child's given name comes
 * from the in-process stash set as the draft was submitted; a cold start into the
 * tail falls back to neutral copy.
 */
const CARD_LIGHT = '#f5f4ef';
const CARD_DARK = '#242019';

const PILLARS = [
  'Hale only acts with your approval',
  'Your data stays private & secure',
  'Disconnect anytime',
];

export default function ConsentScreen() {
  const cardBg = useColorScheme() === 'dark' ? CARD_DARK : CARD_LIGHT;
  const check = useMeadowColor('onAccent');
  const child = onboardingChildName();

  return (
    <SafeAreaView className="flex-1 bg-canvas px-7 pb-6" edges={['top', 'left', 'right', 'bottom']}>
      <View className="flex-[0.8]" />
      <View className="items-center">
        <LogoMark size={76} radius={22} />
        <AppText variant="display" className="mt-6 text-center text-[31px] leading-[37px]">
          Your village{'\n'}is ready.
        </AppText>
        <AppText variant="body" className="mt-2 text-center text-ink-2">
          Hale is set up for {child ?? 'your family'} — quietly helpful, always in your corner.
        </AppText>
      </View>

      <View className="flex-1" />

      <View className="rounded-[20px] px-4" style={{ backgroundColor: cardBg }}>
        {PILLARS.map((label, i) => (
          <View
            key={label}
            className={`flex-row items-center gap-2.5 py-3 ${
              i < PILLARS.length - 1 ? 'border-b border-rule' : ''
            }`}
          >
            <View className="h-[22px] w-[22px] items-center justify-center rounded-full bg-success">
              <Icon name="check" size={12} color={check} />
            </View>
            <AppText variant="section" className="text-[13.5px]">
              {label}
            </AppText>
          </View>
        ))}
      </View>

      <Button
        label="Open your village"
        trailingIcon="arrow-right"
        onPress={() => router.replace('/(tabs)')}
        className="mt-5"
      />
      <AppText variant="meta" className="mt-3 text-center text-caption">
        You agreed to the Terms & Privacy Policy when you created your account.
      </AppText>
    </SafeAreaView>
  );
}
