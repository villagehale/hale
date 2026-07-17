import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { StepScreen } from '@/components/onboarding/step-screen';
import { AppText } from '@/components/ui/app-text';
import { Icon, type IconName } from '@/components/ui/icon';
import { useMeadowColor } from '@/constants/meadow';
import { openPolicy } from '@/lib/policy-links';
import { useOnboardingDraft } from '@/lib/use-onboarding-draft';

/**
 * Screen 11 — "You're in control." The consent closer, and the DELIBERATE deviation
 * from the mockup's screen order: consent is captured BEFORE account creation, not
 * after. Provisioning writes the four consent records at signup (rule #1), so
 * tosAccepted must already be in the draft when create-account hands off — the root
 * layout's resume effect submits that draft the moment the session mints. The
 * checkbox is the acknowledgment; "Agree & continue" is the act that RECORDS
 * consent (sets tosAccepted) and then routes to create-account — so the recorded
 * consent maps to an explicit, deliberate action. Unchecking retracts immediately
 * (the draft is pre-submission, so retraction is still the parent's to make).
 */
const PILLARS: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'map-pin',
    title: 'Your data stays in Canada',
    body: "Stored and processed in Canada, never sold. It's your family's, not a product.",
  },
  {
    icon: 'shield-check',
    title: 'Nothing happens without your say-so',
    body: 'Hale suggests; you approve. It never acts on your behalf until you tell it to.',
  },
  {
    icon: 'shield',
    title: 'Teen privacy is held',
    body: 'For children 13+, their world stays private by default — surfaced only with their assent.',
  },
];

function Pillar({ icon, title, body }: { icon: IconName; title: string; body: string }) {
  const ink = useMeadowColor('ink2');
  return (
    <View className="flex-row items-start gap-3">
      <View className="mt-0.5 h-9 w-9 items-center justify-center rounded-full bg-raised">
        <Icon name={icon} size={16} color={ink} />
      </View>
      <View className="flex-1 gap-1">
        <AppText variant="section">{title}</AppText>
        <AppText variant="body" className="text-ink-2">
          {body}
        </AppText>
      </View>
    </View>
  );
}

export default function ConsentScreen() {
  const { draft, update } = useOnboardingDraft();
  const checkColor = useMeadowColor('onAccent');
  const [agreed, setAgreed] = useState(false);
  const acknowledged = draft.tosAccepted || agreed;

  return (
    <StepScreen
      step={5}
      total={5}
      eyebrow="Consent"
      title="You're in control."
      hint="Because Hale handles sensitive family data, we ask for this up front."
      ctaLabel="Agree & continue"
      ctaDisabled={!acknowledged}
      onContinue={() => {
        // The CTA is the consent act — the record maps to this explicit press.
        update({ tosAccepted: true });
        router.push('/(onboarding)/create-account');
      }}
    >
      <View className="gap-5">
        {PILLARS.map((pillar) => (
          <Pillar key={pillar.title} {...pillar} />
        ))}
      </View>

      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: acknowledged }}
        accessibilityLabel="I agree to the Terms, Privacy Policy, cross-border processing, and AI processing"
        onPress={() => {
          if (acknowledged) {
            // Retract pre-submission consent immediately; re-consent is the CTA.
            setAgreed(false);
            update({ tosAccepted: false });
          } else {
            setAgreed(true);
          }
        }}
        className="flex-row items-start gap-3 rounded-lg border border-rule bg-card p-4 active:opacity-90"
      >
        <View
          className={`mt-0.5 h-6 w-6 items-center justify-center rounded-md border ${
            acknowledged ? 'border-ink bg-ink' : 'border-rule-strong'
          }`}
        >
          {acknowledged ? <Icon name="check" size={14} color={checkColor} /> : null}
        </View>
        <AppText variant="body" className="flex-1 text-ink-2">
          I agree to the Terms, Privacy Policy, cross-border processing, and AI processing of my
          family's data.
        </AppText>
      </Pressable>

      <View className="flex-row flex-wrap items-center gap-x-4 gap-y-1">
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Read the Terms"
          onPress={() => openPolicy('/terms')}
          className="active:opacity-70"
        >
          <AppText variant="meta" className="text-accent">
            Read the Terms
          </AppText>
        </Pressable>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Read the Privacy Policy"
          onPress={() => openPolicy('/privacy')}
          className="active:opacity-70"
        >
          <AppText variant="meta" className="text-accent">
            Read the Privacy Policy
          </AppText>
        </Pressable>
      </View>
    </StepScreen>
  );
}
