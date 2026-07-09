import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { useEffect, useState } from 'react';
import { Switch, View } from 'react-native';

import { ConnectorsList, ConnectorsPrivacyNote } from '@/components/hale/connectors-list';
import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useTintedRefresh } from '@/components/ui/pull-refresh';
import { Screen } from '@/components/ui/screen';
import { ScreenHeader } from '@/components/ui/screen-header';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { useMeadowColor } from '@/constants/meadow';
import { ApiError } from '@/lib/api-client';
import type {
  MobileIntegrationsResponse,
  MobilePushPrefsResponse,
  MobileSettingsResponse,
  PushPref,
} from '@/lib/api-types';
import { updatePushPref, updateSettings } from '@/lib/family-api';
import { useApi } from '@/lib/use-api';

function SectionTitle({ children }: { children: string }) {
  return (
    <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
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
  const trackOn = useMeadowColor('accentFill');
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
      {granted === false ? (
        <AppText variant="meta" className="text-ink-3">
          Push notifications are turned off for Hale on this device. Turn them on in your phone's
          Settings to receive these.
        </AppText>
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

function SettingsBody({
  email,
  push,
}: {
  email: MobileSettingsResponse;
  push: MobilePushPrefsResponse | null;
}) {
  return (
    <>
      <NotificationsSection email={email} push={push} />

      <ConnectedAccountsSection />

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

      <View className="gap-2">
        <SectionTitle>About</SectionTitle>
        <Card>
          <InfoRow title="Village Hale" detail={`Version ${Constants.expoConfig?.version ?? '—'}`} />
        </Card>
      </View>
    </>
  );
}

export default function SettingsScreen() {
  const email = useApi<MobileSettingsResponse>('/api/mobile/settings');
  const push = useApi<MobilePushPrefsResponse>('/api/mobile/settings/notifications');

  return (
    <Screen scroll className="gap-6" refreshControl={useTintedRefresh(email.refreshing, email.refresh)}>
      <ScreenHeader title="Settings" back />
      {email.status === 'loading' ? <LoadingState /> : null}
      {email.status === 'error' ? <ErrorState message={email.error ?? ''} onRetry={email.reload} /> : null}
      {email.status === 'ready' && email.data ? (
        <SettingsBody email={email.data} push={push.status === 'ready' ? push.data : null} />
      ) : null}
    </Screen>
  );
}
