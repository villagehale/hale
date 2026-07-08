import Constants from 'expo-constants';
import { useState } from 'react';
import { Switch, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { useTintedRefresh } from '@/components/ui/pull-refresh';
import { Screen } from '@/components/ui/screen';
import { ScreenHeader } from '@/components/ui/screen-header';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { useMeadowColor } from '@/constants/meadow';
import { ApiError } from '@/lib/api-client';
import type { MobileSettingsResponse } from '@/lib/api-types';
import { updateSettings } from '@/lib/family-api';
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

/**
 * The one notification stream a parent controls today: the daily brief email. It
 * persists as the absence of a CASL opt-out (email_opt_outs) via the shared web
 * lib — the same source of truth the digest send path checks. Optimistic: flip the
 * switch, POST, and revert on failure so the control never lies about server state.
 */
function DailyBriefToggle({ initial }: { initial: boolean }) {
  const [on, setOn] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trackOn = useMeadowColor('accentFill');

  async function toggle(next: boolean) {
    setOn(next);
    setSaving(true);
    setError(null);
    try {
      await updateSettings({ pref: 'dailyBriefEmail', enabled: next });
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

  return (
    <Card className="gap-3">
      <View className="flex-row items-center justify-between gap-4">
        <View className="flex-1">
          <AppText variant="body" className="text-ink">
            Daily brief email
          </AppText>
          <AppText variant="meta">
            A once-a-day recap of what Hale handled. Account and security emails are unaffected.
          </AppText>
        </View>
        <Switch
          value={on}
          onValueChange={toggle}
          disabled={saving}
          trackColor={{ true: trackOn }}
          accessibilityLabel="Daily brief email"
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

function SettingsBody({ data }: { data: MobileSettingsResponse }) {
  return (
    <>
      <View className="gap-2">
        <SectionTitle>Notifications</SectionTitle>
        <DailyBriefToggle initial={data.notifications.dailyBriefEmail} />
      </View>

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
  const { status, data, error, refreshing, reload, refresh } =
    useApi<MobileSettingsResponse>('/api/mobile/settings');

  return (
    <Screen scroll className="gap-6" refreshControl={useTintedRefresh(refreshing, refresh)}>
      <ScreenHeader title="Settings" back />
      {status === 'loading' ? <LoadingState /> : null}
      {status === 'error' ? <ErrorState message={error ?? ''} onRetry={reload} /> : null}
      {status === 'ready' && data ? <SettingsBody data={data} /> : null}
    </Screen>
  );
}
