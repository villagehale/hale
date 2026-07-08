import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { useReducedMotion } from '@/lib/use-reduced-motion';
import { STORY_FIELD, STORY_TEXT, STORY_TEXT_MUTED } from '@/components/onboarding/story-screen';
import { AppText } from './app-text';
import { LogoMark } from './logo-mark';

/**
 * The branded app-open loader: the turtle chip fades + scales in with a soft
 * overshoot, then gently "breathes" while the app resolves fonts + the stored
 * session, and the wordmark + tagline fade in below. Shown over the native splash
 * hand-off so opening Hale is a deliberate, alive brand moment (the AI-startup feel)
 * rather than a blank frame — then it gives way to Get started / sign-in. Every
 * animation is gated by reduce-motion (static, no pulse) so it never fights an
 * accessibility preference.
 *
 * The field is the fixed Prussian ground shared with the story screens (STORY_FIELD),
 * with the scheme-stable light text — so the splash reads as the same dark brand
 * moment in both schemes (the tokens would flip on a fixed-dark field; see
 * story-screen.tsx).
 */
export function SplashLoader() {
  const reduced = useReducedMotion();
  const opacity = useSharedValue(reduced ? 1 : 0);
  const scale = useSharedValue(reduced ? 1 : 0.82);
  const textOpacity = useSharedValue(reduced ? 1 : 0);

  useEffect(() => {
    if (reduced) return;
    opacity.value = withTiming(1, { duration: 480, easing: Easing.out(Easing.quad) });
    // Entrance overshoot, then a slow continuous breathe (the "alive logo" feel).
    scale.value = withSequence(
      withTiming(1, { duration: 620, easing: Easing.out(Easing.back(1.4)) }),
      withRepeat(
        withSequence(
          withTiming(1.045, { duration: 1400, easing: Easing.inOut(Easing.ease) }),
          withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
      ),
    );
    textOpacity.value = withDelay(360, withTiming(1, { duration: 560 }));
  }, [reduced, opacity, scale, textOpacity]);

  const logoStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));
  const textStyle = useAnimatedStyle(() => ({ opacity: textOpacity.value }));

  return (
    <View className="flex-1 items-center justify-center" style={{ backgroundColor: STORY_FIELD }}>
      <StatusBar style="light" />
      <Animated.View style={logoStyle}>
        <LogoMark size={92} />
      </Animated.View>
      <Animated.View style={textStyle} className="mt-6 items-center gap-1">
        <AppText variant="display" style={{ color: STORY_TEXT }}>
          Hale
        </AppText>
        <AppText variant="mono" className="text-[13px]" style={{ color: STORY_TEXT_MUTED }}>
          /ˈhɑːleɪ/ · 'HAH-lay' · Hawaiian for home
        </AppText>
        <AppText variant="meta" className="mt-1" style={{ color: STORY_TEXT_MUTED }}>
          Every family deserves a village.
        </AppText>
      </Animated.View>
    </View>
  );
}
