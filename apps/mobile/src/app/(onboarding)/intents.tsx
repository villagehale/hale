import { router } from 'expo-router';
import { Pressable, View } from 'react-native';

import { StepScreen } from '@/components/onboarding/step-screen';
import { AppText } from '@/components/ui/app-text';
import { Icon, type IconName } from '@/components/ui/icon';
import { useMeadowColor } from '@/constants/meadow';
import { ONBOARDING_INTENTS } from '@/lib/onboarding-intents';
import { useOnboardingDraft } from '@/lib/use-onboarding-draft';

/** A leading glyph per intent, so each chip reads at a glance. Every symbol here
 * has an icon.web.tsx fallback so the RN-web preview reads true too. */
const INTENT_ICON: Record<string, IconName> = {
  activities: 'sparkles',
  childcare: 'figure.2.and.child.holdinghands',
  milestones: 'star.fill',
  planning: 'calendar',
  sitter: 'person.2',
  health: 'heart',
  community: 'person.3',
  exploring: 'magnifyingglass',
};

/**
 * Screen 8 — "What's keeping you busy lately?" The intent chips. Optional; they
 * steer the anonymous preview (screen 9) and later discovery. Multi-select, saved
 * to the draft on every tap.
 */
export default function IntentsScreen() {
  const { draft, update } = useOnboardingDraft();
  // The active chip is `bg-ink` with an on-ink label; `canvas` is that on-ink color.
  const activeIcon = useMeadowColor('canvas');
  const idleIcon = useMeadowColor('ink2');

  const toggle = (value: string) => {
    const has = draft.intents.includes(value);
    update({
      intents: has ? draft.intents.filter((v) => v !== value) : [...draft.intents, value],
    });
  };

  return (
    <StepScreen
      step={4}
      total={5}
      eyebrow="Your goals"
      title="What's keeping you busy lately?"
      hint="Pick any that fit — or none. This just helps Hale start in the right place."
      onContinue={() => router.push('/(onboarding)/preview')}
    >
      <View className="flex-row flex-wrap gap-2">
        {ONBOARDING_INTENTS.map((intent) => {
          const active = draft.intents.includes(intent.value);
          return (
            <Pressable
              key={intent.value}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={intent.label}
              onPress={() => toggle(intent.value)}
              className={`flex-row items-center gap-2 rounded-full border px-4 py-2.5 active:opacity-80 ${
                active ? 'border-ink bg-ink' : 'border-rule bg-card'
              }`}
            >
              <Icon
                name={INTENT_ICON[intent.value]}
                size={15}
                color={active ? activeIcon : idleIcon}
              />
              <AppText variant="meta" className={active ? 'text-on-ink' : 'text-ink-2'}>
                {intent.label}
              </AppText>
            </Pressable>
          );
        })}
      </View>
    </StepScreen>
  );
}
