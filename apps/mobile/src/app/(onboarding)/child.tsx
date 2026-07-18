import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { ChatBubble } from '@/components/onboarding/chat-bubble';
import { ChildFields } from '@/components/onboarding/child-fields';
import { OnboardingScreen } from '@/components/onboarding/onboarding-screen';
import { TurtleMascot } from '@/components/illustrations/turtle-mascot';
import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { useOnboardingDraft } from '@/lib/use-onboarding-draft';

/**
 * Step 6 — "Who's your first little person?" The first child's name + birthday, now
 * the handoff's chat-bubble prompt over the same persisted draft and picker
 * mechanism as before. The draft's children array always has at least the first row
 * here; "anyone else?" (step 7) reuses the same ChildFields against the same draft.
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
    <OnboardingScreen scroll>
      <ChatBubble prompt="Who's your first little person?" sub="You can add more later." />

      <View className="my-6 flex-1 items-center justify-center">
        <TurtleMascot width={150} />
      </View>

      <ChildFields
        child={child}
        onChange={(next) => {
          setError(null);
          // Updater form: siblings added on the next screen live only in the
          // persisted draft — a snapshot-built array would delete them.
          update((latest) => ({ children: [next, ...latest.children.slice(1)] }));
        }}
      />

      {error ? (
        <AppText variant="meta" className="mt-3 text-berry" accessibilityLiveRegion="polite">
          {error}
        </AppText>
      ) : null}

      <Button label="Save child" onPress={onContinue} className="mt-4" />
    </OnboardingScreen>
  );
}
