import { useEffect } from 'react';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { useReducedMotion } from '@/lib/use-reduced-motion';

/**
 * The blinking caret shown at the tail of the answer WHILE it streams — the
 * "typing" signal of a live agent. It renders as inline text (an Animated.Text) so
 * it sits on the baseline at the end of the last wrapped line, and it UNMOUNTS the
 * instant the turn settles (the bubble swaps to markdown), so it can never leave a
 * stuck cursor bar behind — the old static "▍" caret's failure. The blink runs on
 * the UI thread (Reanimated worklet); with reduce-motion on it holds steady, still
 * visible but not animating.
 *
 * Must be used as a child of <AppText> (it's inline text, not a View).
 */

const BLINK_MS = 1000;

export function StreamingCursor() {
  const reduced = useReducedMotion();
  const opacity = useSharedValue(1);

  useEffect(() => {
    if (reduced) {
      opacity.value = 1;
      return;
    }
    const half = BLINK_MS / 2;
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.15, { duration: half, easing: Easing.inOut(Easing.ease) }),
        withTiming(1, { duration: half, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
    );
  }, [reduced, opacity]);

  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.Text
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ fontFamily: 'InstrumentSans_400Regular' }, style]}
      className="text-accent"
    >
      {' ▍'}
    </Animated.Text>
  );
}
