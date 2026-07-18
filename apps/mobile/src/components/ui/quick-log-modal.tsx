import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useEffect, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';

import { useMeadowColor } from '@/constants/meadow';
import { ApiError, api } from '@/lib/api-client';
import {
  buildLogPayload,
  DIAPER_KIND,
  type DiaperKindValue,
  FEED_AMOUNT,
  FEED_WHAT,
  type LogKind,
  NAP_QUALITY,
  SHEET_TITLE,
} from '@/lib/quick-log-payload';

import { AppText } from './app-text';
import { Button } from './button';
import { Field } from './field';
import { Icon } from './icon';
import { Sheet } from './sheet';

export type { LogKind };

/** A child in the picker. `milestoneSuggestions` are the `what` strings from that
 * child's stage catalog (MILESTONES_BY_STAGE via the companion payload) — the
 * tappable milestone rows, filtered to the selected child's stage. */
type ChildOption = { id: string; name: string | null; milestoneSuggestions: string[] };

/** How many stage milestone rows to offer before the free-text field. */
const MILESTONE_ROW_LIMIT = 6;

/** Minutes-ago shortcuts for the "when" control. A quick-log is usually "just now"
 * or a short while ago, so these one-tap chips stay — but the exact date+time is
 * always adjustable below via a real picker (an earlier feed the next morning). */
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

/** A grid of selectable chips, filled brand-blue when active (handoff selected-chip:
 * 1.5px brand border + #EDF0FA face). Chunked into rows of `cols` so each chip keeps
 * an equal flex width and the 9px gutter stays aligned across rows. */
function ChipGrid({
  cols,
  items,
}: {
  cols: number;
  items: { label: string; active: boolean; onPress: () => void }[];
}) {
  const rows: (typeof items)[] = [];
  for (let i = 0; i < items.length; i += cols) rows.push(items.slice(i, i + cols));
  return (
    <View className="gap-2.5">
      {rows.map((row) => (
        <View key={row[0]?.label} className="flex-row gap-2.5">
          {row.map((it) => (
            <Pressable
              key={it.label}
              accessibilityRole="button"
              accessibilityLabel={it.label}
              accessibilityState={it.active ? { selected: true } : {}}
              onPress={it.onPress}
              className={`flex-1 items-center justify-center rounded-[13px] border-[1.5px] px-1.5 py-3 active:opacity-80 ${
                it.active ? 'border-brand bg-chip-blue' : 'border-rule bg-card'
              }`}
            >
              <AppText variant="meta" className="text-center text-ink">
                {it.label}
              </AppText>
            </Pressable>
          ))}
          {row.length < cols
            ? Array.from({ length: cols - row.length }).map((_, k) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: pad cells, no identity
                <View key={`pad-${k}`} className="flex-1" />
              ))
            : null}
        </View>
      ))}
    </View>
  );
}

function SheetLabel({ children }: { children: string }) {
  return (
    <AppText variant="meta" className="mb-2.5 text-ink-2">
      {children}
    </AppText>
  );
}

