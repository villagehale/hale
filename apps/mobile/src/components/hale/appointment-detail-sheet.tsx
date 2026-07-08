import { useEffect, useState } from 'react';
import { Pressable, Share, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Tag } from '@/components/ui/tag';
import { useMeadowColor } from '@/constants/meadow';
import { ApiError, api } from '@/lib/api-client';
import type { UpcomingHealthItem } from '@/lib/api-types';
import { duePhrase } from '@/lib/format';

/** The plain, honest text a Share hands off — the item, its timing, and the
 * standard-schedule caveat. No fabricated calendar link (expo-calendar isn't
 * installed; the create_calendar_event executor is not configured — task). */
function shareText(item: UpcomingHealthItem, childName: string | null): string {
  const who = childName ? `${childName}: ` : '';
  return `${who}${item.what} — ${duePhrase(item.dueInWeeks)}.\nTiming is the standard Canadian schedule — confirm with your provider.`;
}

/**
 * The appointment detail sheet opened by tapping an Up-next health row: the item's
 * what / when / done state, the standard-schedule provenance line (the screen's
 * register), a Share affordance (native Share of the plain details — free and
 * honest), and a real "Mark done" that POSTs the audited /api/mobile/companion/done
 * (rule #6, the same lib the web markCompanionItemDone action uses). There is NO
 * add-to-calendar write — expo-calendar isn't installed and the executor is not
 * configured, so the sheet never fakes one.
 */
export function AppointmentDetailSheet({
  item,
  childId,
  childName,
  visible,
  onClose,
  onDone,
}: {
  item: UpcomingHealthItem | null;
  childId: string;
  childName: string | null;
  visible: boolean;
  onClose: () => void;
  /** Called after a successful mark-done so the caller can refresh its view. */
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [marked, setMarked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const iconColor = useMeadowColor('ink2');
  const onInk = useMeadowColor('onAccent');

  useEffect(() => {
    if (visible) {
      setBusy(false);
      setMarked(false);
      setError(null);
    }
  }, [visible]);

  if (!item) return null;
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
      onDone();
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError("Couldn't mark it done just now — try again in a moment.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose}>
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
            <Icon name="checkmark" size={15} color={onInk} />
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
          <Icon name="square.and.arrow.up" size={15} color={iconColor} />
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
    </Sheet>
  );
}
