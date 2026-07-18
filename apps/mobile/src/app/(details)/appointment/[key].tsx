import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, Share, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { DetailHeader } from '@/components/ui/detail-header';
import { Icon } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { Tag } from '@/components/ui/tag';
import { useMeadowColor } from '@/constants/meadow';
import { ApiError, api } from '@/lib/api-client';
import type {
  ChildCompanionView,
  MobileCompanionResponse,
  UpcomingHealthItem,
} from '@/lib/api-types';
import { duePhrase } from '@/lib/format';
import { useApi } from '@/lib/use-api';

/** The plain, honest text a Share hands off — the item, its timing, and the
 * standard-schedule caveat. No fabricated calendar link (expo-calendar isn't
 * installed; the create_calendar_event executor is not configured — task). */
function shareText(item: UpcomingHealthItem, childName: string | null): string {
  const who = childName ? `${childName}: ` : '';
  return `${who}${item.what} — ${duePhrase(item.dueInWeeks)}.\nTiming is the standard Canadian schedule — confirm with your provider.`;
}

/** Resolve the upcoming health item by its stable key across the child's three
 * health lists (the item can be opened from Up-next, the schedule, or a recently
 * passed row). Null when the key doesn't match — the route then shows the empty
 * state instead of crashing (deep-link safety). */
function findHealthItem(child: ChildCompanionView, key: string): UpcomingHealthItem | null {
  const all = [
    child.todayHealth,
    ...child.nextHealth,
    ...child.recentlyPassedHealth,
  ].filter((i): i is UpcomingHealthItem => i !== null);
  return all.find((i) => i.key === key) ?? null;
}

/**
 * The appointment detail body (moved verbatim from AppointmentDetailSheet): the
 * item's what / when / done state, the standard-schedule provenance line, a Share
 * affordance (native Share of the plain details), and a real "Mark done" that POSTs
 * the audited /api/mobile/companion/done (rule #6). There is NO add-to-calendar
 * write — expo-calendar isn't installed and the executor is not configured, so the
 * page never fakes one.
 */
function AppointmentBody({
  item,
  childId,
  childName,
}: {
  item: UpcomingHealthItem;
  childId: string;
  childName: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [marked, setMarked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const iconColor = useMeadowColor('ink2');
  const onInk = useMeadowColor('onAccent');

  const isDone = marked || item.done;

  const onShare = async () => {
    try {
      await Share.share({ message: shareText(item, childName) });
    } catch {
      setError("Couldn't open the share sheet — try again.");
    }
  };

  const markDone = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/api/mobile/companion/done', {
        method: 'POST',
        body: JSON.stringify({
          target: 'health',
          childId,
          what: item.what,
          healthKey: item.key,
        }),
      });
      setMarked(true);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError("Couldn't mark it done just now — try again in a moment.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="gap-0">
      <View className="mb-3 flex-row items-start justify-between gap-3">
        <AppText variant="title" className="flex-1">
          {item.what}
        </AppText>
        {isDone ? <Tag label="done" tone="done" /> : null}
      </View>

      <View className="mb-3 flex-row items-center gap-2">
        <Icon name="calendar" size={15} color={iconColor} />
        <AppText variant="body" className="text-ink-2">
          {isDone ? 'Marked done' : duePhrase(item.dueInWeeks)}
        </AppText>
      </View>

      {item.note ? (
        <AppText variant="body" className="mb-4">
          {item.note}
        </AppText>
      ) : null}

      <AppText variant="meta" className="mb-5 text-ink-3">
        Timing is the standard Canadian schedule — confirm with your provider.
      </AppText>

      <View className="flex-row flex-wrap gap-2">
        {!isDone ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Mark done"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={markDone}
            className={`min-h-11 flex-row items-center gap-2 rounded-full border border-ink bg-ink px-4 py-2.5 ${
              busy ? 'opacity-50' : 'active:opacity-80'
            }`}
          >
            <Icon name="check" size={15} color={onInk} />
            <AppText variant="meta" className="text-on-ink">
              {busy ? 'Marking…' : 'Mark done'}
            </AppText>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Share these details"
          onPress={onShare}
          className="min-h-11 flex-row items-center gap-2 rounded-full border border-rule bg-raised px-4 py-2.5 active:opacity-80"
        >
          <Icon name="share" size={15} color={iconColor} />
          <AppText variant="meta" className="text-ink-2">
            Share
          </AppText>
        </Pressable>
      </View>

      {error ? (
        <AppText variant="meta" className="mt-3 text-berry" accessibilityLiveRegion="polite">
          {error}
        </AppText>
      ) : null}
    </Card>
  );
}

/**
 * The pushed Appointment-details route (sheet→stack conversion). Takes the health
 * item's stable `key` and its `child` id, re-reads /api/mobile/companion and resolves
 * the item the SAME way the sheet derived it from props — no stale object threaded
 * through navigation. A missing child / key renders an honest empty state, never a
 * crash (deep-link safety).
 */
export default function AppointmentDetailScreen() {
  const { key, child } = useLocalSearchParams<{ key: string; child: string }>();
  const { status, data, error, reload } = useApi<MobileCompanionResponse>('/api/mobile/companion');
  const childView = data?.children.find((c) => c.id === child) ?? null;
  const item = childView ? findHealthItem(childView, key) : null;

  return (
    <Screen scroll className="gap-5">
      <DetailHeader title="Appointment details" />
      {status === 'loading' ? <LoadingState /> : null}
      {status === 'error' ? <ErrorState message={error ?? ''} onRetry={reload} /> : null}
      {status === 'ready' && item && childView ? (
        <AppointmentBody item={item} childId={childView.id} childName={childView.name} />
      ) : null}
      {status === 'ready' && !item ? (
        <Card className="mt-2 items-center gap-2 py-10">
          <AppText variant="title">Nothing to show</AppText>
          <AppText variant="meta" className="text-center">
            This visit isn&rsquo;t on the schedule anymore. Head back to see what&rsquo;s next.
          </AppText>
        </Card>
      ) : null}
    </Screen>
  );
}
