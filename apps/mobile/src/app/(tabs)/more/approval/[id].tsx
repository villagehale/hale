import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { ApprovalPayloadBlock } from '@/components/hale/approval-payload';
import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Screen } from '@/components/ui/screen';
import { ScreenHeader } from '@/components/ui/screen-header';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { Tag } from '@/components/ui/tag';
import type { ApprovalView, MobileApprovalsResponse } from '@/lib/api-types';
import { ApiError, api } from '@/lib/api-client';
import { canApproveAction } from '@/lib/approval-gate';
import { humanizeActionType, verdictTag } from '@/lib/approval-format';
import { whenPhrase } from '@/lib/format';
import { useApi } from '@/lib/use-api';

/** A labelled field row for the detail body. */
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="gap-1">
      <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
        {label}
      </AppText>
      <AppText variant="body">{value}</AppText>
    </View>
  );
}

function ApprovalDetailBody({ action }: { action: ApprovalView }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (verb: 'approve' | 'decline') => {
    setBusy(true);
    setError(null);
    try {
      // The SAME endpoints the list uses — the detail is a richer view, not a new path.
      await api(`/api/actions/${action.id}/${verb}`, { method: 'POST' });
      router.back();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const tag = verdictTag(action.verdict);

  return (
    <>
      <Card className="gap-4">
        <View className="flex-row items-start justify-between gap-3">
          <Tag label={tag.label} tone={tag.tone} />
          {action.childLabel ? (
            <AppText variant="mono" className="text-ink-3">
              for {action.childLabel}
            </AppText>
          ) : null}
        </View>

        <AppText variant="title">{humanizeActionType(action.actionType)}</AppText>

        <DetailRow label="What Hale drafted" value={action.preview} />

        {/* Respect teen redaction EXACTLY as the card does: a null payload renders the
            notice only, never the raw fields (rule #1). */}
        <ApprovalPayloadBlock action={action} />

        <DetailRow label="Why" value={action.summary} />
        <DetailRow label="Drafted" value={whenPhrase(action.draftedAt)} />
      </Card>

      {error ? (
        <AppText variant="meta" className="text-berry" accessibilityLiveRegion="polite">
          {error}
        </AppText>
      ) : null}

      <View className="flex-row gap-3">
        {canApproveAction(action) ? (
          <Button
            label={busy ? 'Working…' : 'Approve'}
            onPress={() => act('approve')}
            disabled={busy}
            className="flex-1"
          />
        ) : (
          // Policy 4: never a decision on invisible content. The raw draft is
          // hidden for a 13+ teen (rule #1), so Approve is withheld — the parent
          // can ask their teen for time-limited access (per the redaction notice
          // above) instead. Dismiss stays: declining hidden content is safe.
          <AppText variant="meta" className="flex-1 text-ink-3">
            You can't approve hidden content. Ask your teen for time-limited access, or dismiss.
          </AppText>
        )}
        <Button
          label="Dismiss"
          variant="secondary"
          onPress={() => act('decline')}
          disabled={busy}
          className="flex-1"
        />
      </View>

      <AppText variant="meta" className="text-center">
        Nothing happens without your okay — approving or dismissing is logged and reversible.
      </AppText>
    </>
  );
}

export default function ApprovalDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  // Re-fetch the small approvals list and resolve THIS action by id — keeps the
  // detail consistent with the list (no stale object passed through navigation).
  const { status, data, error, reload } = useApi<MobileApprovalsResponse>('/api/mobile/approvals');
  const action = data?.approvals.find((a) => a.id === id) ?? null;

  return (
    <Screen scroll className="gap-5">
      <ScreenHeader title="Approval" back />
      {status === 'loading' ? <LoadingState /> : null}
      {status === 'error' ? <ErrorState message={error ?? ''} onRetry={reload} /> : null}
      {status === 'ready' && action ? <ApprovalDetailBody action={action} /> : null}
      {status === 'ready' && !action ? (
        <Card className="mt-2 items-center gap-2 py-10">
          <AppText variant="title">No longer waiting</AppText>
          <AppText variant="meta" className="text-center">
            This action has already been resolved. Head back to see what's left.
          </AppText>
        </Card>
      ) : null}
    </Screen>
  );
}
