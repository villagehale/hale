import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import type { ActivityEvent } from '@/lib/coach-api';

/**
 * The folded activity trail above a finished Concierge answer — the work Hale did
 * to answer, shown as a collapsible disclosure ("▸ Explored N steps") that expands
 * to the settled tool steps. Mirrors the web ActivityTrail grammar. Rule #1: it
 * renders ONLY what the server streamed — a tool's content-free preview + outcome
 * — never args or raw output. A blocked step (ok:false) reads in the attention
 * tone so refusals stay observable (rule #7/#1), never silent.
 *
 * Only rendered when there is ≥1 settled step; an answer that ran no tools shows
 * no trail.
 */
export function ActivityTrail({ activity }: { activity: ActivityEvent[] }) {
  const [expanded, setExpanded] = useState(false);
  if (activity.length === 0) return null;

  const count = activity.length;
  const summary = `Explored ${count} ${count === 1 ? 'step' : 'steps'}`;

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

      {expanded ? (
        <View className="mt-0.5 gap-1 pb-1">
          {activity.map((step, i) => (
            <View
              // biome-ignore lint/suspicious/noArrayIndexKey: activity is append-only, so index is a stable identity
              key={i}
              className="flex-row items-baseline gap-2"
            >
              <AppText variant="meta" className={step.ok ? 'text-sage' : 'text-berry'}>
                {step.ok ? '✓' : '✕'}
              </AppText>
              <AppText variant="meta" className={`flex-1 ${step.ok ? 'text-ink-2' : 'text-berry'}`}>
                {step.preview}
              </AppText>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
