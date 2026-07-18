import { router } from 'expo-router';
import { Pressable, View } from 'react-native';

import { ChatBubble } from '@/components/onboarding/chat-bubble';
import { OnboardingScreen } from '@/components/onboarding/onboarding-screen';
import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { ONBOARDING_INTENTS } from '@/lib/onboarding-intents';
import { useOnboardingDraft } from '@/lib/use-onboarding-draft';

/**
 * Prototype-forward chip copy over the REAL backend intent values. The values are
 * the canonical @hale/types set (mirrored in onboarding-intents.ts) — the server's
 * parseIntents drops anything else, so every chip MUST map to one of them. The
 * handoff's baby-care chips (Sleep & naps / Feeding & meals / Potty training) have
 * no backend twin, so the reconciliation keeps prototype copy for the five intents
 * that map cleanly and the real discovery-intent labels for the three that don't —
 * never a chip that stores nothing or misdescribes what it saves (no-fabrication).
 * Values are sourced from ONBOARDING_INTENTS so a new backend intent falls back to
 * its own label rather than silently vanishing.
 */
const CHIP_LABEL: Record<string, string> = {
  activities: 'Activities & play',
  childcare: 'Childcare',
  milestones: 'Milestones',
  health: 'Health & vaccines',
  planning: 'Weekly planning',
  sitter: 'Trusted sitter',
  community: 'Meeting other families',
  exploring: 'A bit of everything',
};

/**
 * Step 9 — "What's on your plate with {child} lately?" The intent chips. Optional;
 * they steer the family's first discovery and later help. Multi-select, saved to the
 * draft on every tap — the selection/save logic is unchanged from the prior step.
 */
export default function IntentsScreen() {
  const { draft, update } = useOnboardingDraft();
  const childName = draft.children[0]?.name.trim();

  const toggle = (value: string) => {
    const has = draft.intents.includes(value);
    update({
      intents: has ? draft.intents.filter((v) => v !== value) : [...draft.intents, value],
    });
  };

  return (
    <OnboardingScreen scroll>
      <ChatBubble
        prompt={`What's on your plate with ${childName || 'your little one'} lately?`}
        sub="Pick any that fit — Hale will tune its help."
      />

      <View className="mt-6 flex-row flex-wrap gap-2.5">
        {ONBOARDING_INTENTS.map((intent) => {
          const active = draft.intents.includes(intent.value);
          return (
            <Pressable
              key={intent.value}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={CHIP_LABEL[intent.value] ?? intent.label}
              onPress={() => toggle(intent.value)}
              className={`grow basis-[47%] flex-row items-center gap-2.5 rounded-[14px] border-[1.5px] p-3.5 active:opacity-80 ${
                active ? 'border-brand bg-chip-blue' : 'border-rule bg-card'
              }`}
            >
              <View className={`h-2 w-2 rounded-full ${active ? 'bg-brand' : 'bg-rule-strong'}`} />
              <AppText variant="section" className="flex-1 text-[13.5px] text-ink">
                {CHIP_LABEL[intent.value] ?? intent.label}
              </AppText>
            </Pressable>
          );
        })}
      </View>

      <View className="flex-1" />
      <Button
        label="Continue"
        onPress={() => router.push('/(onboarding)/create-account')}
        className="mt-6"
      />
    </OnboardingScreen>
  );
}
