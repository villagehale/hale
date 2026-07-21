import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Platform, Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { useMeadowColor } from '@/constants/meadow';
import { ApiError } from '@/lib/api-client';
import type { LoopChannel, LoopPrefField, MobileLoopPrefsResponse } from '@/lib/api-types';
import { updateLoopPref } from '@/lib/family-api';
import { dateToTimeValue, timeStringToDate, timeStringToLabel } from '@/lib/loop-time';
import { useApi } from '@/lib/use-api';

/**
 * The Settings "Sunday Loop" section — the F11 delivery preferences the app mirrors
 * (VIL-216 · A5): how the loop reaches you, quiet hours, and the weekly-plan send
 * time. Each write PATCHes /api/mobile/settings/loop, which validates the field,
 * resolves the family, and audits the change (rules #1/#6) — the app only gathers
 * the intent. The category toggles + child-name level stay web-only for now.
 *
 * Honesty: the channel is display-only until SMS ships — Email is the arrival
 * channel today and Text is a disabled, labelled "coming soon", never a dead toggle.
 */

/** One optimistic time field: show the picked time at once, PATCH it, and revert on
 * failure so the row never lies about server state. Mirrors the settings screen's
 * useOptimisticToggle, for an 'HH:MM' string. */
function useOptimisticTime(initial: string, field: LoopPrefField) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function commit(next: string) {
    const previous = value;
    setValue(next);
    setSaving(true);
    setError(null);
    try {
      await updateLoopPref({ field, value: next });
    } catch (e) {
      setValue(previous);
      setError(
        e instanceof ApiError && e.message === 'preview'
          ? "Sign-in isn't configured in this preview, so nothing was saved."
          : "Couldn't save just now — please try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  return { value, saving, error, commit };
}

/** A tap-to-reveal native time picker row, matching the family screen's date-picker
 * idiom (a bordered pill that expands an inline picker). On the RN-web preview the
 * native module has no impl, so the resolved time is shown read-only. */
function TimeRow({ label, field, initial }: { label: string; field: LoopPrefField; initial: string }) {
  const { value, saving, error, commit } = useOptimisticTime(initial, field);
  const [open, setOpen] = useState(false);
  const iconColor = useMeadowColor('ink3');
  const display = timeStringToLabel(value);

  // Android closes its own dialog and fires 'set' or 'dismissed'; iOS keeps the
  // inline picker open until the parent hides it, so only Android toggles here.
  const onChange = (event: DateTimePickerEvent, picked?: Date) => {
    if (Platform.OS !== 'ios') setOpen(false);
    if (event.type === 'set' && picked) commit(dateToTimeValue(picked));
  };

  return (
    <View className="gap-1.5">
      <AppText variant="meta" className="text-ink-2">
        {label}
      </AppText>
      {Platform.OS === 'web' ? (
        <View className="min-h-11 justify-center rounded-md border border-rule bg-canvas px-4 py-3">
          <AppText variant="body" className="text-ink">
            {display}
          </AppText>
        </View>
      ) : (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${label}: ${display}. Tap to change.`}
            accessibilityState={{ expanded: open }}
            disabled={saving}
            onPress={() => setOpen((s) => !s)}
            className={`min-h-11 flex-row items-center justify-between rounded-md border border-rule bg-canvas px-4 py-3 active:opacity-80 ${saving ? 'opacity-50' : ''}`}
          >
            <AppText variant="body" className="text-ink">
              {display}
            </AppText>
            <Icon name={open ? 'chevron-up' : 'chevron-down'} size={13} color={iconColor} />
          </Pressable>
          {open ? (
            <View className="items-center">
              <DateTimePicker
                value={timeStringToDate(value)}
                mode="time"
                display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                onChange={onChange}
              />
            </View>
          ) : null}
        </>
      )}
      {error ? (
        <AppText variant="meta" className="text-accent" accessibilityRole="alert">
          {error}
        </AppText>
      ) : null}
    </View>
  );
}

/** One channel pill — the app's active/outlined idiom. Non-interactive: the channel
 * is display-only on mobile today (Email is fixed until SMS ships), so these show
 * state rather than pretending to switch it. */
function ChannelPill({ label, active, disabled }: { label: string; active: boolean; disabled?: boolean }) {
  return (
    <View
      className={`h-11 flex-1 items-center justify-center rounded-full border ${
        active ? 'border-ink bg-ink' : 'border-rule bg-card'
      } ${disabled ? 'opacity-50' : ''}`}
    >
      <AppText variant="meta" className={active ? 'text-on-ink' : 'text-ink-2'}>
        {label}
      </AppText>
    </View>
  );
}

/** How the loop arrives. Email is today's only channel; Text is disabled with an
 * honest "coming soon" note (no dead toggle) until SMS launches (rule #1 honesty). */
function LoopChannelRow({ channel }: { channel: LoopChannel }) {
  return (
    <View className="gap-2">
      <View>
        <AppText variant="body" className="text-ink">
          How your loop reaches you
        </AppText>
        <AppText variant="meta">Where Hale sends your weekly plan and nudges.</AppText>
      </View>
      <View className="flex-row gap-2">
        <ChannelPill label="Email" active={channel === 'email'} />
        <ChannelPill label="Text" active={channel === 'sms'} disabled />
      </View>
      <AppText variant="meta" className="text-ink-3">
        Text arrives when SMS launches.
      </AppText>
    </View>
  );
}

function LoopBody({ loop }: { loop: MobileLoopPrefsResponse['loop'] }) {
  return (
    <Card className="gap-5">
      <LoopChannelRow channel={loop.loopChannel} />
      <View className="gap-3 border-t border-rule pt-5">
        <View>
          <AppText variant="body" className="text-ink">
            Quiet hours
          </AppText>
          <AppText variant="meta">Hale saves non-urgent messages for later during these hours.</AppText>
        </View>
        <TimeRow label="From" field="quietHoursStart" initial={loop.quietHoursStart} />
        <TimeRow label="To" field="quietHoursEnd" initial={loop.quietHoursEnd} />
      </View>
      <View className="gap-3 border-t border-rule pt-5">
        <View>
          <AppText variant="body" className="text-ink">
            Weekly plan
          </AppText>
          <AppText variant="meta">The time your Sunday Loop plan arrives each week.</AppText>
        </View>
        <TimeRow label="Sends at" field="weeklyPlanSendTime" initial={loop.weeklyPlanSendTime} />
      </View>
    </Card>
  );
}

/**
 * The section reads its own endpoint so it refreshes independently. It stays hidden
 * until the read resolves (a preference must be honest — we never render a control
 * before we know its real value, rule #1); a transient failure keeps the heading and
 * offers a retry rather than silently dropping the section.
 */
export function LoopSection() {
  const loop = useApi<MobileLoopPrefsResponse>('/api/mobile/settings/loop');
  if (loop.status === 'error') {
    return (
      <View className="gap-2">
        <AppText variant="eyebrow">Sunday Loop</AppText>
        <Card className="gap-3">
          <AppText variant="meta" className="text-ink-3">
            Couldn't load your loop preferences.
          </AppText>
          <Button label="Try again" variant="secondary" onPress={loop.reload} />
        </Card>
      </View>
    );
  }
  if (loop.status !== 'ready' || !loop.data) return null;
  return (
    <View className="gap-2">
      <AppText variant="eyebrow">Sunday Loop</AppText>
      <LoopBody loop={loop.data.loop} />
    </View>
  );
}
