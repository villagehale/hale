import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Pressable, Switch, View } from 'react-native';

import { ConnectorsList, ConnectorsPrivacyNote } from '@/components/hale/connectors-list';
import { LoopSection } from '@/components/hale/loop-section';
import { PrivacyDataSection } from '@/components/hale/privacy-data-section';
import { TextNotificationsSection } from '@/components/hale/text-notifications-section';
import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DetailHeader } from '@/components/ui/detail-header';
import { Icon } from '@/components/ui/icon';
import { useTintedRefresh } from '@/components/ui/pull-refresh';
import { Screen } from '@/components/ui/screen';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { useMeadowColor } from '@/constants/meadow';
import { ApiError } from '@/lib/api-client';
import type {
  MobileIntegrationsResponse,
  MobilePreferencesResponse,
  MobilePushPrefsResponse,
  MobileSettingsResponse,
  PushPref,
  UnitSystem,
} from '@/lib/api-types';
import { updatePreferences, updatePushPref, updateSettings } from '@/lib/family-api';
import {
  currentOsPermission,
  registerPushToken,
  requestOsPermission,
} from '@/lib/push-registration';
import { useApi } from '@/lib/use-api';

function SectionTitle({ children }: { children: string }) {
  return (
    <AppText variant="eyebrow">
      {children}
    </AppText>
  );
}

function InfoRow({ title, detail }: { title: string; detail: string }) {
  return (
    <View className="gap-1">
      <AppText variant="body" className="text-ink">
        {title}
      </AppText>
      <AppText variant="meta">{detail}</AppText>
    </View>
  );
}

/** Whether this device has granted notification permission, once resolved. Undefined
 * while checking (and on web/simulator, where the note doesn't apply). Drives the
 * muted "turn on notifications in Settings" hint below the push toggles. */