/**
 * The shared in-place quick-log sheet, in the handoff's four-kind form: feed (what +
 * how-much chips), nap (a start/end window + quality chips), diaper (kind chips), and
 * milestone (stage rows + free text). Each POSTs the SAME audited
 * /api/mobile/companion/log route the companion uses — one write path, one audit row
 * (rule #6). Errors surface in place, never a silent success. See task-9-report for
 * the feed chip → amountMl/feedKind mapping.
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
  const [feedWhat, setFeedWhat] = useState('Milk');
  const [feedAmount, setFeedAmount] = useState('Most of it');
  const [napQuality, setNapQuality] = useState<string>('Good');
  const [diaperKind, setDiaperKind] = useState<DiaperKindValue>('wet');
  const [milestone, setMilestone] = useState('');
  const [note, setNote] = useState('');
  const [when, setWhen] = useState<Date>(() => new Date());
  // The preset chip that produced `when`, or -1 once an exact time is picked — so the
  // highlight is unambiguous instead of guessed from fragile time math.
  const [activePreset, setActivePreset] = useState(0);
  const [showPicker, setShowPicker] = useState(false);
  // A nap's start/end window drives the duration (the server derives it) on native.
  // RN-web has no native time picker, so there the nap is a plain minutes entry
  // instead (napMinutes) — the QA path stays saveable.
  const [napStart, setNapStart] = useState<Date | null>(null);
  const [napEnd, setNapEnd] = useState<Date | null>(null);
  const [napMinutes, setNapMinutes] = useState('');
  const [openNapPicker, setOpenNapPicker] = useState<'start' | 'end' | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const iconColor = useMeadowColor('ink3');

  useEffect(() => {
    if (visible) {
      setChildId(kids[0]?.id ?? '');
      setFeedWhat('Milk');
      setFeedAmount('Most of it');
      setNapQuality('Good');
      setDiaperKind('wet');
      setMilestone('');
      setNote('');
      setWhen(new Date());
      setActivePreset(0);
      setShowPicker(false);
      setNapStart(null);
      setNapEnd(null);
      setNapMinutes('');
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

  const onNapPickerChange =
    (which: 'start' | 'end') => (event: DateTimePickerEvent, picked?: Date) => {
      if (Platform.OS !== 'ios') setOpenNapPicker(null);
      if (event.type === 'set' && picked) {
        if (which === 'start') setNapStart(picked);
        else setNapEnd(picked);
      }
    };

  if (!kind) return null;
  const hasNapWindow = napStart !== null && napEnd !== null;
  const childName = kids.find((k) => k.id === childId)?.name ?? 'your little one';
  // The tappable stage-milestone rows for the CURRENTLY selected child — so the
  // suggestions track the picker. Capped to keep the sheet head compact.
  const milestoneSuggestions =
    kind === 'milestone'
      ? (kids.find((k) => k.id === childId)?.milestoneSuggestions ?? []).slice(0, MILESTONE_ROW_LIMIT)
      : [];

  const save = async () => {
    if (!childId) {
      setError('Add a child first.');
      return;
    }
    if (kind === 'nap') {
      if (Platform.OS === 'web') {
        const mins = Number(napMinutes.trim());
        if (!napMinutes.trim() || Number.isNaN(mins) || mins <= 0) {
          setError('Enter how many minutes the nap was.');
          return;
        }
      } else if (!hasNapWindow) {
        setError("Set the nap's start and end times.");
        return;
      } else if (napEnd.getTime() <= napStart.getTime()) {
        setError('The nap end must be after its start.');
        return;
      }
    }
    if (kind === 'milestone' && !milestone.trim()) {
      setError('Choose a milestone, or write your own.');
      return;
    }
    setError(null);
    setSaving(true);
    // A window nap belongs to the day it ENDED, not the moment it was typed — a
    // 23:00–23:45 nap logged at 00:30 must not bucket under "today".
    const occurredAt =
      kind === 'nap' && hasNapWindow ? napEnd.toISOString() : when.toISOString();
    const payload = buildLogPayload({
      kind,
      childId,
      occurredAt,
      feedWhat,
      feedAmount,
      napQuality,
      napStartAt: napStart?.toISOString() ?? null,
      napEndAt: napEnd?.toISOString() ?? null,
      napDurationMin: napMinutes.trim() ? Number(napMinutes.trim()) : null,
      diaperKind,
      milestone,
      note,
    });
    try {
      await api('/api/mobile/companion/log', {
        method: 'POST',
        body: JSON.stringify(payload),
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
    <Sheet visible={visible} onClose={onClose} title={SHEET_TITLE[kind]}>
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

      {kind === 'feed' ? (
        <>
          <SheetLabel>{`What did ${childName} have?`}</SheetLabel>
          <View className="mb-4">
            <ChipGrid
              cols={3}
              items={FEED_WHAT.map((w) => ({
                label: w.label,
                active: w.label === feedWhat,
                onPress: () => setFeedWhat(w.label),
              }))}
            />
          </View>
          <SheetLabel>How much</SheetLabel>
          <View className="mb-4">
            <ChipGrid
              cols={4}
              items={FEED_AMOUNT.map((a) => ({
                label: a.label,
                active: a.label === feedAmount,
                onPress: () => setFeedAmount(a.label),
              }))}
            />
          </View>
        </>
      ) : null}

      {kind === 'nap' ? (
        <>
          {Platform.OS === 'web' ? (
            // RN-web has no native time picker, so the window rows can't be set here;
            // a plain minutes entry keeps the QA path saveable (server takes durationMin).
            <View className="mb-4">
              <Field
                label="Duration (minutes)"
                value={napMinutes}
                onChangeText={setNapMinutes}
                keyboardType="numeric"
                placeholder="45"
                autoCapitalize="none"
              />
            </View>
          ) : (
            <>
              <SheetLabel>{`What time did ${childName} nap?`}</SheetLabel>
              <View className="mb-4 gap-2.5">
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
                  <View className="flex-row items-center justify-between rounded-[13px] border border-rule px-3.5 py-3">
                    <AppText variant="meta" className="text-ink-2">
                      Duration
                    </AppText>
                    <AppText variant="meta" className="text-ink">
                      {durationLabel(napStart, napEnd)}
                    </AppText>
                  </View>
                ) : null}
              </View>
            </>
          )}
          <SheetLabel>Quality</SheetLabel>
          <View className="mb-4">
            <ChipGrid
              cols={4}
              items={NAP_QUALITY.map((q) => ({
                label: q,
                active: q === napQuality,
                onPress: () => setNapQuality(q),
              }))}
            />
          </View>
        </>
      ) : null}

      {kind === 'diaper' ? (
        <>
          <SheetLabel>What kind?</SheetLabel>
          <View className="mb-4">
            <ChipGrid
              cols={4}
              items={DIAPER_KIND.map((d) => ({
                label: d.label,
                active: d.value === diaperKind,
                onPress: () => setDiaperKind(d.value),
              }))}
            />
          </View>
        </>
      ) : null}

      {kind === 'milestone' ? (
        <>
          <SheetLabel>Choose a milestone</SheetLabel>
          {milestoneSuggestions.length > 0 ? (
            <View className="mb-4 overflow-hidden rounded-2xl border border-rule">
              {milestoneSuggestions.map((suggestion, i) => {
                const active = milestone.trim() === suggestion;
                return (
                  <Pressable
                    key={suggestion}
                    accessibilityRole="button"
                    accessibilityLabel={`Milestone: ${suggestion}`}
                    accessibilityState={active ? { selected: true } : {}}
                    onPress={() => setMilestone(suggestion)}
                    className={`flex-row items-center gap-3 px-4 py-3.5 active:opacity-80 ${
                      i === 0 ? '' : 'border-t border-hairline'
                    } ${active ? 'bg-chip-blue' : ''}`}
                  >
                    <AppText variant="body" className="flex-1 text-ink">
                      {suggestion}
                    </AppText>
                    <Icon
                      name={active ? 'check' : 'chevron-right'}
                      size={active ? 16 : 14}
                      color={iconColor}
                    />
                  </Pressable>
                );
              })}
            </View>
          ) : null}
          <View className="mb-4">
            <Field
              label={milestoneSuggestions.length > 0 ? 'Or write your own' : 'What happened'}
              value={milestone}
              onChangeText={setMilestone}
              placeholder="Rolled over for the first time"
              autoCapitalize="sentences"
              maxLength={280}
            />
          </View>
        </>
      ) : null}

      {kind === 'feed' || kind === 'diaper' ? (
        <View className="mb-4">
          <Field
            label="Notes (optional)"
            value={note}
            onChangeText={setNote}
            placeholder={
              kind === 'diaper' ? 'e.g. Slight rash, applied cream' : 'e.g. Ate avocado and sweet potato'
            }
            autoCapitalize="sentences"
            maxLength={280}
            multiline
          />
        </View>
      ) : null}

      {kind === 'feed' || kind === 'diaper' ? (
        <View className="mb-5 gap-2.5">
          <SheetLabel>Time</SheetLabel>
          <View className="flex-row gap-2.5">
            {WHEN_PRESETS.map((preset) => {
              const active = preset.minutesAgo === activePreset;
              return (
                <Pressable
                  key={preset.label}
                  accessibilityRole="button"
                  accessibilityLabel={`When: ${preset.label}`}
                  accessibilityState={active ? { selected: true } : {}}
                  onPress={() => pickPreset(preset.minutesAgo)}
                  className={`h-11 flex-1 items-center justify-center rounded-full border-[1.5px] ${
                    active ? 'border-brand bg-chip-blue' : 'border-rule bg-card'
                  }`}
                >
                  <AppText variant="meta" className="text-ink">
                    {preset.label}
                  </AppText>
                </Pressable>
              );
            })}
          </View>

          {/* The exact date+time picker is a native module (no web impl), so on the
              RN-web preview we show the resolved time read-only; presets still set it. */}
          {Platform.OS === 'web' ? (
            <View className="h-12 flex-row items-center gap-2.5 rounded-[13px] border border-rule px-4">
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
                className="h-12 flex-row items-center justify-between rounded-[13px] border border-rule px-4 active:opacity-80"
              >
                <View className="flex-row items-center gap-2.5">
                  <Icon name="calendar" size={16} color={iconColor} />
                  <AppText variant="body" className="text-ink">
                    {whenLabel(when)}
                  </AppText>
                </View>
                <Icon
                  name={showPicker ? 'chevron-up' : 'chevron-down'}
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
      ) : null}

      {error ? (
        <AppText variant="meta" className="mb-3 text-berry" accessibilityLiveRegion="polite">
          {error}
        </AppText>
      ) : null}

      <Button
        label={saving ? 'Saving…' : kind === 'milestone' ? 'Create milestone' : 'Save'}
        onPress={save}
        disabled={saving}
      />
    </Sheet>
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
      {Platform.OS === 'web' ? (
        <View className="flex-row items-center justify-between rounded-[13px] border border-rule px-3.5 py-3">
          <AppText variant="meta" className="text-ink-2">
            {label}
          </AppText>
          <AppText variant="meta" className={value ? 'text-ink' : 'text-ink-3'}>
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
            className="flex-row items-center justify-between rounded-[13px] border border-rule px-3.5 py-3 active:opacity-80"
          >
            <AppText variant="meta" className="text-ink-2">
              {label}
            </AppText>
            <View className="flex-row items-center gap-2">
              <AppText variant="meta" className={value ? 'text-ink' : 'text-ink-3'}>
                {display}
              </AppText>
              <Icon name={open ? 'chevron-up' : 'chevron-down'} size={13} color={iconColor} />
            </View>
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
