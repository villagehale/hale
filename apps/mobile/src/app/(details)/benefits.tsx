import { router } from 'expo-router';
import { Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { DetailHeader } from '@/components/ui/detail-header';
import { Icon } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { Tag } from '@/components/ui/tag';
import { TintChip } from '@/components/ui/tint-chip';
import { useMeadowColor } from '@/constants/meadow';
import { STUB_BENEFITS } from '@/lib/stub-data';

/**
 * Government Benefits (handoff) — reached from Village → Resources. A DISCLOSED
 * reference to well-known Canadian child-benefit programs (stub-data): Hale does not
 * check eligibility or personalize amounts, so the rows are read-only and the ONE
 * real action is the navy "Ask Hale about eligibility" footer, which opens the Ask
 * tab. No family/child data is read here — nothing implies a tailored entitlement.
 */
export default function BenefitsScreen() {
  const introIcon = useMeadowColor('onAccent');

  return (
    <Screen scroll className="gap-4">
      <DetailHeader title="Government Benefits" />

      <Card className="gap-3">
        <View className="flex-row items-center gap-3">
          <TintChip icon="credit-card" tone="yellow" size={42} />
          <View className="flex-1">
            <AppText className="text-[16px] text-ink" style={{ fontFamily: 'InstrumentSans_700Bold' }}>
              Government Benefits
            </AppText>
            <AppText variant="meta" className="text-caption">
              Federal &amp; Ontario programs
            </AppText>
          </View>
        </View>
        <AppText variant="body">
          General programs many families with young children qualify for. Hale doesn&rsquo;t check your
          eligibility or amounts — tap below to ask.
        </AppText>
      </Card>

      <View className="gap-2.5">
        <AppText variant="eyebrow">Programs</AppText>
        <Card className="gap-0 p-0">
          {STUB_BENEFITS.map((program, i) => (
            <View
              key={program.name}
              className={`flex-row items-center gap-3 px-4 py-3.5 ${
                i === 0 ? '' : 'border-t border-hairline'
              }`}
            >
              <View className="flex-1">
                <AppText className="text-[14px] text-ink" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
                  {program.name}
                </AppText>
                <AppText variant="meta" className="text-caption">
                  {program.detail}
                </AppText>
              </View>
              <Tag label={program.jurisdiction} tone="neutral" />
            </View>
          ))}
        </Card>
        <AppText variant="meta" className="text-caption">
          Amounts are the programs&rsquo; published maximums and change each benefit year — check the official
          program for current figures and whether your family qualifies.
        </AppText>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Ask Hale about eligibility"
        onPress={() => router.push('/ask')}
        className="mt-1 min-h-12 flex-row items-center justify-center gap-2 rounded-[15px] bg-brand active:opacity-90"
      >
        <Icon name="sparkle-filled" size={16} color={introIcon} />
        <AppText className="text-[14.5px] text-on-ink" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
          Ask Hale about eligibility
        </AppText>
      </Pressable>
    </Screen>
  );
}