function useDevicePushGranted(): boolean | undefined {
  const [granted, setGranted] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    Notifications.getPermissionsAsync()
      .then((p) => {
        if (!cancelled) setGranted(p.status === 'granted');
      })
      .catch(() => {
        // The permission probe is best-effort; a failure just hides the hint.
        if (!cancelled) setGranted(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return granted;
}

/** One optimistic toggle: flip, persist, and revert on failure so the control never
 * lies about server state. Shared by the email + the two push streams. */
function useOptimisticToggle(initial: boolean, persist: (next: boolean) => Promise<void>) {
  const [on, setOn] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(next: boolean) {
    setOn(next);
    setSaving(true);
    setError(null);
    try {
      await persist(next);
    } catch (e) {
      setOn(!next);
      setError(
        e instanceof ApiError && e.message === 'preview'
          ? "Sign-in isn't configured in this preview, so nothing was saved."
          : "Couldn't save just now — please try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  return { on, saving, error, toggle };
}

/** A two-option segmented control matching the app's pill idiom (the growth sheet /
 * plan ScopePicker): the active option is an ink fill, the rest outlined. Read-only
 * label + a value chosen by tapping one of exactly two options. */
function SegmentedRow<T extends string | number>({
  title,
  detail,
  value,
  options,
  disabled,
  onChange,
}: {
  title: string;
  detail: string;
  value: T;
  options: { value: T; label: string }[];
  disabled: boolean;
  onChange: (next: T) => void;
}) {
  return (
    <View className="flex-1 gap-2">
      <View>
        <AppText variant="body" className="text-ink">
          {title}
        </AppText>
        <AppText variant="meta">{detail}</AppText>
      </View>
      <View className="flex-row gap-2">
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <Pressable
              key={String(opt.value)}
              accessibilityRole="button"
              accessibilityLabel={`${title}: ${opt.label}`}
              accessibilityState={active ? { selected: true } : {}}
              disabled={disabled}
              onPress={() => onChange(opt.value)}
              className={`h-11 flex-1 items-center justify-center rounded-full border ${
                active ? 'border-ink bg-ink' : 'border-rule bg-card'
              } ${disabled ? 'opacity-50' : 'active:opacity-80'}`}
            >
              <AppText variant="meta" className={active ? 'text-on-ink' : 'text-ink-2'}>
                {opt.label}
              </AppText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function ToggleRow({
  title,
  detail,
  value,
  saving,
  error,
  onValueChange,
}: {
  title: string;
  detail: string;
  value: boolean;
  saving: boolean;
  error: string | null;
  onValueChange: (next: boolean) => void;
}) {
  // The "on" track is brand navy — the prototype's switch colour and the app's
  // committed primary for a selected/active state (apricot stays scarce; DESIGN.md).
  const trackOn = useMeadowColor('brand');
  return (
    <Card className="gap-3">
      <View className="flex-row items-center justify-between gap-4">
        <View className="flex-1">
          <AppText variant="body" className="text-ink">
            {title}
          </AppText>
          <AppText variant="meta">{detail}</AppText>
        </View>
        <Switch
          value={value}
          onValueChange={onValueChange}
          disabled={saving}
          trackColor={{ true: trackOn }}
          accessibilityLabel={title}
        />
      </View>
      {error ? (
        <AppText variant="meta" className="text-accent" accessibilityRole="alert">
          {error}
        </AppText>
      ) : null}
    </Card>
  );
}

/**
 * The daily brief EMAIL toggle: persists as the absence of a CASL opt-out
 * (email_opt_outs) via the shared web lib — the same source of truth the digest
 * send path checks.
 */
function DailyBriefToggle({ initial }: { initial: boolean }) {
  const { on, saving, error, toggle } = useOptimisticToggle(initial, (next) =>
    updateSettings({ pref: 'dailyBriefEmail', enabled: next }),
  );
  return (
    <ToggleRow
      title="Daily brief email"
      detail="A once-a-day recap of what Hale handled. Account and security emails are unaffected."
      value={on}
      saving={saving}
      error={error}
      onValueChange={toggle}
    />
  );
}

/**
 * One PUSH stream toggle (new picks / health reminders). Persists via the
 * notifications route → notification_prefs (default on; a toggle upserts the row).
 */
function PushToggle({
  pref,
  title,
  detail,
  initial,
}: {
  pref: PushPref;
  title: string;
  detail: string;
  initial: boolean;
}) {
  const { on, saving, error, toggle } = useOptimisticToggle(initial, (next) =>
    updatePushPref({ pref, enabled: next }),
  );
  return (
    <ToggleRow
      title={title}
      detail={detail}
      value={on}
      saving={saving}
      error={error}
      onValueChange={toggle}
    />
  );
}

function NotificationsSection({
  email,
  push,
}: {
  email: MobileSettingsResponse;
  push: MobilePushPrefsResponse | null;
}) {
  const granted = useDevicePushGranted();
  const [busy, setBusy] = useState(false);
  const [justEnabled, setJustEnabled] = useState(false);

  // The "enable later" path: prompt when the OS is still undetermined, else hand off to
  // the phone's Settings (a denied permission can't be re-prompted in-app).
  const enablePush = async () => {
    setBusy(true);
    try {
      const os = await currentOsPermission();
      if (os === 'granted') {
        await registerPushToken();
        setJustEnabled(true);
        return;
      }
      if (os === 'undetermined') {
        const next = await requestOsPermission();
        if (next === 'granted') {
          await registerPushToken();
          setJustEnabled(true);
        }
        return;
      }
      await Linking.openSettings();
    } finally {
      setBusy(false);
    }
  };

  return (
    <View className="gap-2">
      <SectionTitle>Notifications</SectionTitle>
      <DailyBriefToggle initial={email.notifications.dailyBriefEmail} />
      {push ? (
        <>
          <PushToggle
            pref="pushNewPicks"
            title="New activities near you"
            detail="A heads-up when your village finds new things to do nearby."
            initial={push.notifications.pushNewPicks}
          />
          <PushToggle
            pref="pushHealthReminders"
            title="Health reminders"
            detail="A nudge when a child's check-up or immunization is coming up."
            initial={push.notifications.pushHealthReminders}
          />
        </>
      ) : null}
      {granted === false && !justEnabled ? (
        <View className="gap-2 pt-1">
          <AppText variant="meta" className="text-ink-3">
            Push notifications are off for Hale on this device.
          </AppText>
          <Button
            label="Turn on notifications"
            variant="secondary"
            onPress={enablePush}
            disabled={busy}
          />
        </View>
      ) : null}
    </View>
  );
}

/**
 * The "Connected accounts" section: the three read-only Google connectors, each with
 * its live status and a Connect/Disconnect affordance. Reads its own endpoint so the
 * section refreshes independently after a connect returns from the browser. The
 * section is hidden until the read resolves (a connector's status must be honest —
 * we never render a row before we know it, rule #1).
 */
function ConnectedAccountsSection() {
  const integrations = useApi<MobileIntegrationsResponse>('/api/mobile/integrations');
  if (integrations.status === 'error') {
    // A transient read failure must not silently drop the section (a vanished
    // section reads as "no such feature"): keep the heading + offer a retry.
    return (
      <View className="gap-3">
        <SectionTitle>Connected accounts</SectionTitle>
        <Card className="gap-3">
          <AppText variant="meta" className="text-ink-3">
            Couldn't load your connected accounts.
          </AppText>
          <Button label="Try again" variant="secondary" onPress={integrations.reload} />
        </Card>
      </View>
    );
  }
  if (integrations.status !== 'ready' || !integrations.data) return null;
  return (
    <View className="gap-3">
      <SectionTitle>Connected accounts</SectionTitle>
      <Card className="gap-5">
        <ConnectorsList connectors={integrations.data.connectors} onRefresh={integrations.refresh} />
        <View className="border-t border-rule pt-4">
          <ConnectorsPrivacyNote />
        </View>
      </Card>
    </View>
  );
}

/**
 * The display-preferences section: Units (metric/imperial) and First day of week
 * (Monday/Sunday). Both write together to /api/mobile/preferences (the route takes
 * the pair), which delegates to the SAME shared web action — the audit row (rule
 * #6) is single-sourced. Optimistic: the tapped value shows at once and reverts on
 * a failed persist, mirroring the notification toggles.
 */
function PreferencesSection({ initial }: { initial: MobilePreferencesResponse }) {
  const [prefs, setPrefs] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function persist(next: MobilePreferencesResponse) {
    const previous = prefs;
    setPrefs(next);
    setSaving(true);
    setError(null);
    try {
      await updatePreferences(next);
    } catch (e) {
      setPrefs(previous);
      setError(
        e instanceof ApiError && e.message === 'preview'
          ? "Sign-in isn't configured in this preview, so nothing was saved."
          : "Couldn't save just now — please try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <View className="gap-2">
      <SectionTitle>Preferences</SectionTitle>
      <Card className="gap-5">
        <SegmentedRow<UnitSystem>
          title="Units"
          detail="How weights and lengths are shown. Your data is always stored the same way."
          value={prefs.units}
          options={[
            { value: 'metric', label: 'Metric' },
            { value: 'imperial', label: 'Imperial' },
          ]}
          disabled={saving}
          onChange={(units) => persist({ ...prefs, units })}
        />
        <View className="border-t border-rule pt-5">
          <SegmentedRow<number>
            title="First day of week"
            detail="Which day the weekly plan starts on."
            value={prefs.weekStartDay}
            options={[
              { value: 1, label: 'Monday' },
              { value: 0, label: 'Sunday' },
            ]}
            disabled={saving}
            onChange={(weekStartDay) => persist({ ...prefs, weekStartDay })}
          />
        </View>
        {error ? (
          <AppText variant="meta" className="text-accent" accessibilityRole="alert">
            {error}
          </AppText>
        ) : null}
      </Card>
    </View>
  );
}

/** One chevron row in the "Other" card (Help & support / About Hale). */
function OtherRow({ label, onPress, last }: { label: string; onPress: () => void; last?: boolean }) {
  const chevron = useMeadowColor('ink3');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className={`flex-row items-center gap-3 px-4 py-3.5 active:opacity-80 ${last ? '' : 'border-b border-hairline'}`}
    >
      <AppText className="flex-1 text-[14px] text-ink" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
        {label}
      </AppText>
      <Icon name="chevron-right" size={15} color={chevron} />
    </Pressable>
  );
}

/** The prototype's "Other" section — routes to the Help & support and About Hale
 * pages (the app version now lives on the About page, not inline here). */
function OtherSection() {
  return (
    <View className="gap-2">
      <SectionTitle>Other</SectionTitle>
      <Card className="gap-0 p-0">
        <OtherRow label="Help & support" onPress={() => router.push('/help')} />
        <OtherRow label="About Hale" onPress={() => router.push('/about')} last />
      </Card>
    </View>
  );
}

function SettingsBody({
  email,
  push,
  preferences,
}: {
  email: MobileSettingsResponse;
  push: MobilePushPrefsResponse | null;
  preferences: MobilePreferencesResponse | null;
}) {
  return (
    <>
      <NotificationsSection email={email} push={push} />

      <LoopSection />

      <TextNotificationsSection />

      {preferences ? <PreferencesSection initial={preferences} /> : null}

      <ConnectedAccountsSection />

      <PrivacyDataSection />

      <View className="gap-2">
        <SectionTitle>Privacy</SectionTitle>
        <Card className="gap-4">
          <InfoRow
            title="Teen content is private by default"
            detail="For a child 13+, only a category or summary is surfaced to you — raw content stays private unless you request a logged, time-limited grant."
          />
          <View className="border-t border-rule pt-4">
            <InfoRow
              title="Your data lives in Canada"
              detail="Hale stores your family's data in Canada (PIPEDA / Quebec Law 25). Nothing is shared with a third party unless you connect one."
            />
          </View>
        </Card>
      </View>

      <OtherSection />
    </>
  );
}

export default function SettingsScreen() {
  const email = useApi<MobileSettingsResponse>('/api/mobile/settings');
  const push = useApi<MobilePushPrefsResponse>('/api/mobile/settings/notifications');
  const preferences = useApi<MobilePreferencesResponse>('/api/mobile/preferences');

  return (
    <Screen scroll className="gap-6" refreshControl={useTintedRefresh(email.refreshing, email.refresh)}>
      <DetailHeader title="Settings" />
      {email.status === 'loading' ? <LoadingState /> : null}
      {email.status === 'error' ? <ErrorState message={email.error ?? ''} onRetry={email.reload} /> : null}
      {email.status === 'ready' && email.data ? (
        <SettingsBody
          email={email.data}
          push={push.status === 'ready' ? push.data : null}
          preferences={preferences.status === 'ready' ? preferences.data : null}
        />
      ) : null}
    </Screen>
  );
}
