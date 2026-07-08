import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import { AppText, type AppTextProps } from '@/components/ui/app-text';

/**
 * The brand/story shell: Prussian ink AS the field, with light text. The story
 * screens carry the brand mood (the mockup's dark screens), so the field is pinned
 * to the literal Prussian #003153 — NOT the `bg-ink` token, which inverts to cream
 * in dark mode and would flip the field.
 *
 * Because the field is fixed dark in BOTH schemes, the text can't use the scheme-
 * flipping ink/on-ink tokens (they'd invert and vanish). StoryText applies fixed
 * light values drawn from the same palette: pure white for headings/CTA labels and
 * the light blue-white #c7d3e6 (the dark-scheme ink-2) for supporting copy — the
 * on-ink pairing, scheme-stable.
 *
 * A `footer` slot pins the CTA to the bottom; the body fills the space above.
 */
export const STORY_FIELD = '#003153';
export const STORY_TEXT = '#ffffff';
export const STORY_TEXT_MUTED = '#c7d3e6';

export function StoryScreen({ children, footer }: { children: ReactNode; footer: ReactNode }) {
  return (
    <View className="flex-1" style={{ backgroundColor: STORY_FIELD }}>
      <StatusBar style="light" />
      <SafeAreaView className="flex-1" edges={['top', 'left', 'right', 'bottom']}>
        <View className="flex-1 justify-between px-6 pb-4 pt-2">
          <View className="flex-1 justify-center">{children}</View>
          <View className="gap-4">{footer}</View>
        </View>
      </SafeAreaView>
    </View>
  );
}

/** AppText on the fixed Prussian field. `muted` uses the light blue-white; the
 * default is pure white. Keeps the type scale (variant) but overrides the token
 * color, which would otherwise flip with the device scheme. */
export function StoryText({ muted, style, ...rest }: AppTextProps & { muted?: boolean }) {
  return <AppText style={[{ color: muted ? STORY_TEXT_MUTED : STORY_TEXT }, style]} {...rest} />;
}

/**
 * The primary CTA on the Prussian field: an inverted pill — white fill, Prussian
 * label — so it reads as the lit action against the dark ground (the canvas
 * `Button` fills with `bg-ink`, which is Prussian in light mode but flips to cream
 * in dark, so it can't be reused here). Secondary is a hairline outline in the
 * light text color.
 */
export function StoryButton({
  label,
  onPress,
  variant = 'primary',
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary';
}) {
  const isPrimary = variant === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      className="min-h-12 flex-row items-center justify-center rounded-full px-6 py-3.5 active:opacity-90"
      style={{
        backgroundColor: isPrimary ? STORY_TEXT : 'transparent',
        borderWidth: isPrimary ? 0 : 1,
        borderColor: STORY_TEXT_MUTED,
      }}
    >
      <AppText variant="meta" style={{ color: isPrimary ? STORY_FIELD : STORY_TEXT }}>
        {label}
      </AppText>
    </Pressable>
  );
}
