import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Share, View } from 'react-native';

import { DetailSuccess } from '@/components/hale/detail-success';
import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DetailHeader, type OverflowAction } from '@/components/ui/detail-header';
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
import { BOOK_ACTION_PATH, buildBookRequestBody } from '@/lib/book-action';
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

type Phase = 'idle' | 'booking' | 'booked';

/**
 * The appointment detail body. Two prototype actions (Reschedule + Add to calendar)
 * plus the shipped, audited "Mark done".
 *
 * "Add to calendar" NEVER writes a calendar — there is no mobile calendar executor
 * (expo-calendar isn't installed). It routes the item through the SAME approval
 * engine the web BookButton uses (POST /api/coach/action → a create_calendar_event
 * action HELD at drafted_for_approval, rule #4), so the success state honestly reads
 * "Added to your approvals" — never "Added to Google Calendar" (no false integration
 * claim). "Reschedule" has no backend path yet, so it is present-but-disabled per the
 * brief. "Mark done" POSTs the audited /api/mobile/companion/done (rule #6), the same
 * shipped path the Companion Health card uses.
 */
function AppointmentBody({
  item,
  childId,
}: {
  item: UpcomingHealthItem;
  childId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [marked, setMarked] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const iconColor = useMeadowColor('ink2');

  const isDone = marked || item.done;

  const addToCalendar = async () => {
    setPhase('booking');
    setError(null);
    try {
      await api(BOOK_ACTION_PATH, {
        method: 'POST',
        body: JSON.stringify(buildBookRequestBody(item.what, childId)),
      });
      setPhase('booked');
    } catch (e) {
      setPhase('idle');
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError("Couldn't draft that just now — try again in a moment.");
      }
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

  if (phase === 'booked') {
    return (
      <DetailSuccess
        headline="Added to your approvals"
        subcopy="Nothing reaches your calendar until you approve it."
        primaryLabel="Done"
        onPrimary={() => router.back()}
        secondaryLabel="View approvals"
        onSecondary={() => router.push('/approvals')}
      >
        <Card>
          <AppText
            className="text-[14px] text-ink"
            style={{ fontFamily: 'InstrumentSans_700Bold' }}
          >
            {item.what}
          </AppText>
          <AppText variant="meta" className="mt-0.5 text-ink-3">
            {duePhrase(item.dueInWeeks)}
          </AppText>
        </Card>
      </DetailSuccess>
    );
  }

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

      {!isDone ? (
        <View className="gap-2.5">
          <View className="flex-row gap-2.5">
            {/* No reschedule backend exists yet — present-but-disabled per the brief,
                never a button that silently does nothing. */}
            <Button
              label="Reschedule"
              variant="secondary"
              disabled
              className="flex-1"
            />
            <Button
              label={phase === 'booking' ? 'Adding…' : 'Add to calendar'}
              onPress={addToCalendar}
              disabled={phase === 'booking'}
              className="flex-1"
            />
          </View>
          <Button label={busy ? 'Marking…' : 'Mark as done'} variant="secondary" onPress={markDone} disabled={busy} />
        </View>
      ) : null}

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
 * crash (deep-link safety). The ⋯ menu carries a real Share (the honest plain-text
 * details) and Get help (the Ask surface); appointments have no saved semantic, so
 * Save is omitted rather than shipped dead (brief — honest beats literal).
 */
export default function AppointmentDetailScreen() {
  const { key, child } = useLocalSearchParams<{ key: string; child: string }>();
  const { status, data, error, reload } = useApi<MobileCompanionResponse>('/api/mobile/companion');
  const childView = data?.children.find((c) => c.id === child) ?? null;
  const item = childView ? findHealthItem(childView, key) : null;

  const helpItem: OverflowAction = {
    label: 'Get help',
    icon: 'circle-help',
    onPress: () => router.push('/ask'),
  };
  const menu: OverflowAction[] =
    item && childView
      ? [
          {
            label: 'Share',
            icon: 'share',
            onPress: () => {
              void Share.share({ message: shareText(item, childView.name) }).catch(() => {});
            },
          },
          helpItem,
        ]
      : [helpItem];

  return (
    <Screen scroll className="gap-5">
      <DetailHeader title="Appointment details" menu={menu} />
      {status === 'loading' ? <LoadingState /> : null}
      {status === 'error' ? <ErrorState message={error ?? ''} onRetry={reload} /> : null}
      {status === 'ready' && item && childView ? (
        <AppointmentBody item={item} childId={childView.id} />
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
