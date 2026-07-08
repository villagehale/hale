import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from 'react-native';

import { useMeadowColor } from '@/constants/meadow';
import { ApiError, api } from '@/lib/api-client';

import { AppText } from './app-text';
import { Button } from './button';
import { Field } from './field';
import { Icon } from './icon';

export type LogKind = 'feed' | 'nap' | 'milestone';

type ChildOption = { id: string; name: string | null };

const KIND_META: Record<
  LogKind,
  {
    title: string;
    field: string;
    placeholder: string;
    keyboard: 'numeric' | 'default';
    empty: string;
  }
> = {
  feed: {
    title: 'Log a feed',
    field: 'Amount (ml)',
    placeholder: '120',
    keyboard: 'numeric',
    empty: 'Enter how much (ml) before saving.',
  },
  nap: {
    title: 'Log a nap',
    field: 'Duration (min)',
    placeholder: '45',
    keyboard: 'numeric',
    empty: 'Enter how long (minutes) before saving.',
  },
  milestone: {
    title: 'Note a milestone',
    field: 'What happened',
    placeholder: 'Rolled over for the first time',
    keyboard: 'default',
    empty: 'Enter what happened before saving.',
  },
};

/** Minutes-ago shortcuts for the "when" control. A quick-log is usually "just now"
 * or a short while ago, so these one-tap chips stay — but the exact date+time is
 * always adjustable below via a real picker (an earlier feed the next morning, a
 * milestone from last week). */
const WHEN_PRESETS: { label: string; minutesAgo: number }[] = [
  { label: 'now', minutesAgo: 0 },
  { label: '30m ago', minutesAgo: 30 },
  { label: '1h ago', minutesAgo: 60 },
  { label: '2h ago', minutesAgo: 120 },
];

const minutesAgoDate = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

/** "Today, 2:15 PM" / "Jul 2, 8:40 AM" — the resolved occurred-at, read back to the
 * parent so the picked instant is never a mystery. */
function whenLabel(when: Date): string {
  const now = new Date();
  const sameDay = when.toDateString() === now.toDateString();
  const time = when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today, ${time}`;
  const day = when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${day}, ${time}`;
}

function buildPayload(kind: LogKind, childId: string, entry: string, occurredAt: string) {
  const base = { childId, occurredAt };
  if (kind === 'feed') return { kind, ...base, amountMl: entry };
  if (kind === 'nap') return { kind, ...base, durationMin: entry };
  return { kind, ...base, milestone: entry };
}

/**
 * The shared in-place quick-log sheet. Opens for the tapped kind with the right
 * field (feed=amount, nap=duration, milestone=text) plus a "when" control that
 * defaults to now. Sends occurredAt (ISO) so an earlier event lands at the right
 * time. POSTs the SAME /api/mobile/companion/log endpoint the companion uses —
 * one write path, one audit row (rule #6). Errors surface in place, never a
 * silent success.
 */
