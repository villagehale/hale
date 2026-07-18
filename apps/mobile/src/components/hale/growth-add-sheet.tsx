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
import { composeMeasurementLog } from '@/lib/measurement-compose';
import { MEASURE_KINDS, MEASURE_LABEL, type MeasureKind } from '@/lib/measurement-series';
import { displayMeasurement, type UnitSystem } from '@/lib/measurement-units';

/** The entry unit shown in the field label per (kind, units) — the same unit
 * displayMeasurement renders, so the label and the growth list never disagree.
 * kg/cm in metric; lb/in in imperial. */
function entryUnit(kind: MeasureKind, units: UnitSystem): string {
  return displayMeasurement(0, kind, units).unit;
}

/** A plausible example value for the placeholder, per (kind, units). */
function entryPlaceholder(kind: MeasureKind, units: UnitSystem): string {
  if (units === 'imperial') return kind === 'weight' ? '23' : '24';
  return kind === 'weight' ? '10.4' : '62';
}

const WHEN_PRESETS: { label: string; daysAgo: number }[] = [
  { label: 'today', daysAgo: 0 },
  { label: 'yesterday', daysAgo: 1 },
  { label: 'last week', daysAgo: 7 },
];

const daysAgoDate = (daysAgo: number) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d;
};

/** "Today" / "Jul 2" — the resolved date read back to the parent. */
function whenLabel(when: Date): string {
  const now = new Date();
  if (when.toDateString() === now.toDateString()) return 'Today';
  return when.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * The Add-measurement sheet: pick a kind (weight / height / head), enter the value in
 * its fixed unit, and pick when it was taken. POSTs the SAME audited
 * /api/mobile/companion/log route a quick-log uses (rule #6, one write path, one audit
 * row) with kind 'measurement'. NO percentile or WHO comparison is offered — the
 * register stays "confirm with your provider". Errors surface in place.
 */
export function GrowthAddSheet({
  childId,
  visible,
  initialKind,
  units,
  onClose,
  onLogged,
}: {
  childId: string;
  visible: boolean;
  /** The kind pre-selected when opened from a specific series card. */
  initialKind: MeasureKind;
  /** The parent's chosen unit system — drives the entry label/placeholder and the
   * metric conversion on save (storage stays metric regardless). */
  units: UnitSystem;
  onClose: () => void;
  onLogged: () => void;
}) {
  const [measureKind, setMeasureKind] = useState<MeasureKind>(initialKind);
  const [value, setValue] = useState('');
  const [when, setWhen] = useState<Date>(() => new Date());
  const [activePreset, setActivePreset] = useState(0);
  const [showPicker, setShowPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const iconColor = useMeadowColor('ink3');

  useEffect(() => {
    if (visible) {
      setMeasureKind(initialKind);
      setValue('');
      setWhen(new Date());
      setActivePreset(0);
      setShowPicker(false);
      setError(null);
      setSaving(false);
    }
  }, [visible, initialKind]);

  const pickPreset = (daysAgo: number) => {
    setWhen(daysAgoDate(daysAgo));
    setActivePreset(daysAgo);
    setShowPicker(false);
  };

  const onPickerChange = (event: DateTimePickerEvent, picked?: Date) => {
    if (Platform.OS !== 'ios') setShowPicker(false);
    if (event.type === 'set' && picked) {
      setWhen(picked);
      setActivePreset(-1);
    }
  };

  const save = async () => {
    // Compose the metric-only wire body — an imperial entry (lb/in) is converted to
    // metric HERE, before the POST, so storage stays metric (rule #1).
    const composed = composeMeasurementLog({
      entry: value,
      measureKind,
      units,
      childId,
      occurredAt: when.toISOString(),
    });
    if (!composed.ok) {
      setError(
        `Enter a ${MEASURE_LABEL[measureKind].toLowerCase()} (${entryUnit(measureKind, units)}).`,
      );
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await api('/api/mobile/companion/log', {
        method: 'POST',
        body: JSON.stringify(composed.body),
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
    <Sheet visible={visible} onClose={onClose} title="Add a measurement">
      <View className="mb-5 gap-2">
        <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
          What
        </AppText>
        <View className="flex-row gap-2">
          {MEASURE_KINDS.map((k) => {
            const active = k === measureKind;
            return (
              <Pressable
                key={k}
                accessibilityRole="button"
                accessibilityLabel={MEASURE_LABEL[k]}
                accessibilityState={active ? { selected: true } : {}}
                onPress={() => setMeasureKind(k)}
                className={`h-11 flex-1 items-center justify-center rounded-full border ${
                  active ? 'border-ink bg-ink' : 'border-rule bg-card'
                }`}
              >
                <AppText variant="meta" className={active ? 'text-on-ink' : 'text-ink-2'}>
                  {MEASURE_LABEL[k]}
                </AppText>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View className="mb-5">
        <Field
          label={`Value (${entryUnit(measureKind, units)})`}
          value={value}
          onChangeText={setValue}
          keyboardType="numeric"
          placeholder={entryPlaceholder(measureKind, units)}
          autoCapitalize="none"
          autoFocus
        />
      </View>

      <View className="mb-5 gap-2">
        <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
          When
        </AppText>
        <View className="flex-row gap-2">
          {WHEN_PRESETS.map((preset) => {
            const active = preset.daysAgo === activePreset;
            return (
              <Pressable
                key={preset.label}
                accessibilityRole="button"
                accessibilityLabel={`When: ${preset.label}`}
                accessibilityState={active ? { selected: true } : {}}
                onPress={() => pickPreset(preset.daysAgo)}
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

        {/* The exact date picker is a native module (no web impl), so on the RN-web
            preview we show the resolved date read-only; presets still set it. */}
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
              accessibilityLabel={`Exact date: ${whenLabel(when)}. Tap to change.`}
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
              <Icon name={showPicker ? 'chevron-up' : 'chevron-down'} size={13} color={iconColor} />
            </Pressable>

            {showPicker ? (
              <View className="items-center">
                <DateTimePicker
                  value={when}
                  mode="date"
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

      <Button label={saving ? 'Saving…' : 'Save measurement'} onPress={save} disabled={saving} />

      <AppText variant="meta" className="mt-4 text-center text-ink-3">
        A plain record of your child's growth — no percentiles or comparisons. Confirm any concern
        with your provider.
      </AppText>
    </Sheet>
  );
}
