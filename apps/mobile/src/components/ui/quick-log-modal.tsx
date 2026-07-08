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

/** A child in the picker. `milestoneSuggestions` are the `what` strings from that
 * child's stage catalog (MILESTONES_BY_STAGE via the companion payload) — the
 * tappable milestone chips, filtered to the selected child's stage. */
type ChildOption = { id: string; name: string | null; milestoneSuggestions: string[] };

/** How many stage milestone chips to offer before the free-text field. */
const MILESTONE_CHIP_LIMIT = 6;

/** The feed kinds the server accepts (log-types FEED_KINDS) with their sheet
 * labels. Selecting one sends feedKind so the summary reads "Fed 200 ml (bottle)". */
const FEED_KINDS: { value: 'bottle' | 'breast' | 'solid'; label: string }[] = [
  { value: 'bottle', label: 'Bottle' },
  { value: 'breast', label: 'Breast' },
  { value: 'solid', label: 'Solids' },
];

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
    empty: 'Enter how long (minutes), or set a start and end.',
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

/** "1h 45m" / "45m" — the nap window's derived length, read back so the parent sees
 * what the start/end pair means before saving. */
function durationLabel(startAt: Date, endAt: Date): string {
  const min = Math.round((endAt.getTime() - startAt.getTime()) / 60_000);
  if (min <= 0) return 'end is before start';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Builds the POST body for the tapped kind. A nap sends a start/end WINDOW when the
 * parent set one (the server derives the duration); otherwise the plain duration.
 * A feed carries feedKind when picked. An optional note rides all three. */
function buildPayload(args: {
  kind: LogKind;
  childId: string;
  entry: string;
  occurredAt: string;
  feedKind: string | null;
  napWindow: { startAt: string; endAt: string } | null;
  note: string;
}) {
  const { kind, childId, entry, occurredAt, feedKind, napWindow, note } = args;
  const trimmedNote = note.trim();
  const base: Record<string, unknown> = { kind, childId, occurredAt };
  if (trimmedNote) base.note = trimmedNote;
  if (kind === 'feed') {
    return { ...base, amountMl: entry, ...(feedKind ? { feedKind } : {}) };
  }
  if (kind === 'nap') {
    if (napWindow) return { ...base, startAt: napWindow.startAt, endAt: napWindow.endAt };
    return { ...base, durationMin: entry };
  }
  return { ...base, milestone: entry };
}

/**
 * The shared in-place quick-log sheet. Opens for the tapped kind with the right
 * field (feed=amount + kind chips, nap=duration OR a start/end window, milestone=
 * text) plus a "when" control that defaults to now and one quiet optional note.
 * Sends occurredAt (ISO) so an earlier event lands at the right time; a nap window
 * sends startAt/endAt (ISO) and the server derives the duration. POSTs the SAME
 * /api/mobile/companion/log endpoint the companion uses — one write path, one audit
 * row (rule #6). Errors surface in place, never a silent success.
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
  const [feedKind, setFeedKind] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [when, setWhen] = useState<Date>(() => new Date());
  // The preset chip that produced `when`, or null once an exact time is picked —
  // so the highlight is unambiguous instead of guessed from fragile time math.
  const [activePreset, setActivePreset] = useState(0);
  const [showPicker, setShowPicker] = useState(false);
  // A nap's optional start/end window. When both are set, they drive the duration
  // (the plain minutes field is ignored); until then the minutes field is used.
  const [napStart, setNapStart] = useState<Date | null>(null);
  const [napEnd, setNapEnd] = useState<Date | null>(null);
  const [openNapPicker, setOpenNapPicker] = useState<'start' | 'end' | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const iconColor = useMeadowColor('ink3');

  useEffect(() => {
    if (visible) {
      setChildId(kids[0]?.id ?? '');
      setValue('');
      setFeedKind(null);
      setNote('');
      setWhen(new Date());
      setActivePreset(0);
      setShowPicker(false);
      setNapStart(null);
      setNapEnd(null);
      setOpenNapPicker(null);
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

  const onNapPickerChange = (which: 'start' | 'end') => (event: DateTimePickerEvent, picked?: Date) => {
    if (Platform.OS !== 'ios') setOpenNapPicker(null);
    if (event.type === 'set' && picked) {
      if (which === 'start') setNapStart(picked);
      else setNapEnd(picked);
    }
  };

  if (!kind) return null;
  const meta = KIND_META[kind];
  const hasNapWindow = napStart !== null && napEnd !== null;
  // The tappable stage-milestone chips for the CURRENTLY selected child — so the
  // suggestions track the picker. Capped to keep the sheet head compact.
  const milestoneSuggestions =
    kind === 'milestone'
      ? (kids.find((k) => k.id === childId)?.milestoneSuggestions ?? []).slice(
          0,
          MILESTONE_CHIP_LIMIT,
        )
      : [];

  const save = async () => {
    const entry = value.trim();
    // A nap with a complete window doesn't need the minutes field; every other
    // shape needs its primary entry.
    if (!(kind === 'nap' && hasNapWindow) && !entry) {
      setError(meta.empty);
      return;
    }
    if (!childId) {
      setError('Add a child first.');
      return;
    }
    if (kind === 'nap' && hasNapWindow && napEnd.getTime() <= napStart.getTime()) {
      setError('The nap end must be after its start.');
      return;
    }
    setError(null);
    setSaving(true);
    const napWindow =
      kind === 'nap' && hasNapWindow
        ? { startAt: napStart.toISOString(), endAt: napEnd.toISOString() }
        : null;
    // A window nap belongs to the day it ENDED, not the moment it was typed —
    // a 23:00–23:45 nap logged at 00:30 must not bucket under "today".
    const occurredAt = napWindow ? napWindow.endAt : when.toISOString();
    try {
      await api('/api/mobile/companion/log', {
        method: 'POST',
        body: JSON.stringify(
          buildPayload({ kind, childId, entry, occurredAt, feedKind, napWindow, note }),
        ),
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

              {milestoneSuggestions.length > 0 ? (
                <View className="mb-4 gap-2">
                  <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
                    Common for this stage
                  </AppText>
                  <View className="flex-row flex-wrap gap-2">
                    {milestoneSuggestions.map((suggestion) => {
                      const active = value.trim() === suggestion;
                      return (
                        <Pressable
                          key={suggestion}
                          accessibilityRole="button"
                          accessibilityLabel={`Milestone: ${suggestion}`}
                          accessibilityState={active ? { selected: true } : {}}
                          onPress={() => setValue(suggestion)}
                          className={`rounded-full border px-3.5 py-2 active:opacity-80 ${
                            active ? 'border-ink bg-ink' : 'border-rule bg-card'
                          }`}
                        >
                          <AppText variant="meta" className={active ? 'text-on-ink' : 'text-ink-2'}>
                            {suggestion}
                          </AppText>
                        </Pressable>
                      );
                    })}
                  </View>
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
                {kind === 'nap' && hasNapWindow ? (
                  <AppText variant="meta" className="mt-1.5 text-ink-3">
                    Using the start and end below — the minutes field is optional.
                  </AppText>
                ) : null}
              </View>

              {kind === 'feed' ? (
                <View className="mb-5 gap-2">
                  <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
                    Kind (optional)
                  </AppText>
                  <View className="flex-row gap-2">
                    {FEED_KINDS.map((fk) => {
                      const active = fk.value === feedKind;
                      return (
                        <Pressable
                          key={fk.value}
                          accessibilityRole="button"
                          accessibilityLabel={`Feed kind: ${fk.label}`}
                          accessibilityState={active ? { selected: true } : {}}
                          onPress={() => setFeedKind(active ? null : fk.value)}
                          className={`h-11 flex-1 items-center justify-center rounded-full border ${
                            active ? 'border-ink bg-ink' : 'border-rule bg-card'
                          }`}
                        >
                          <AppText variant="meta" className={active ? 'text-on-ink' : 'text-ink-2'}>
                            {fk.label}
                          </AppText>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              ) : null}

              {kind === 'nap' ? (
                <View className="mb-5 gap-2">
                  <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
                    Start &amp; end (optional)
                  </AppText>
                  <NapBoundRow
                    label="Start"
                    value={napStart}
                    open={openNapPicker === 'start'}
                    onToggle={() => setOpenNapPicker((p) => (p === 'start' ? null : 'start'))}
                    onChange={onNapPickerChange('start')}
                    iconColor={iconColor}
                  />
                  <NapBoundRow
                    label="End"
                    value={napEnd}
                    open={openNapPicker === 'end'}
                    onToggle={() => setOpenNapPicker((p) => (p === 'end' ? null : 'end'))}
                    onChange={onNapPickerChange('end')}
                    iconColor={iconColor}
                  />
                  {hasNapWindow ? (
                    <AppText variant="meta" className="text-ink-2">
                      Duration: {durationLabel(napStart, napEnd)}
                    </AppText>
                  ) : null}
                </View>
              ) : null}

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

              <View className="mb-5">
                <Field
                  label="Note (optional)"
                  value={note}
                  onChangeText={setNote}
                  placeholder="Anything worth remembering"
                  autoCapitalize="sentences"
                  maxLength={280}
                  multiline
                />
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

              <Button
                label={
                  saving ? 'Saving…' : kind === 'milestone' ? 'Create milestone' : 'Save log'
                }
                onPress={save}
              />
            </ScrollView>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** Merges the calendar day of `date` with the hour/minute of `time` into one Date,
 * keeping seconds/ms zeroed — the two-step Android flow picks a day, then a
 * time-of-day, and this combines them. For a nap PAIR the time-of-day is the whole
 * point (a same-day window is inexpressible from a date-only picker). */
function combineDayAndTime(date: Date, time: Date): Date {
  const combined = new Date(date);
  combined.setHours(time.getHours(), time.getMinutes(), 0, 0);
  return combined;
}

/** One bound of a nap window (Start / End): a tappable row that reads the picked
 * instant back and discloses a native date+time picker. iOS uses one inline
 * 'datetime' picker; Android's community picker can't do 'datetime' in one dialog,
 * and for a start/end PAIR the time-of-day is the whole point — a date-only pick
 * leaves both bounds at the same time and the window is rejected — so Android runs a
 * two-step date→time flow and only commits the merged instant once time is chosen.
 * On RN-web (no native picker) it stays read-only, mirroring the "when" control. */
function NapBoundRow({
  label,
  value,
  open,
  onToggle,
  onChange,
  iconColor,
}: {
  label: string;
  value: Date | null;
  open: boolean;
  onToggle: () => void;
  onChange: (event: DateTimePickerEvent, picked?: Date) => void;
  iconColor: string;
}) {
  // Android only: the day chosen in step 1, held while the time picker (step 2) is
  // open. Null when no two-step flow is in progress.
  const [androidPendingDay, setAndroidPendingDay] = useState<Date | null>(null);
  const display = value ? whenLabel(value) : `Set ${label.toLowerCase()}`;

  const onAndroidDate = (event: DateTimePickerEvent, picked?: Date) => {
    onToggle(); // close step-1 dialog (parent tracks open)
    if (event.type !== 'set' || !picked) return;
    setAndroidPendingDay(picked);
  };

  const onAndroidTime = (event: DateTimePickerEvent, picked?: Date) => {
    const day = androidPendingDay;
    setAndroidPendingDay(null);
    if (event.type !== 'set' || !picked || !day) return;
    onChange(event, combineDayAndTime(day, picked));
  };

  return (
    <View className="gap-1.5">
      <AppText variant="meta" className="text-ink-2">
        {label}
      </AppText>
      {Platform.OS === 'web' ? (
        <View className="h-12 flex-row items-center gap-2.5 rounded-md border border-rule bg-card px-4">
          <Icon name="calendar" size={16} color={iconColor} />
          <AppText variant="body" className={value ? 'text-ink' : 'text-ink-3'}>
            {display}
          </AppText>
        </View>
      ) : (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${label}: ${display}. Tap to change.`}
            accessibilityState={{ expanded: open }}
            onPress={onToggle}
            className="h-12 flex-row items-center justify-between rounded-md border border-rule bg-card px-4 active:opacity-80"
          >
            <View className="flex-row items-center gap-2.5">
              <Icon name="calendar" size={16} color={iconColor} />
              <AppText variant="body" className={value ? 'text-ink' : 'text-ink-3'}>
                {display}
              </AppText>
            </View>
            <Icon name={open ? 'chevron.up' : 'chevron.down'} size={13} color={iconColor} />
          </Pressable>
          {Platform.OS === 'ios' ? (
            open ? (
              <View className="items-center">
                <DateTimePicker
                  value={value ?? new Date()}
                  mode="datetime"
                  display="inline"
                  maximumDate={new Date()}
                  onChange={onChange}
                />
              </View>
            ) : null
          ) : (
            <>
              {open ? (
                <DateTimePicker
                  value={value ?? new Date()}
                  mode="date"
                  display="default"
                  maximumDate={new Date()}
                  onChange={onAndroidDate}
                />
              ) : null}
              {androidPendingDay ? (
                <DateTimePicker
                  value={value ?? androidPendingDay}
                  mode="time"
                  display="default"
                  onChange={onAndroidTime}
                />
              ) : null}
            </>
          )}
        </>
      )}
    </View>
  );
}
