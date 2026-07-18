import { router } from 'expo-router';
import { View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Icon, type IconName } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { useMeadowColor } from '@/constants/meadow';

/**
 * Screen 4 — "Here's what Hale quietly does for you." On the warm canvas. These
 * are SAMPLE cards: illustrations of capability, not live data. Each is explicitly
 * labelled "Example" so it can never be mistaken for a real reminder before the
 * family exists. The three are honest about what Hale can do WITHOUT any connected
 * account — a vaccine nudge from the child's age, a storytime pick, a weekly plan —
 * so nothing here implies email/calendar connectors are live (they aren't; the
 * connect step is a later, unbuilt seam).
 */
const SAMPLES: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'syringe',
    title: 'A gentle vaccine reminder',
    body: '“Maya’s 6-month shots are coming up in two weeks — want me to find a nearby clinic?”',
  },
  {
    icon: 'book-open',
    title: 'A storytime worth the trip',
    body: '“There’s a toddler storytime at the library Saturday morning — a short walk from you.”',
  },
  {
    icon: 'calendar',
    title: 'Your week, thought through',
    body: '“Here’s a calm plan for the week ahead — naps, one outing, and nothing overbooked.”',
  },
];

function SampleCard({ icon, title, body }: { icon: IconName; title: string; body: string }) {
  const accent = useMeadowColor('accentFill');
  return (
    <View className="gap-3 rounded-lg border border-rule bg-card p-4">
      <View className="flex-row items-center gap-3">
        <View className="h-9 w-9 items-center justify-center rounded-full bg-accent-tint">
          <Icon name={icon} size={17} color={accent} />
        </View>
        <View className="flex-1">
          <AppText variant="section">{title}</AppText>
        </View>
        <View className="rounded-full bg-raised px-2 py-0.5">
          <AppText variant="eyebrow">
            Example
          </AppText>
        </View>
      </View>
      <AppText variant="body" className="text-ink-2">
        {body}
      </AppText>
    </View>
  );
}

export default function CapabilitiesScreen() {
  return (
    <Screen scroll className="gap-6">
      <View className="gap-2 pt-4">
        <AppText variant="display">Here's what Hale quietly does for you.</AppText>
        <AppText variant="body">
          A few examples — the kind of small, timely help that shows up once your family is set up.
        </AppText>
      </View>

      <View className="gap-3">
        {SAMPLES.map((sample) => (
          <SampleCard key={sample.title} {...sample} />
        ))}
      </View>

      <Button label="Continue" onPress={() => router.push('/(onboarding)/child')} className="mt-2" />
    </Screen>
  );
}
