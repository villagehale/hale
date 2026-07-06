import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { AppText } from '@/components/ui/app-text';
import type { ActivityEvent } from '@/lib/coach-api';
import { humanizeTool } from '@/lib/coach-fold';
import { useReducedMotion } from '@/lib/use-reduced-motion';

/**
 * The activity trail above a Concierge answer — the work Hale did to answer.
 *
 * LIVE (`live`, while the turn streams): an open "Exploring…" trail where each
 * settled tool line appears the instant its `tool_result` arrives, and a breathing
 * dot marks the tool currently running (the last event was a `tool_call` with no
 * result yet) — the Cursor/Claude-Code "working" feel. Once the answer settles the
 * same trail FOLDS to a collapsible "▸ Explored N steps" disclosure so a finished
 * turn stays uncluttered. Mirrors the web ActivityTrail grammar.
 *
 * Rule #1: it renders ONLY what the server streamed — a tool's content-free preview
 * + outcome — never args or raw output. A blocked step (ok:false) reads in the
 * attention tone so refusals stay observable (rule #7/#1), never silent.
 */

/** One live entry: a settled tool result, or the tool currently in flight (a
 * tool_call the trail is still waiting on). The screen appends these in order. */
export type TrailEntry =
  | { kind: 'result'; name: string; ok: boolean; preview: string }
  | { kind: 'pending'; name: string };

const PULSE_CYCLE_MS = 1100;
const PULSE_DIM = 0.3;
const PULSE_BRIGHT = 1;

/** The breathing dot beside the tool Hale is currently running. UI-thread pulse
 * (Reanimated worklet); holds steady when reduce-motion is on. */
function PulseDot() {
  const reduced = useReducedMotion();
  const opacity = useSharedValue(reduced ? 0.6 : PULSE_DIM);

  useEffect(() => {
    if (reduced) {
      opacity.value = 0.6;
      return;
    }
    const half = PULSE_CYCLE_MS / 2;
    opacity.value = withRepeat(
      withSequence(
        withTiming(PULSE_BRIGHT, { duration: half, easing: Easing.inOut(Easing.ease) }),
        withTiming(PULSE_DIM, { duration: half, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
    );
  }, [reduced, opacity]);

  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={style} className="h-[7px] w-[7px] rounded-full bg-accent" />;
}

function TrailLines({ entries }: { entries: TrailEntry[] }) {
  return (
    <View className="mt-0.5 gap-1 pb-1">
      {entries.map((entry, i) =>
        entry.kind === 'pending' ? (
          <View
            // biome-ignore lint/suspicious/noArrayIndexKey: the trail is append-only, so index is a stable identity
            key={i}
            className="flex-row items-center gap-2"
          >
            <PulseDot />
            <AppText variant="meta" className="flex-1 text-ink-2">
              {humanizeTool(entry.name)}
            </AppText>
          </View>
        ) : (
          <View
            // biome-ignore lint/suspicious/noArrayIndexKey: the trail is append-only, so index is a stable identity
            key={i}
            className="flex-row items-baseline gap-2"
          >
            <AppText variant="meta" className={entry.ok ? 'text-sage' : 'text-berry'}>
              {entry.ok ? '✓' : '✕'}
            </AppText>
            <AppText variant="meta" className={`flex-1 ${entry.ok ? 'text-ink-2' : 'text-berry'}`}>
              {humanizeTool(entry.name)}
            </AppText>
          </View>
        ),
      )}
    </View>
  );
}

/**
 * The live trail: an always-open "Exploring…" strip, shown while the turn streams.
 * Entries reveal one at a time as tool events arrive; the pending tool breathes.
 */
export function LiveActivityTrail({ entries }: { entries: TrailEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <View className="mb-2 border-l-2 border-rule pl-3">
      <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
        Exploring
      </AppText>
      <TrailLines entries={entries} />
    </View>
  );
}

/**
 * The settled trail: a collapsible "▸ Explored N steps" disclosure above a finished
 * answer. Only rendered when there is ≥1 settled step; an answer that ran no tools
 * shows no trail.
 */
export function ActivityTrail({ activity }: { activity: ActivityEvent[] }) {
  const [expanded, setExpanded] = useState(false);
  if (activity.length === 0) return null;

  const count = activity.length;
  const summary = `Explored ${count} ${count === 1 ? 'step' : 'steps'}`;
  const entries: TrailEntry[] = activity.map((a) => ({ kind: 'result', ...a }));

  return (
    <View className="mb-2 border-l-2 border-rule pl-3">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={summary}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((v) => !v)}
        className="flex-row items-center gap-1.5 py-1 active:opacity-80"
      >
        <AppText variant="meta" className="text-ink-3">
          {expanded ? '▾' : '▸'}
        </AppText>
        <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
          {summary}
        </AppText>
      </Pressable>

      {expanded ? <TrailLines entries={entries} /> : null}
    </View>
  );
}
