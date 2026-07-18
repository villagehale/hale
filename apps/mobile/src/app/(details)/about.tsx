import Constants from 'expo-constants';
import { Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { DetailHeader } from '@/components/ui/detail-header';
import { Icon } from '@/components/ui/icon';
import { LogoMark } from '@/components/ui/logo-mark';
import { Screen } from '@/components/ui/screen';
import { useMeadowColor } from '@/constants/meadow';
import { openPolicy } from '@/lib/policy-links';

/** The legal rows open the LIVE Hale policy pages in the in-app browser (the same
 * /terms and /privacy the onboarding consent step links to). The prototype's
 * "Open-source licences" row is omitted — there is no such page to open, and a dead
 * row would be dishonest. */
function LegalRow({ label, path, last }: { label: string; path: string; last?: boolean }) {
  const chevron = useMeadowColor('ink3');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => openPolicy(path)}
      className={`flex-row items-center gap-3 px-4 py-3.5 active:opacity-80 ${last ? '' : 'border-b border-hairline'}`}
    >
      <AppText className="flex-1 text-[13.5px] text-ink" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
        {label}
      </AppText>
      <Icon name="square-arrow-out-up-right" size={15} color={chevron} />
    </Pressable>
  );
}

/**
 * About Hale (handoff), reached from Settings → Other. The brand mark, the serif
 * wordmark, the REAL app version (Constants.expoConfig.version — never the prototype's
 * hardcoded "1.2.0"), a one-line blurb, and legal rows opening the live Terms /
 * Privacy pages.
 */
export default function AboutScreen() {
  const version = Constants.expoConfig?.version ?? '—';
  return (
    <Screen scroll className="gap-4">
      <DetailHeader title="About Hale" />

      <View className="items-center gap-2 py-4">
        <LogoMark size={64} />
        <AppText variant="title" className="mt-1 text-brand">
          Hale
        </AppText>
        <AppText variant="meta" className="text-caption">
          Version {version}
        </AppText>
      </View>

      <AppText variant="body" className="px-2 text-center text-ink-2">
        Hawaiian for &ldquo;home&rdquo;. Hale is your family&rsquo;s quiet helper — because every
        family deserves a village.
      </AppText>

      <Card className="gap-0 p-0">
        <LegalRow label="Terms of Service" path="/terms" />
        <LegalRow label="Privacy Policy" path="/privacy" last />
      </Card>
    </Screen>
  );
}
