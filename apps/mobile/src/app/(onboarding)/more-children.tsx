import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { ChatBubble } from '@/components/onboarding/chat-bubble';
import { ChildFields, dobLabel } from '@/components/onboarding/child-fields';
import { OnboardingScreen } from '@/components/onboarding/onboarding-screen';
import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { useMeadowColor } from '@/constants/meadow';
import type { DraftChild } from '@/lib/onboarding-draft';
import { useOnboardingDraft } from '@/lib/use-onboarding-draft';

/**
 * Step 7 — "Anyone else?" The first child (from step 6) sits as a settled card (its
 * pencil returns to the first-child step to edit); siblings are added with the same
 * ChildFields inputs against the same persisted draft. Half-filled extra rows are
 * dropped before moving on, so a one-child family isn't blocked. "No, that's
 * everyone" needs no additional child — the first is already valid.
 */
export default function MoreChildrenScreen() {
  const { draft, update } = useOnboardingDraft();
  const [error, setError] = useState<string | null>(null);
  const brand = useMeadowColor('brand');
  const pencilColor = useMeadowColor('ink3');

  const first = draft.children[0];
  const extras = draft.children.slice(1);

  // Updater form throughout: children edits must be computed against the LATEST
  // persisted draft, never this screen's snapshot (backed-into screens are stale).
  const addChild = () =>
    update((latest) => ({ children: [...latest.children, { name: '', dateOfBirth: '' }] }));
  const updateExtra = (index: number, next: DraftChild) =>
    update((latest) => ({
      children: latest.children.map((c, i) => (i === index + 1 ? next : c)),
    }));
  const removeExtra = (index: number) =>
    update((latest) => ({ children: latest.children.filter((_, i) => i !== index + 1) }));

  const onContinue = () => {
    const incomplete = extras.some((c) => !!c.name.trim() !== !!c.dateOfBirth);
    if (incomplete) {
      setError('Please add both a name and a birthday for each child you added.');
      return;
    }
    // Drop any half-filled extra rows so a family with one child isn't blocked.
    update((latest) => ({
      children: latest.children.filter((c, i) => i === 0 || (c.name.trim() && c.dateOfBirth)),
    }));
    router.push('/(onboarding)/area');
  };

  return (
    <OnboardingScreen scroll>
      <ChatBubble prompt="Anyone else?" />

      <View className="mt-7 gap-3">
        {first ? (
          <View className="flex-row items-center gap-3 rounded-[18px] border border-rule bg-card px-4 py-3.5">
            <View className="h-[42px] w-[42px] items-center justify-center rounded-full bg-chip-blue">
              <AppText variant="section" className="text-[16px] text-brand">
                {first.name.trim().charAt(0).toUpperCase() || '•'}
              </AppText>
            </View>
            <View className="flex-1">
              <AppText variant="section" className="text-[15px]">
                {first.name.trim() || 'Your child'}
              </AppText>
              {first.dateOfBirth ? (
                <AppText variant="meta" className="text-caption">
                  {dobLabel(first.dateOfBirth)}
                </AppText>
              ) : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Edit your first child"
              onPress={() => router.back()}
              className="p-1 active:opacity-60"
            >
              <Icon name="pencil" size={15} color={pencilColor} />
            </Pressable>
          </View>
        ) : null}

        {extras.map((child, i) => (
          <ChildFields
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional; no stable id pre-persist.
            key={i}
            child={child}
            onChange={(next) => {
              setError(null);
              updateExtra(i, next);
            }}
            onRemove={() => removeExtra(i)}
            removable
          />
        ))}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add another child"
          onPress={addChild}
          className="flex-row items-center justify-center gap-2 rounded-[18px] border-[1.5px] border-dashed border-rule-strong py-5 active:opacity-80"
        >
          <Icon name="plus" size={16} color={brand} />
          <AppText variant="section" className="text-[14px] text-brand">
            Add another child
          </AppText>
        </Pressable>
      </View>

      {error ? (
        <AppText variant="meta" className="mt-3 text-berry" accessibilityLiveRegion="polite">
          {error}
        </AppText>
      ) : null}

      <View className="flex-1" />
      <Button label="No, that's everyone" variant="secondary" onPress={onContinue} />
    </OnboardingScreen>
  );
}
