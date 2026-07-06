import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Icon } from '@/components/ui/icon';
import { IconButton } from '@/components/ui/icon-button';
import { useMeadowColor } from '@/constants/meadow';
import {
  type DraftChild,
  type DraftPlanTier,
  type OnboardingDraft,
  emptyDraft,
} from '@/lib/onboarding-draft';
import { onboardingDraftStore } from '@/lib/onboarding-draft-store';
import { openPolicy } from '@/lib/policy-links';

// Mirror of @hale/types ONBOARDING_INTENTS — the native bundle can't import
// server/package code that pulls in Node, so the value/label pairs are hand-copied
// (same pattern as api-types.ts). Short labels for the chip layout.
const INTENTS: { value: string; label: string }[] = [
  { value: 'activities', label: 'Activities & classes' },
  { value: 'childcare', label: 'Childcare' },
  { value: 'milestones', label: 'Milestones & development' },
  { value: 'planning', label: 'Weekly planning & routine' },
  { value: 'sitter', label: 'Trusted sitter/nanny' },
  { value: 'health', label: 'Health & specialists' },
  { value: 'community', label: 'Meeting other families' },
  { value: 'exploring', label: 'Just exploring' },
];

const PLANS: { value: DraftPlanTier; title: string; blurb: string }[] = [
  { value: 'free', title: 'Free', blurb: 'The essentials — logging, your village, gentle nudges.' },
  { value: 'plus', title: 'Plus', blurb: 'More automation as Hale earns your trust.' },
  { value: 'family', title: 'Family', blurb: 'Everything, for the whole household.' },
];

const STEPS = ['children', 'location', 'goals', 'plan', 'consent'] as const;
type Step = (typeof STEPS)[number];

