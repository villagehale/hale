import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { ChildFields, dobLabel } from '@/components/onboarding/child-fields';
import { StepScreen } from '@/components/onboarding/step-screen';
import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import type { DraftChild } from '@/lib/onboarding-draft';
import { useOnboardingDraft } from '@/lib/use-onboarding-draft';

/**
 * Screen 6 — "Anyone else?" The first child (from screen 5) is shown as a settled
 * chip; siblings are added with the same ChildFields inputs against the same
 * persisted draft. Half-filled extra rows are dropped before moving on, so a family
 * with one child isn't blocked by an empty second row. "Continue" needs no
 * additional child — the first is already valid.
 */
export default function MoreChildrenScreen() {
  const { draft, update } = useOnboardingDraft();
  const [error, setError] = useState<string | null>(null);

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
    <StepScreen
      step={2}
      total={5}
      eyebrow="Your family"
      title="Anyone else?"
      hint="Add siblings now or later — Hale holds every stage at once. You can skip this."
      onContinue={onContinue}
      error={error}
    >
      {first ? (
        <View className="flex-row items-center gap-3 rounded-lg border border-rule bg-raised px-4 py-3">
          <View className="h-9 w-9 items-center justify-center rounded-full bg-accent-tint">
            <AppText variant="section" className="text-accent">
              {first.name.trim().charAt(0).toUpperCase() || '•'}
            </AppText>
          </View>
          <View className="flex-1">
            <AppText variant="section">{first.name.trim() || 'Your child'}</AppText>
            {first.dateOfBirth ? (
              <AppText variant="meta">{dobLabel(first.dateOfBirth)}</AppText>
            ) : null}
          </View>
        </View>
      ) : null}

      {extras.length > 0 ? (
        <View className="gap-3">
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
        </View>
      ) : null}

      <Button label="Add another child" variant="secondary" onPress={addChild} />
    </StepScreen>
  );
}
