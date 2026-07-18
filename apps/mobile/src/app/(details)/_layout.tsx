import { Stack } from 'expo-router';

import { useReducedMotion } from '@/lib/use-reduced-motion';

/**
 * The full-screen detail group. Every drill-through page (appointment, activity,
 * docs, logs, approvals, family, plan, messages, settings, notifications, …) lives
 * here — a Stack layer registered on the ROOT navigator, a sibling of (tabs), so a
 * detail renders OVER the tab bar (full-screen, no bottom nav — matching the
 * prototype). Because a detail is pushed onto the root stack and never into a tab's
 * own stack, back always pops to the opener and switching tabs always lands on the
 * tab root — no per-tab stack to leak (expo-router v56 js-tabs can't reset one; see
 * project memory).
 *
 * Detail pages open with the handoff's screen transition — a fade-up (fade + a small
 * upward slide, the prototype's `fadeUp 0.4s ease`). Under Reduce Motion it degrades
 * to a plain cross-dissolve (no translation), matching iOS's own reduce-motion push.
 */
export default function DetailsLayout() {
  const reduced = useReducedMotion();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: reduced ? 'fade' : 'fade_from_bottom',
        animationDuration: 400,
      }}
    />
  );
}
