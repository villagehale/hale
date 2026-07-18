import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { DetailHeader } from '@/components/ui/detail-header';
import { Icon } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { useMeadowColor } from '@/constants/meadow';
import { type GuideContent, findGuide } from '@/lib/stub-data';

/**
 * A Resources guide page (handoff): serif title, an honest meta line, an intro, a
 * numbered tip card, and a single "Ask Hale about this" action that opens the Ask tab.
 *
 * HONESTY: the prototype's meta reads "· Reviewed by Hale's care team" — Hale has no
 * clinical care-team review process, so that claim is dropped for the truthful "From
 * Hale's guide library" (see GUIDES doc + task-14-report.md). The Ask handoff is plain
 * navigation: the Ask tab takes no prefill param (mirrors the Benefits page), so there
 * is no faked "context" — the parent lands on Ask ready to type.
 */
function GuideBody({ guide }: { guide: GuideContent }) {
  const sparkle = useMeadowColor('brand');
  return (
    <>
      <AppText variant="title" className="mt-1 text-[25px] leading-[31px]">
        {guide.title}
      </AppText>
      <AppText variant="meta" className="-mt-1 text-caption">
        {guide.readTime} · From Hale&rsquo;s guide library
      </AppText>
      <AppText variant="body">{guide.intro}</AppText>

      <View className="overflow-hidden rounded-[20px] border border-rule bg-card">
        {guide.tips.map((tip, i) => (
          <View
            key={tip}
            className={`flex-row items-start gap-3 px-4 py-3.5 ${
              i === guide.tips.length - 1 ? '' : 'border-b border-hairline'
            }`}
          >
            <View className="h-6 w-6 items-center justify-center rounded-full bg-chip-blue">
              <AppText
                className="text-[12px] text-brand"
                style={{ fontFamily: 'InstrumentSans_700Bold' }}
              >
                {i + 1}
              </AppText>
            </View>
            <AppText
              className="flex-1 pt-0.5 text-[13.5px] leading-[20px] text-ink"
              style={{ fontFamily: 'InstrumentSans_500Medium' }}
            >
              {tip}
            </AppText>
          </View>
        ))}
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Ask Hale about this"
        onPress={() => router.push('/ask')}
        className="min-h-12 flex-row items-center justify-center gap-2 rounded-[14px] border border-rule bg-card active:opacity-80"
      >
        <Icon name="sparkle-filled" size={15} color={sparkle} />
        <AppText className="text-[14px] text-ink" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
          Ask Hale about this
        </AppText>
      </Pressable>
    </>
  );
}

export default function GuideScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const guide = findGuide(id);

  return (
    <Screen scroll className="gap-4">
      <DetailHeader title="Guide" />
      {guide ? (
        <GuideBody guide={guide} />
      ) : (
        <Card className="mt-2 items-center gap-2 py-10">
          <AppText variant="title">Guide not found</AppText>
          <AppText variant="meta" className="text-center">
            This guide isn&rsquo;t available. Head back to Resources to browse the library.
          </AppText>
        </Card>
      )}
    </Screen>
  );
}
