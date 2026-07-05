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

/**
 * Three dots that breathe in sequence while a Concierge turn is in flight —
 * replacing the disliked "Thinking…" text. The pulse runs on the UI thread
 * (Reanimated worklets), each dot staggered so the wave reads left-to-right over
 * a ~1.2s cycle, matching the web `.typing-dots` feel. When reduce-motion is on
 * the dots hold at a steady mid-opacity (no infinite animation) — the one
 * decorative loop in the app, so it must respect the accessibility setting.
 */

const DOT_COUNT = 3;
const CYCLE_MS = 1200;
const STAGGER_MS = 160;
const DIM = 0.25;
const BRIGHT = 1;

function Dot({ index, animate }: { index: number; animate: boolean }) {
  const opacity = useSharedValue(animate ? DIM : 0.5);

  useEffect(() => {
    if (!animate) {
      opacity.value = 0.5;
      return;
    }
    const half = CYCLE_MS / 2;
    opacity.value = withDelay(
      index * STAGGER_MS,
      withRepeat(
        withSequence(
          withTiming(BRIGHT, { duration: half, easing: Easing.inOut(Easing.ease) }),
          withTiming(DIM, { duration: half, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
      ),
    );
  }, [animate, index, opacity]);

  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return <Animated.View style={style} className="h-[7px] w-[7px] rounded-full bg-ink-3" />;
}

export function TypingDots() {
  const reduced = useReducedMotion();
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel="Concierge is working"
      className="flex-row items-center gap-1.5"
    >
      {Array.from({ length: DOT_COUNT }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static list, never reordered
        <Dot key={i} index={i} animate={!reduced} />
      ))}
    </View>
  );
}