// DOB is stored/sent as 'YYYY-MM-DD'. Parse it as a LOCAL date (not UTC, which
// would shift the day for negative timezones) for the picker, and format back to
// the wire shape after a pick — mirroring the Family screen.
function parseDob(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}
function toDobString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function dobLabel(value: string): string {
  return parseDob(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function StepHeading({ eyebrow, title, hint }: { eyebrow: string; title: string; hint?: string }) {
  return (
    <View className="gap-2">
      <AppText variant="meta" className="uppercase tracking-eyebrow text-accent">
        {eyebrow}
      </AppText>
      <AppText variant="display">{title}</AppText>
      {hint ? <AppText variant="body">{hint}</AppText> : null}
    </View>
  );
}

function ChildRow({
  child,
  onChange,
  onRemove,
  removable,
}: {
  child: DraftChild;
  onChange: (next: DraftChild) => void;
  onRemove: () => void;
  removable: boolean;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const iconColor = useMeadowColor('ink3');

  const onPickerChange = (event: DateTimePickerEvent, picked?: Date) => {
    if (Platform.OS !== 'ios') setShowPicker(false);
    if (event.type === 'set' && picked) onChange({ ...child, dateOfBirth: toDobString(picked) });
  };

  return (
    <View className="gap-4 rounded-lg border border-rule bg-card p-4">
      <View className="flex-row items-start gap-3">
        <View className="flex-1">
          <Field
            label="First name"
            value={child.name}
            onChangeText={(name) => onChange({ ...child, name })}
            placeholder="Maya"
            autoCapitalize="words"
          />
        </View>
        {removable ? (
          <View className="pt-6">
            <IconButton icon="trash" accessibilityLabel="Remove this child" onPress={onRemove} />
          </View>
        ) : null}
      </View>

      <View className="gap-1.5">
        <AppText variant="meta" className="text-ink-2">
          Date of birth
        </AppText>
        {/* The date picker is a native module (no web impl), so on the RN-web preview
            we show the resolved date read-only — mirroring the Family screen. */}
        {Platform.OS === 'web' ? (
          <View className="min-h-11 justify-center rounded-lg border border-rule bg-canvas px-4 py-3">
            <AppText variant="body" className="text-ink">
              {child.dateOfBirth ? dobLabel(child.dateOfBirth) : 'Not set'}
            </AppText>
          </View>
        ) : (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                child.dateOfBirth
                  ? `Date of birth: ${dobLabel(child.dateOfBirth)}. Tap to change.`
                  : 'Set date of birth'
              }
              accessibilityState={{ expanded: showPicker }}
              onPress={() => setShowPicker((s) => !s)}
              className="min-h-11 flex-row items-center justify-between rounded-lg border border-rule bg-canvas px-4 py-3 active:opacity-80"
            >
              <AppText variant="body" className={child.dateOfBirth ? 'text-ink' : 'text-ink-3'}>
                {child.dateOfBirth ? dobLabel(child.dateOfBirth) : 'Tap to choose'}
              </AppText>
              <Icon name={showPicker ? 'chevron.up' : 'chevron.down'} size={13} color={iconColor} />
            </Pressable>
            {showPicker ? (
              <View className="items-center">
                <DateTimePicker
                  value={child.dateOfBirth ? parseDob(child.dateOfBirth) : new Date()}
                  mode="date"
                  display={Platform.OS === 'ios' ? 'inline' : 'default'}
                  maximumDate={new Date()}
                  onChange={onPickerChange}
                />
              </View>
            ) : null}
          </>
        )}
        <AppText variant="meta">Birthday sets the stage Hale tailors to.</AppText>
      </View>
    </View>
  );
}

export default function IntakeScreen() {
  const [draft, setDraft] = useState<OnboardingDraft>(() => ({
    ...emptyDraft(),
    children: [{ name: '', dateOfBirth: '' }],
  }));
  const [stepIndex, setStepIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const step: Step = STEPS[stepIndex];

  // Rehydrate a saved draft (e.g. the app was reopened mid-intake) once on mount.
  useEffect(() => {
    onboardingDraftStore.load().then((saved) => {
      if (saved && saved.children.length > 0) setDraft(saved);
    });
  }, []);

  const persist = (next: OnboardingDraft) => {
    setDraft(next);
    void onboardingDraftStore.save(next);
  };

  const updateChild = (index: number, next: DraftChild) => {
    persist({ ...draft, children: draft.children.map((c, i) => (i === index ? next : c)) });
  };
  const addChild = () =>
    persist({ ...draft, children: [...draft.children, { name: '', dateOfBirth: '' }] });
  const removeChild = (index: number) =>
    persist({ ...draft, children: draft.children.filter((_, i) => i !== index) });

  const toggleIntent = (value: string) => {
    const has = draft.intents.includes(value);
    persist({
      ...draft,
      intents: has ? draft.intents.filter((v) => v !== value) : [...draft.intents, value],
    });
  };

  const validateStep = (): boolean => {
    if (step === 'children') {
      const filled = draft.children.filter((c) => c.name.trim() && c.dateOfBirth);
      if (filled.length === 0) {
        setError('Add at least one child — a first name and a birthday.');
        return false;
      }
      if (draft.children.some((c) => c.name.trim() && !c.dateOfBirth)) {
        setError('Please set a birthday for each child you added.');
        return false;
      }
    }
    return true;
  };

  const next = () => {
    setError(null);
    if (!validateStep()) return;
    if (step === 'children') {
      // Drop any half-filled extra rows before moving on, and keep the draft clean.
      persist({ ...draft, children: draft.children.filter((c) => c.name.trim() && c.dateOfBirth) });
    }
    if (stepIndex < STEPS.length - 1) {
      setStepIndex(stepIndex + 1);
    } else {
      // Consent accepted: the draft is already persisted; hand off to account creation.
      router.push('/(onboarding)/create-account');
    }
  };

  const back = () => {
    setError(null);
    if (stepIndex === 0) {
      router.back();
      return;
    }
    setStepIndex(stepIndex - 1);
  };

  return (
    <SafeAreaView className="flex-1 bg-canvas" edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View className="flex-row items-center gap-3 px-5 pt-2">
          <IconButton icon="chevron.left" accessibilityLabel="Go back" size={18} onPress={back} />
          <View className="flex-1 flex-row items-center gap-1.5">
            {STEPS.map((s, i) => (
              <View
                key={s}
                className={`h-1.5 flex-1 rounded-full ${i <= stepIndex ? 'bg-ink' : 'bg-rule-strong'}`}
              />
            ))}
          </View>
        </View>

        <ScrollView
          className="flex-1"
          contentContainerClassName="px-5 pt-4 pb-6 gap-6"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {step === 'children' ? (
            <>
              <StepHeading
                eyebrow="Your family"
                title="Who are we helping?"
                hint="Add each child's first name and birthday. You can add more anytime."
              />
              <View className="gap-3">
                {draft.children.map((child, i) => (
                  <ChildRow
                    // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional; no stable id pre-persist.
                    key={i}
                    child={child}
                    onChange={(nextChild) => updateChild(i, nextChild)}
                    onRemove={() => removeChild(i)}
                    removable={draft.children.length > 1}
                  />
                ))}
                <Button label="Add another child" variant="secondary" onPress={addChild} />
              </View>
            </>
          ) : null}

          {step === 'location' ? (
            <>
              <StepHeading
                eyebrow="Your area"
                title="Where are you?"
                hint="This tailors local discovery. A coarse area only — never your exact address."
              />
              <View className="gap-3">
                <Field
                  label="City"
                  value={draft.location.city ?? ''}
                  onChangeText={(city) =>
                    persist({ ...draft, location: { ...draft.location, city } })
                  }
                  placeholder="Toronto"
                  autoCapitalize="words"
                />
                <Field
                  label="Postal code"
                  value={draft.location.postalCode ?? ''}
                  onChangeText={(postalCode) =>
                    persist({ ...draft, location: { ...draft.location, postalCode } })
                  }
                  placeholder="M5V 2T6"
                  autoCapitalize="characters"
                  hint="Drives neighbourhood discovery — never a precise address. Optional."
                />
              </View>
            </>
          ) : null}

          {step === 'goals' ? (
            <>
              <StepHeading
                eyebrow="Your goals"
                title="What would help most?"
                hint="Pick any that fit — or none. You can change these later. (Optional)"
              />
              <View className="flex-row flex-wrap gap-2">
                {INTENTS.map((intent) => {
                  const active = draft.intents.includes(intent.value);
                  return (
                    <Pressable
                      key={intent.value}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      accessibilityLabel={intent.label}
                      onPress={() => toggleIntent(intent.value)}
                      className={`rounded-full border px-4 py-2.5 active:opacity-80 ${
                        active ? 'border-ink bg-ink' : 'border-rule bg-card'
                      }`}
                    >
                      <AppText variant="meta" className={active ? 'text-on-ink' : 'text-ink-2'}>
                        {intent.label}
                      </AppText>
                    </Pressable>
                  );
                })}
              </View>
            </>
          ) : null}

          {step === 'plan' ? (
            <>
              <StepHeading
                eyebrow="Your plan"
                title="Pick a starting plan"
                hint="Start free — nothing is charged now. You can change this anytime."
              />
              <View className="gap-3">
                {PLANS.map((plan) => {
                  const active = draft.planTier === plan.value;
                  return (
                    <Pressable
                      key={plan.value}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      accessibilityLabel={`${plan.title} plan`}
                      onPress={() => persist({ ...draft, planTier: plan.value })}
                      className={`flex-row items-center justify-between gap-3 rounded-lg border p-4 active:opacity-90 ${
                        active ? 'border-ink bg-raised' : 'border-rule bg-card'
                      }`}
                    >
                      <View className="flex-1 gap-1">
                        <AppText variant="section">{plan.title}</AppText>
                        <AppText variant="meta">{plan.blurb}</AppText>
                      </View>
                      <View
                        className={`h-5 w-5 items-center justify-center rounded-full border ${
                          active ? 'border-ink bg-ink' : 'border-rule-strong'
                        }`}
                      >
                        {active ? <View className="h-2 w-2 rounded-full bg-on-ink" /> : null}
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            </>
          ) : null}

          {step === 'consent' ? (
            <ConsentStep
              accepted={draft.tosAccepted}
              onToggle={(tosAccepted) => persist({ ...draft, tosAccepted })}
            />
          ) : null}

          {error ? (
            <AppText variant="meta" className="text-berry" accessibilityLiveRegion="polite">
              {error}
            </AppText>
          ) : null}
        </ScrollView>

        <View className="border-t border-rule bg-canvas px-5 pb-6 pt-3">
          <Button
            label={step === 'consent' ? 'Agree & create account' : 'Continue'}
            onPress={next}
            disabled={step === 'consent' && !draft.tosAccepted}
          />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function ConsentStep({
  accepted,
  onToggle,
}: {
  accepted: boolean;
  onToggle: (next: boolean) => void;
}) {
  const checkColor = useMeadowColor('onAccent');
  return (
    <View className="gap-6">
      <StepHeading
        eyebrow="Consent"
        title="One quick agreement"
        hint="Because Hale handles sensitive family data, we ask for this up front."
      />
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: accepted }}
        accessibilityLabel="I agree to the Terms, Privacy Policy, cross-border processing, and AI processing"
        onPress={() => onToggle(!accepted)}
        className="flex-row items-start gap-3 rounded-lg border border-rule bg-card p-4 active:opacity-90"
      >
        <View
          className={`mt-0.5 h-6 w-6 items-center justify-center rounded-md border ${
            accepted ? 'border-ink bg-ink' : 'border-rule-strong'
          }`}
        >
          {accepted ? <Icon name="checkmark" size={14} color={checkColor} /> : null}
        </View>
        <AppText variant="body" className="flex-1 text-ink-2">
          I agree to the Terms, Privacy Policy, cross-border processing, and AI processing of my
          family's data.
        </AppText>
      </Pressable>
      <PolicyLinks />
    </View>
  );
}

function PolicyLinks() {
  return (
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
  );
}
