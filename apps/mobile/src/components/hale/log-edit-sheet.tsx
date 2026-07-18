import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useEffect, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { useMeadowColor } from '@/constants/meadow';
import { ApiError, api } from '@/lib/api-client';
import type { LogView } from '@/lib/api-types';

/** "Today, 2:15 PM" / "Jul 2, 8:40 AM" — the resolved instant read back to the
 * parent (mirrors the quick-log sheet's whenLabel). */
function whenLabel(when: Date): string {
  const now = new Date();
  const sameDay = when.toDateString() === now.toDateString();
  const time = when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today, ${time}`;
  const day = when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${day}, ${time}`;
}

/**
 * The Diary edit/delete sheet opened by tapping a logged row. Edits the two
 * human-facing fields the list shows — the one-liner summary and when it happened
 * (the web editEpisodeSchema) — via PATCH /api/mobile/companion/logs, and soft-deletes
 * via DELETE with a confirm step (the web LogsBrowser register: "Remove this log?" →
 * Remove / Keep). Both wrap the EXACT audited, family-scoped lib (rules #1, #6); a
 * foreign row answers 403 and surfaces "that log isn't yours to edit". Errors surface
 * in place, never a silent success.
 */
export function LogEditSheet({
  log,
  visible,
  onClose,
  onChanged,
}: {
  log: LogView | null;
  visible: boolean;
  onClose: () => void;
  /** Called after a successful edit or delete so the caller can refresh its list. */
  onChanged: () => void;
}) {
  const [summary, setSummary] = useState('');
  const [when, setWhen] = useState<Date>(() => new Date());
  const [showPicker, setShowPicker] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const iconColor = useMeadowColor('ink3');

  useEffect(() => {
    if (visible && log) {
      setSummary(log.summary);
      setWhen(new Date(log.occurredAt));
      setShowPicker(false);
      setConfirmingDelete(false);
      setBusy(false);
      setError(null);
    }
  }, [visible, log]);

  if (!log) return null;

  // A measurement's summary mirrors its charted reading ("Weighed 10.4 kg") —
  // free-text editing it would let Diary and Growth disagree about the same
  // number. The reading stays as logged; only the time is adjustable.
  const isMeasurement = log.episodeType === 'measurement';

  const onPickerChange = (event: DateTimePickerEvent, picked?: Date) => {
    if (Platform.OS !== 'ios') setShowPicker(false);
    if (event.type === 'set' && picked) setWhen(picked);
  };

  const save = async () => {
    const next = isMeasurement ? log.summary : summary.trim();
    if (!next) {
      setError('A log needs a short description.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await api('/api/mobile/companion/logs', {
        method: 'PATCH',
        body: JSON.stringify({ id: log.id, summary: next, occurredAt: when.toISOString() }),
      });
      onChanged();
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      if (e instanceof ApiError && e.status === 403) {
        setError("That log isn't yours to edit.");
      } else {
        setError((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setError(null);
    setBusy(true);
    try {
      await api('/api/mobile/companion/logs', {
        method: 'DELETE',
        body: JSON.stringify({ id: log.id }),
      });
      onChanged();
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      if (e instanceof ApiError && e.status === 403) {
        setError("That log isn't yours to remove.");
      } else {
        setError("Couldn't remove it just now — try again in a moment.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose}>
      <AppText variant="title" className="mb-4">
        Edit log
      </AppText>

      <View className="mb-5">
        {isMeasurement ? (
          <View className="gap-1">
            <AppText variant="body">{log.summary}</AppText>
            <AppText variant="meta" className="text-ink-3">
              The recorded reading stays as logged — you can adjust when it was taken, or
              remove it and add a new one.
            </AppText>
          </View>
        ) : (
          <Field
            label="What happened"
            value={summary}
            onChangeText={setSummary}
            maxLength={280}
            autoCapitalize="sentences"
            multiline
          />
        )}
      </View>

      <View className="mb-5 gap-2">
        <AppText variant="eyebrow">
          When
        </AppText>
        {Platform.OS === 'web' ? (
          <View className="h-12 flex-row items-center gap-2.5 rounded-md border border-rule bg-card px-4">
            <Icon name="calendar" size={16} color={iconColor} />
            <AppText variant="body" className="text-ink">
              {whenLabel(when)}
            </AppText>
          </View>
        ) : (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Exact time: ${whenLabel(when)}. Tap to change.`}
              accessibilityState={{ expanded: showPicker }}
              onPress={() => setShowPicker((s) => !s)}
              className="h-12 flex-row items-center justify-between rounded-md border border-rule bg-card px-4 active:opacity-80"
            >
              <View className="flex-row items-center gap-2.5">
                <Icon name="calendar" size={16} color={iconColor} />
                <AppText variant="body" className="text-ink">
                  {whenLabel(when)}
                </AppText>
              </View>
              <Icon name={showPicker ? 'chevron-up' : 'chevron-down'} size={13} color={iconColor} />
            </Pressable>
            {showPicker ? (
              <View className="items-center">
                <DateTimePicker
                  value={when}
                  mode={Platform.OS === 'ios' ? 'datetime' : 'date'}
                  display={Platform.OS === 'ios' ? 'inline' : 'default'}
                  maximumDate={new Date()}
                  onChange={onPickerChange}
                />
              </View>
            ) : null}
          </>
        )}
      </View>

      {error ? (
        <AppText variant="meta" className="mb-3 text-berry" accessibilityLiveRegion="polite">
          {error}
        </AppText>
      ) : null}

      <Button label={busy && !confirmingDelete ? 'Saving…' : 'Save changes'} onPress={save} disabled={busy} />

      {confirmingDelete ? (
        <View className="mt-4 gap-3 rounded-md border border-rule bg-raised p-4">
          <AppText variant="body" className="text-ink">
            Remove this log? This can't be undone from here.
          </AppText>
          <View className="flex-row gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Yes, remove this log"
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              onPress={remove}
              className={`min-h-11 flex-1 items-center justify-center rounded-full border border-berry ${
                busy ? 'opacity-50' : 'active:opacity-80'
              }`}
            >
              <AppText variant="meta" className="text-berry">
                {busy ? 'Removing…' : 'Remove'}
              </AppText>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Keep this log"
              onPress={() => setConfirmingDelete(false)}
              className="min-h-11 flex-1 items-center justify-center rounded-full border border-rule bg-card active:opacity-80"
            >
              <AppText variant="meta" className="text-ink-2">
                Keep
              </AppText>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Remove this log"
          onPress={() => setConfirmingDelete(true)}
          className="mt-4 min-h-11 flex-row items-center justify-center gap-2 active:opacity-70"
        >
          <Icon name="trash-2" size={15} color={iconColor} />
          <AppText variant="meta" className="text-ink-3">
            Remove this log
          </AppText>
        </Pressable>
      )}
    </Sheet>
  );
}
