import { router } from 'expo-router';
import { useRef, useState } from 'react';
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  View,
  useWindowDimensions,
} from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Icon, type IconName } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { useMeadowColor } from '@/constants/meadow';

/** The three things a new parent should know before the intake — passive help, the
 * village, privacy-first/Canada. Short and reassuring, not a feature tour. */
const CARDS: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'sparkles',
    title: 'Help that comes to you',
    body: 'Hale watches quietly and surfaces the right nudge at the right moment — you never have to ask a blank box what to do next.',
  },
  {
    icon: 'person.2.fill',
    title: 'Your village, rebuilt',
    body: 'Nearby classes, trusted sitters, and other families — the neighbourhood support that used to come by word of mouth, gathered for you.',
  },
  {
    icon: 'lock.shield.fill',
    title: 'Private by default',
    body: "Your family's data stays in Canada and is never sold. You approve every action before Hale takes it. Nothing happens behind your back.",
  },
];

function toIntake() {
  router.replace('/(onboarding)/intake');
}

export default function TutorialScreen() {
  const { width } = useWindowDimensions();
  const scrollRef = useRef<ScrollView>(null);
  const [page, setPage] = useState(0);
  const accent = useMeadowColor('accentFill');
  const inkColor = useMeadowColor('ink');
  const isLast = page === CARDS.length - 1;

  // The card is inset by the Screen's px-5 (20) each side; a page is one viewport.
  const pageWidth = width - 40;

  const onMomentumEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = Math.round(e.nativeEvent.contentOffset.x / pageWidth);
    if (next !== page) setPage(next);
  };

  const onContinue = () => {
    if (isLast) {
      toIntake();
      return;
    }
    const next = page + 1;
    scrollRef.current?.scrollTo({ x: next * pageWidth, animated: true });
    setPage(next);
  };

  return (
    <Screen className="justify-between">
      <View className="flex-row justify-end pt-1">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Skip the tutorial"
          onPress={toIntake}
          className="px-2 py-1 active:opacity-70"
        >
          <AppText variant="meta" className="text-ink-3">
            Skip
          </AppText>
        </Pressable>
      </View>

      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onMomentumEnd}
        className="flex-none"
      >
        {CARDS.map((card) => (
          <View
            key={card.title}
            style={{ width: pageWidth }}
            className="items-center justify-center gap-6 px-2"
          >
            <View className="h-20 w-20 items-center justify-center rounded-full bg-accent-tint">
              <Icon name={card.icon} size={34} color={accent} />
            </View>
            <View className="items-center gap-3">
              <AppText variant="display" className="text-center">
                {card.title}
              </AppText>
              <AppText variant="body" className="max-w-[320px] text-center">
                {card.body}
              </AppText>
            </View>
          </View>
        ))}
      </ScrollView>

      <View className="gap-6 pb-2">
        <View
          accessibilityRole="progressbar"
          accessibilityLabel={`Step ${page + 1} of ${CARDS.length}`}
          className="flex-row items-center justify-center gap-2"
        >
          {CARDS.map((card, i) => (
            <View
              key={card.title}
              style={i === page ? { backgroundColor: inkColor } : undefined}
              className={`h-2 rounded-full ${i === page ? 'w-6' : 'w-2 bg-rule-strong'}`}
            />
          ))}
        </View>
        <Button label={isLast ? 'Get set up' : 'Continue'} onPress={onContinue} />
      </View>
    </Screen>
  );
}
