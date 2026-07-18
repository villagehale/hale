import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { useTintedRefresh } from '@/components/ui/pull-refresh';
import { Screen } from '@/components/ui/screen';
import { ScreenHeader } from '@/components/ui/screen-header';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { Tag } from '@/components/ui/tag';
import { ApiError, api } from '@/lib/api-client';
import type { MobileSavedResponse, VillageCandidateView } from '@/lib/api-types';
import { foundStamp } from '@/lib/format';
import { useApi } from '@/lib/use-api';

/** The locked (teen-redacted) saved card, with a Remove control. Unsaving posts the
 * SAME toggle route the detail sheet uses; the save row carries no content, so the
 * request never touches redacted fields (rule #1). On success the list refreshes and
 * the row drops out. */
function TeenSavedCard({
  rec,
  onRefresh,
}: {
  rec: VillageCandidateView;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onRemove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(rec.saveHref, { method: 'POST' });
      onRefresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError('Could not remove — try again.');
      setBusy(false);
    }
  };

  return (
    <Card className="gap-2">
      <View className="flex-row items-start justify-between gap-3">
        <Tag label="Redacted · teen privacy" tone="attention" />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Remove from saved"
          onPress={onRemove}
          disabled={busy}
          className="active:opacity-70"
        >
          <AppText variant="meta" className={busy ? 'text-ink-3' : 'text-berry'}>
            {busy ? 'Removing…' : 'Remove'}
          </AppText>
        </Pressable>
      </View>
      <AppText variant="meta">
        Category: {rec.kind}. Raw content is hidden by default to protect a teen's privacy.
      </AppText>
      {error ? (
        <AppText variant="meta" className="text-berry" accessibilityLiveRegion="polite">
          {error}
        </AppText>
      ) : null}
    </Card>
  );
}

/** One saved activity — opens the shared Village detail sheet (accept / endorse /
 * unsave / share / register). A teen-redacted saved card shows category only, no
 * content, and can't open a detail (rule #1) — matches the feed's RecCard. It still
 * gets a Remove control: the save row is content-free, so a candidate saved before
 * a child turned 13 (now locked, and Saved ignores supersededAt) can still be
 * cleared out — otherwise it's stuck in the list forever. */
function SavedCard({
  rec,
  onOpen,
  onRefresh,
}: {
  rec: VillageCandidateView;
  onOpen: (rec: VillageCandidateView) => void;
  onRefresh: () => void;
}) {
  if (rec.teenAttributed) {
    return <TeenSavedCard rec={rec} onRefresh={onRefresh} />;
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${rec.title}`}
      onPress={() => onOpen(rec)}
      className="active:opacity-80"
    >
      <Card className="gap-2">
        <View className="flex-row items-start justify-between gap-3">
          <AppText variant="title" className="flex-1">
            {rec.title}
          </AppText>
          <Tag label={rec.kind} tone="coach" />
        </View>
        <AppText variant="meta" className="text-ink-3">
          {foundStamp(rec.discoveredAt)}
        </AppText>
        <AppText variant="body">{rec.summary}</AppText>
      </Card>
    </Pressable>
  );
}

function SavedBody({
  data,
  onRefresh,
}: {
  data: MobileSavedResponse;
  onRefresh: () => void;
}) {
  const { candidates } = data;

  if (candidates.length === 0) {
    return (
      <Card className="mt-2 items-center gap-2 py-10">
        <AppText variant="title">Nothing saved yet</AppText>
        <AppText variant="meta" className="text-center">
          Tap the bookmark on any activity in Village to keep it here. Saving is private — it's
          not enrolled or sent for approval.
        </AppText>
      </Card>
    );
  }

  return (
    <View className="gap-3">
      {candidates.map((rec) => (
        <SavedCard
          key={rec.id}
          rec={rec}
          onOpen={(r) => router.push(`/activity/${r.id}`)}
          onRefresh={onRefresh}
        />
      ))}
    </View>
  );
}

export default function SavedScreen() {
  const { status, data, error, refreshing, reload, refresh } =
    useApi<MobileSavedResponse>('/api/mobile/village/saved', { refetchOnFocus: true });

  return (
    <Screen scroll className="gap-5" refreshControl={useTintedRefresh(refreshing, refresh)}>
      <ScreenHeader title="Saved" back />
      <AppText variant="meta" className="-mt-2">
        Activities you saved for later — private to you, never enrolled or sent for approval.
      </AppText>
      {status === 'loading' ? <LoadingState /> : null}
      {status === 'error' ? <ErrorState message={error ?? ''} onRetry={reload} /> : null}
      {status === 'ready' && data ? <SavedBody data={data} onRefresh={refresh} /> : null}
    </Screen>
  );
}
