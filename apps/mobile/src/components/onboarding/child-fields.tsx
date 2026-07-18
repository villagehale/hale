import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Platform, Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Icon } from '@/components/ui/icon';
import { IconButton } from '@/components/ui/icon-button';
import { useMeadowColor } from '@/constants/meadow';
import type { DraftChild } from '@/lib/onboarding-draft';

/**
 * The name + date-of-birth inputs for one child — extracted from the old single
 * intake so the two split screens (first child, then "anyone else?") reuse the
 * exact same picker logic and the draft stays consistent between them. DOB is
 * stored/sent as `YYYY-MM-DD` and parsed as a LOCAL date (not UTC, which would
 * shift the day in negative-offset zones), mirroring the Family screen.
 */

export function parseDob(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}
export function toDobString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
export function dobLabel(value: string): string {
  return parseDob(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function ChildFields({
  child,
  onChange,
  onRemove,
  removable,
}: {
  child: DraftChild;
  onChange: (next: DraftChild) => void;
  onRemove?: () => void;
  removable?: boolean;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const iconColor = useMeadowColor('ink3');

  const onPickerChange = (event: DateTimePickerEvent, picked?: Date) => {
    if (Platform.OS !== 'ios') setShowPicker(false);
    if (event.type === 'set' && picked) onChange({ ...child, dateOfBirth: toDobString(picked) });
  };

  return (
    <Card className="gap-4">
      <View className="flex-row items-start gap-3">
        <View className="flex-1">
          <Field
            label="First name"
            value={child.name}
            onChangeText={(name) => onChange({ ...child, name })}
            placeholder="Sebastian"
            autoCapitalize="words"
          />
        </View>
        {removable && onRemove ? (
          <View className="pt-6">
            <IconButton icon="trash-2" accessibilityLabel="Remove this child" onPress={onRemove} />
          </View>
        ) : null}
      </View>

      <View className="gap-1.5">
        <AppText variant="meta" className="text-ink-2">
          Date of birth
        </AppText>
        {/* The date picker is a native module (no web impl), so on the RN-web preview
            we show the resolved date read-only — mirroring the Family screen. */}
        {Platform.OS === 'web' ? (
          <View className="min-h-11 justify-center rounded-md border border-rule bg-canvas px-4 py-3">
            <AppText variant="body" className="text-ink">
              {child.dateOfBirth ? dobLabel(child.dateOfBirth) : 'Not set'}
            </AppText>
          </View>
        ) : (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                child.dateOfBirth
                  ? `Date of birth: ${dobLabel(child.dateOfBirth)}. Tap to change.`
                  : 'Set date of birth'
              }
              accessibilityState={{ expanded: showPicker }}
              onPress={() => setShowPicker((s) => !s)}
              className="min-h-11 flex-row items-center justify-between rounded-md border border-rule bg-canvas px-4 py-3 active:opacity-80"
            >
              <AppText variant="body" className={child.dateOfBirth ? 'text-ink' : 'text-ink-3'}>
                {child.dateOfBirth ? dobLabel(child.dateOfBirth) : 'Tap to choose'}
              </AppText>
              <Icon name={showPicker ? 'chevron-up' : 'chevron-down'} size={13} color={iconColor} />
            </Pressable>
            {showPicker ? (
              <View className="items-center">
                <DateTimePicker
                  value={child.dateOfBirth ? parseDob(child.dateOfBirth) : new Date()}
                  mode="date"
                  display={Platform.OS === 'ios' ? 'inline' : 'default'}
                  maximumDate={new Date()}
                  onChange={onPickerChange}
                />
              </View>
            ) : null}
          </>
        )}
        <AppText variant="meta">Birthday sets the stage Hale tailors to.</AppText>
      </View>
    </Card>
  );
}
