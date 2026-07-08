import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { useTintedRefresh } from '@/components/ui/pull-refresh';
import { Screen } from '@/components/ui/screen';
import { ScreenHeader } from '@/components/ui/screen-header';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { Tag } from '@/components/ui/tag';
import { useMeadowColor } from '@/constants/meadow';
import type { ApprovalView, MobileApprovalsResponse } from '@/lib/api-types';
import { api, ApiError } from '@/lib/api-client';
import { humanizeActionType, verdictTag } from '@/lib/approval-format';
import { useApi } from '@/lib/use-api';
import { ApprovalPayloadBlock } from '@/components/hale/approval-payload';

function ActionCard({
  action,
  onResolve,
}: {
  action: ApprovalView;
  onResolve: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chevron = useMeadowColor('ink3');

  const act = async (verb: 'approve' | 'decline') => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/actions/${action.id}/${verb}`, { method: 'POST' });
      onResolve(action.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Card className="gap-2">
      {/* The card head opens the full detail page (same fields, same endpoints); the
          inline Approve/Dismiss below stay for a one-tap decision from the list. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${humanizeActionType(action.actionType)} details`}
        onPress={() => router.push(`/more/approval/${action.id}`)}
        className="gap-2 active:opacity-80"
      >
        <View className="flex-row items-start justify-between gap-3">
          <Tag label={verdictTag(action.verdict).label} tone={verdictTag(action.verdict).tone} />
          <View className="flex-row items-center gap-2">
            {action.childLabel ? (
              <AppText variant="mono" className="text-ink-3">
                for {action.childLabel}
              </AppText>
            ) : null}
            <Icon name="chevron.right" size={13} color={chevron} />
          </View>
        </View>

        <AppText variant="title" className="mt-1">
          {humanizeActionType(action.actionType)}
        </AppText>
        <AppText variant="body">{action.preview}</AppText>

        <ApprovalPayloadBlock action={action} />

        <AppText variant="meta">{action.summary}</AppText>
      </Pressable>

      {error ? (
        <AppText variant="meta" className="text-berry" accessibilityLiveRegion="polite">
          {error}
        </AppText>
      ) : null}

      <View className="mt-1 flex-row gap-2">
        <Button
          label={busy ? 'Working…' : 'Approve'}
          onPress={() => act('approve')}
          disabled={busy}
          className="flex-1"
        />
        <Button
          label="Dismiss"
          variant="secondary"
          onPress={() => act('decline')}
          disabled={busy}
          className="flex-1"
        />
      </View>
    </Card>
  );
}

function ApprovalsBody({
  data,
  onResolve,
}: {
  data: MobileApprovalsResponse;
  onResolve: (id: string) => void;
}) {
  const { approvals } = data;
  return (
    <>
      {approvals.length === 0 ? (
        <Card className="mt-2 items-center gap-2 py-10">
          <AppText variant="title">You're all caught up</AppText>
          <AppText variant="meta" className="text-center">
            No actions are waiting. Hale will queue anything that needs your okay here.
          </AppText>
        </Card>
      ) : (
        <View className="gap-3">
          <AppText variant="meta" className="-mt-2">
            {approvals.length} action{approvals.length === 1 ? '' : 's'} waiting for your okay.
            Nothing happens without it.
          </AppText>
          {approvals.map((action) => (
            <ActionCard key={action.id} action={action} onResolve={onResolve} />
          ))}
        </View>
      )}

      <Card raised className="gap-2">
        <Tag label="Autonomy" tone="coach" />
        <AppText variant="title">Fewer taps once you trust it</AppText>
        <AppText variant="body">
          After you approve the same kind of action five times, you can let Hale handle it
          automatically — still logged, still reversible.
        </AppText>
      </Card>
    </>
  );
}

export default function ApprovalsScreen() {
  const { status, data, error, refreshing, reload, refresh } = useApi<MobileApprovalsResponse>(
    '/api/mobile/approvals',
  );
  const [resolved, setResolved] = useState<Set<string>>(new Set());

  const visible = data
    ? { approvals: data.approvals.filter((a) => !resolved.has(a.id)) }
    : null;

  return (
    <Screen scroll className="gap-5" refreshControl={useTintedRefresh(refreshing, refresh)}>
      <ScreenHeader title="Approvals" back />
      {status === 'loading' ? <LoadingState /> : null}
      {status === 'error' ? <ErrorState message={error ?? ''} onRetry={reload} /> : null}
      {status === 'ready' && visible ? (
        <ApprovalsBody
          data={visible}
          onResolve={(id) => setResolved((prev) => new Set(prev).add(id))}
        />
      ) : null}
    </Screen>
  );
}
