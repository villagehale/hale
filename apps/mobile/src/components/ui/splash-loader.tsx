import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Pressable, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { useMeadowColor } from '@/constants/meadow';
import { useReducedMotion } from '@/lib/use-reduced-motion';
import { AppText } from './app-text';
import { Icon } from './icon';
import { LogoMark } from './logo-mark';

/**
 * The branded app-open loader, on the warm handoff canvas: the 108px turtle tile
 * fades + scales in with a soft overshoot, then gently "breathes" while the app
 * resolves fonts + the stored session, and the serif wordmark + pronunciation fade
 * in below. Shown over the native splash hand-off so opening Hale is a deliberate,
 * alive brand moment rather than a blank frame — then it gives way to the story flow
 * / sign-in / the app. Every animation is gated by reduce-motion (static, no pulse)
 * so it never fights an accessibility preference. `onSkip` (a tap anywhere) lets an
 * impatient open bypass the artificial minimum hold.
 */
export function SplashLoader({ onSkip }: { onSkip?: () => void }) {
  const reduced = useReducedMotion();
  const opacity = useSharedValue(reduced ? 1 : 0);
  const scale = useSharedValue(reduced ? 1 : 0.82);
  const textOpacity = useSharedValue(reduced ? 1 : 0);
  const brand = useMeadowColor('brand');
  const muted = useMeadowColor('ink3');

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
    <Pressable
      accessibilityRole={onSkip ? 'button' : undefined}
      accessibilityLabel={onSkip ? 'Continue' : undefined}
      onPress={onSkip}
      className="flex-1 items-center justify-center bg-canvas"
    >
      <StatusBar style="dark" />
      <Animated.View
        style={[
          logoStyle,
          {
            borderRadius: 28,
            shadowColor: brand,
            shadowOpacity: 0.25,
            shadowRadius: 16,
            shadowOffset: { width: 0, height: 12 },
            elevation: 8,
          },
        ]}
      >
        <LogoMark size={108} radius={28} />
      </Animated.View>
      <Animated.View style={textStyle} className="mt-6 items-center gap-1.5">
        <AppText variant="display" className="text-[44px] leading-[52px] text-brand">
          Hale
        </AppText>
        <View className="flex-row items-center gap-1.5">
          <AppText variant="body" className="text-ink-3">
            /HAH-leh/
          </AppText>
          <Icon name="volume-2" size={14} color={muted} />
        </View>
        <AppText variant="meta" className="text-caption">
          Hawaiian for “home”
        </AppText>
      </Animated.View>
    </Pressable>
  );
}