export function QuickLogModal({
  visible,
  kind,
  kids,
  onClose,
  onLogged,
}: {
  visible: boolean;
  kind: LogKind | null;
  kids: ChildOption[];
  onClose: () => void;
  onLogged: () => void;
}) {
  const [childId, setChildId] = useState('');
  const [value, setValue] = useState('');
  const [when, setWhen] = useState<Date>(() => new Date());
  // The preset chip that produced `when`, or null once an exact time is picked —
  // so the highlight is unambiguous instead of guessed from fragile time math.
  const [activePreset, setActivePreset] = useState(0);
  const [showPicker, setShowPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const iconColor = useMeadowColor('ink3');

  useEffect(() => {
    if (visible) {
      setChildId(kids[0]?.id ?? '');
      setValue('');
      setWhen(new Date());
      setActivePreset(0);
      setShowPicker(false);
      setError(null);
      setSaving(false);
    }
  }, [visible, kids]);

  const pickPreset = (minutesAgo: number) => {
    setWhen(minutesAgoDate(minutesAgo));
    setActivePreset(minutesAgo);
    setShowPicker(false);
  };

  const onPickerChange = (event: DateTimePickerEvent, picked?: Date) => {
    // Android fires 'dismissed' on cancel and closes its own dialog; iOS keeps the
    // inline picker open until the parent hides it, so only Android toggles here.
    if (Platform.OS !== 'ios') setShowPicker(false);
    if (event.type === 'set' && picked) {
      setWhen(picked);
      setActivePreset(-1);
    }
  };

  if (!kind) return null;
  const meta = KIND_META[kind];

  const save = async () => {
    const entry = value.trim();
    if (!entry) {
      setError(meta.empty);
      return;
    }
    if (!childId) {
      setError('Add a child first.');
      return;
    }
    setError(null);
    setSaving(true);
    const occurredAt = when.toISOString();
    try {
      await api('/api/mobile/companion/log', {
        method: 'POST',
        body: JSON.stringify(buildPayload(kind, childId, entry, occurredAt)),
      });
      onLogged();
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1"
      >
        <Pressable
          className="flex-1 justify-end bg-black/40"
          onPress={onClose}
          accessibilityLabel="Close"
        >
          {/* Sheet: a Pressable so taps inside don't dismiss; the inner ScrollView keeps
              the field + Save reachable above the keyboard / a tall inline picker. */}
          <Pressable
            onPress={(e) => e.stopPropagation()}
            className="max-h-[88%] rounded-t-[28px] border-t border-rule bg-canvas"
          >
            <ScrollView
              className="px-5 pt-3"
              contentContainerClassName="pb-8"
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <View className="mb-5 h-1.5 w-10 self-center rounded-full bg-rule-strong" />

              <AppText variant="title" className="mb-4">
                {meta.title}
              </AppText>

              {kids.length > 1 ? (
                <View className="mb-4 flex-row gap-2 rounded-full border border-rule bg-card p-1">
                  {kids.map((child) => {
                    const active = child.id === childId;
                    return (
                      <Pressable
                        key={child.id}
                        accessibilityRole="button"
                        accessibilityLabel={`Log for ${child.name ?? 'child'}`}
                        accessibilityState={active ? { selected: true } : {}}
                        onPress={() => setChildId(child.id)}
                        className={`flex-1 items-center rounded-full py-2 ${active ? 'bg-raised' : ''}`}
                      >
                        <AppText variant="meta" className={active ? 'text-ink' : 'text-ink-3'}>
                          {child.name ?? 'Child'}
                        </AppText>
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}

              <View className="mb-5">
                <Field
                  label={meta.field}
                  value={value}
                  onChangeText={setValue}
                  keyboardType={meta.keyboard}
                  placeholder={meta.placeholder}
                  autoCapitalize={kind === 'milestone' ? 'sentences' : 'none'}
                  autoFocus
                />
              </View>

              <View className="mb-5 gap-2">
                <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
                  When
                </AppText>
                <View className="flex-row gap-2">
                  {WHEN_PRESETS.map((preset) => {
                    const active = preset.minutesAgo === activePreset;
                    return (
                      <Pressable
                        key={preset.label}
                        accessibilityRole="button"
                        accessibilityLabel={`When: ${preset.label}`}
                        accessibilityState={active ? { selected: true } : {}}
                        onPress={() => pickPreset(preset.minutesAgo)}
                        className={`h-11 flex-1 items-center justify-center rounded-full border ${
                          active ? 'border-ink bg-ink' : 'border-rule bg-card'
                        }`}
                      >
                        <AppText variant="meta" className={active ? 'text-on-ink' : 'text-ink-2'}>
                          {preset.label}
                        </AppText>
                      </Pressable>
                    );
                  })}
                </View>

                {/* The exact date+time picker is a native module (no web impl), so on the
                    RN-web preview we show the resolved time read-only; presets still set it. */}
                {Platform.OS === 'web' ? (
                  <View className="mt-1 h-12 flex-row items-center gap-2.5 rounded-md border border-rule bg-card px-4">
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
                      className="mt-1 h-12 flex-row items-center justify-between rounded-md border border-rule bg-card px-4 active:opacity-80"
                    >
                      <View className="flex-row items-center gap-2.5">
                        <Icon name="calendar" size={16} color={iconColor} />
                        <AppText variant="body" className="text-ink">
                          {whenLabel(when)}
                        </AppText>
                      </View>
                      <Icon
                        name={showPicker ? 'chevron.up' : 'chevron.down'}
                        size={13}
                        color={iconColor}
                      />
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
                <AppText
                  variant="meta"
                  className="mb-3 text-berry"
                  accessibilityLiveRegion="polite"
                >
                  {error}
                </AppText>
              ) : null}

              <Button label={saving ? 'Saving…' : 'Save log'} onPress={save} />
            </ScrollView>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}
