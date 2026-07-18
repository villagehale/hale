import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { useTintedRefresh } from '@/components/ui/pull-refresh';
import { Screen } from '@/components/ui/screen';
import { ScreenHeader } from '@/components/ui/screen-header';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { Tag } from '@/components/ui/tag';
import { TintChip } from '@/components/ui/tint-chip';
import { useMeadowColor } from '@/constants/meadow';
import { ApiError, api } from '@/lib/api-client';
import type { MobileSavedResponse, VillageCandidateView } from '@/lib/api-types';
import { foundStamp } from '@/lib/format';
import { useApi } from '@/lib/use-api';

/** The locked (teen-redacted) saved row, with a Remove control. Unsaving posts the
 * SAME toggle route the detail sheet uses; the save row carries no content, so the
 * request never touches redacted fields (rule #1). On success the list refreshes and
 * the row drops out. The row itself never navigates — a teen-redacted candidate has no
 * openable detail (rule #1), so only the Remove affordance is interactive. */
function TeenSavedRow({
  rec,
  last,
  onRefresh,
}: {
  rec: VillageCandidateView;
  last: boolean;
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
    <View
      className={`flex-row items-start gap-3 px-4 py-3.5 ${last ? '' : 'border-b border-hairline'}`}
    >
      <TintChip icon="shield" tone="gray" />
      <View className="flex-1 gap-1">
        <Tag label="Redacted · teen privacy" tone="attention" />
        <AppText variant="meta" className="text-caption">
          Category: {rec.kind}. Raw content is hidden by default to protect a teen&rsquo;s privacy.
        </AppText>
        {error ? (
          <AppText variant="meta" className="text-berry" accessibilityLiveRegion="polite">
            {error}
          </AppText>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Remove from saved"
        onPress={onRemove}
        disabled={busy}
        hitSlop={6}
        className="active:opacity-70"
      >
        <AppText variant="meta" className={busy ? 'text-ink-3' : 'text-berry'}>
          {busy ? 'Removing…' : 'Remove'}
        </AppText>
      </Pressable>
    </View>
  );
}

/** One saved activity — a compact row (icon chip · title · "{kind} · found …" · a
 * saved bookmark) that opens the shared Village detail sheet on tap. A teen-redacted
 * candidate renders the locked row instead: category only, no title/summary, no
 * navigation (rule #1) — the same split the Village feed's RecCard uses. */
function SavedRow({
  rec,
  last,
  onOpen,
  onRefresh,
}: {
  rec: VillageCandidateView;
  last: boolean;
  onOpen: (rec: VillageCandidateView) => void;
  onRefresh: () => void;
}) {
  const saved = useMeadowColor('brand');
  const stamp = foundStamp(rec.discoveredAt);

  if (rec.teenAttributed) {
    return <TeenSavedRow rec={rec} last={last} onRefresh={onRefresh} />;
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${rec.title}`}
      onPress={() => onOpen(rec)}
      className={`flex-row items-center gap-3 px-4 py-3.5 active:opacity-80 ${
        last ? '' : 'border-b border-hairline'
      }`}
    >
      <TintChip icon="map-pin" tone="yellow" />
      <View className="flex-1">
        <AppText
          numberOfLines={1}
          className="text-[14px] text-ink"
          style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
        >
          {rec.title}
        </AppText>
        <AppText variant="meta" className="text-caption">
          {stamp ? `${rec.kind} · ${stamp}` : rec.kind}
        </AppText>
      </View>
      <Icon name="bookmark-check" size={17} color={saved} />
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
          Tap the bookmark on any activity in Village to keep it here. Saving is private — it&rsquo;s
          not enrolled or sent for approval.
        </AppText>
      </Card>
    );
  }

  return (
    <View className="overflow-hidden rounded-[20px] border border-rule bg-card">
      {candidates.map((rec, i) => (
        <SavedRow
          key={rec.id}
          rec={rec}
          last={i === candidates.length - 1}
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
