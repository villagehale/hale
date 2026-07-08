import { router } from 'expo-router';
import { useState } from 'react';

import { ChildFields } from '@/components/onboarding/child-fields';
import { StepScreen } from '@/components/onboarding/step-screen';
import { useOnboardingDraft } from '@/lib/use-onboarding-draft';

/**
 * Screen 5 — "Who's your little person?" The first child's name + birthday. The
 * intake's child logic, now the first of two child steps; the second ("anyone
 * else?") reuses the same ChildFields against the same persisted draft. The draft's
 * children array always has at least the first row here.
 */
export default function ChildScreen() {
  const { draft, update } = useOnboardingDraft(() => ({
    children: [{ name: '', dateOfBirth: '' }],
    location: {},
    intents: [],
    planTier: 'free',
    tosAccepted: false,
  }));
  const [error, setError] = useState<string | null>(null);
  const child = draft.children[0] ?? { name: '', dateOfBirth: '' };

  const onContinue = () => {
    if (!child.name.trim() || !child.dateOfBirth) {
      setError("Add your child's first name and birthday to continue.");
      return;
    }
    router.push('/(onboarding)/more-children');
  };

  return (
    <StepScreen
      step={1}
      total={5}
      eyebrow="Your family"
      title="Who's your little person?"
      hint="Just a first name and a birthday. The birthday tailors everything Hale surfaces."
      onContinue={onContinue}
      error={error}
    >
      <ChildFields
        child={child}
        onChange={(next) => {
          setError(null);
          // Updater form: siblings added on the next screen live only in the
          // persisted draft — a snapshot-built array would delete them.
          update((latest) => ({ children: [next, ...latest.children.slice(1)] }));
        }}
      />
    </StepScreen>
  );
}
