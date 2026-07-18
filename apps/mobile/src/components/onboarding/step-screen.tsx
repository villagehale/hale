import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';

/**
 * The chrome shared by the canvas intake steps (screens 5–8, 11): a back button, a
 * segmented progress bar, a scrolling body, and a pinned footer CTA. The intake was
 * one screen with an internal step index; the story flow splits it across routes,
 * so `step` / `total` drive the progress bar from the route's fixed position rather
 * than component state. Back navigates the router (each step is its own route), so
 * the draft — saved on every change — survives moving between steps and app death.
 */
export function StepScreen({
  step,
  total,
  eyebrow,
  title,
  hint,
  children,
  ctaLabel = 'Continue',
  onContinue,
  ctaDisabled = false,
  error,
}: {
  step: number;
  total: number;
  eyebrow: string;
  title: string;
  hint?: string;
  children: ReactNode;
  ctaLabel?: string;
  onContinue: () => void;
  ctaDisabled?: boolean;
  error?: string | null;
}) {
  const bars = Array.from({ length: total }, (_, i) => i);
  return (
    <SafeAreaView className="flex-1 bg-canvas" edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView className="flex-1" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View className="flex-row items-center gap-3 px-5 pt-2">
          <IconButton
            icon="chevron-left"
            accessibilityLabel="Go back"
            size={18}
            onPress={() => router.back()}
          />
          <View
            accessibilityRole="progressbar"
            accessibilityLabel={`Step ${step} of ${total}`}
            className="flex-1 flex-row items-center gap-1.5"
          >
            {bars.map((i) => (
              <View
                key={i}
                className={`h-1.5 flex-1 rounded-full ${i < step ? 'bg-ink' : 'bg-rule-strong'}`}
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
          <View className="gap-2">
            <AppText variant="eyebrow" className="text-accent">
              {eyebrow}
            </AppText>
            <AppText variant="display">{title}</AppText>
            {hint ? <AppText variant="body">{hint}</AppText> : null}
          </View>

          {children}

          {error ? (
            <AppText variant="meta" className="text-berry" accessibilityLiveRegion="polite">
              {error}
            </AppText>
          ) : null}
        </ScrollView>

        <View className="border-t border-rule bg-canvas px-5 pb-6 pt-3">
          <Button label={ctaLabel} onPress={onContinue} disabled={ctaDisabled} />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
