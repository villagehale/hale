import { StatusBar } from 'expo-status-bar';
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '@/components/ui/app-text';

/**
 * The light onboarding shell for the story/setup steps (welcome → anyone-else). The
 * warm-white canvas with navy type and CTAs, matching the design handoff — the
 * earlier dark "story" field is retired here. A `Skip` control sits top-right on the
 * pre-child steps (the handoff shows it from step 2 on); the body is a single padded
 * column so each screen can place its own flex spacer + pinned CTA the way the
 * prototype does. `scroll` turns the body into a keyboard-dismissing ScrollView for
 * the form step.
 */
export function OnboardingScreen({
  onSkip,
  scroll = false,
  children,
}: {
  onSkip?: () => void;
  scroll?: boolean;
  children: ReactNode;
}) {
  return (
    <SafeAreaView className="flex-1 bg-canvas" edges={['top', 'left', 'right', 'bottom']}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View className="h-8 flex-row items-center justify-end px-6">
          {onSkip ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Skip the intro"
              onPress={onSkip}
              className="px-2 py-1 active:opacity-60"
            >
              <AppText variant="meta" className="text-caption">
                Skip
              </AppText>
            </Pressable>
          ) : null}
        </View>

        {scroll ? (
          <ScrollView
            className="flex-1"
            contentContainerClassName="grow px-6 pb-4"
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {children}
          </ScrollView>
        ) : (
          <View className="flex-1 px-6 pb-4">{children}</View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/**
 * The three-dot progress marker for the info triptych (promise → one-place). A
 * single dot lights (the current step); the rest are hairline. Purely a position
 * cue — the copy carries the meaning — so it's exposed as a progressbar for AT.
 */
export function ProgressDots({ total, active }: { total: number; active: number }) {
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={`Step ${active + 1} of ${total}`}
      className="flex-row items-center justify-center gap-1.5"
    >
      {Array.from({ length: total }).map((_, i) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static dot row, no reordering.
          key={i}
          className={`h-1.5 w-1.5 rounded-full ${i === active ? 'bg-brand' : 'bg-rule-strong'}`}
        />
      ))}
    </View>
  );
}
