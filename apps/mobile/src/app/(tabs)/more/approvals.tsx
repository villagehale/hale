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
import type {
  ApprovalView,
  HistoryView,
  MobileApprovalsHistoryResponse,
  MobileApprovalsResponse,
} from '@/lib/api-types';
import { api, ApiError } from '@/lib/api-client';
import { historyStatusTag, humanizeActionType, verdictTag } from '@/lib/approval-format';
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

/** A read-only History row: a past, resolved action with its outcome chip, the same
 * teen-safe intent label the live card shows, and when it resolved. No decision
 * buttons — history is settled. */
function HistoryCard({ item }: { item: HistoryView }) {
  const tag = historyStatusTag(item.status);
  return (
    <Card className="gap-2">
      <View className="flex-row items-start justify-between gap-3">
        <Tag label={tag.label} tone={tag.tone} />
        <AppText variant="mono" className="text-ink-3">
          {item.childLabel ? `for ${item.childLabel} · ` : ''}
          {item.resolvedAt}
        </AppText>
      </View>
      <AppText variant="title" className="mt-1">
        {humanizeActionType(item.actionType)}
      </AppText>
      <AppText variant="body">{item.preview}</AppText>
      <ApprovalPayloadBlock action={item} />
    </Card>
  );
}

function HistoryBody({ history }: { history: HistoryView[] }) {
  if (history.length === 0) {
    return (
      <Card className="mt-2 items-center gap-2 py-10">
        <AppText variant="title">No history yet</AppText>
        <AppText variant="meta" className="text-center">
          Once you approve or dismiss an action — or Hale handles one for you — it settles here.
        </AppText>
      </Card>
    );
  }
  return (
    <View className="gap-3">
      <AppText variant="meta" className="-mt-2">
        Past and held actions — what Hale did, what you decided, and what still needs you.
      </AppText>
      {history.map((item) => (
        <HistoryCard key={item.id} item={item} />
      ))}
    </View>
  );
}

type Segment = 'pending' | 'history';

/** A two-tab segmented control (Pending | History) — no shared component exists, so
 * this is a local pair of pills matching the app's rounded/bordered style. */
function Segmented({ value, onChange }: { value: Segment; onChange: (s: Segment) => void }) {
  const tabs: { key: Segment; label: string }[] = [
    { key: 'pending', label: 'Pending' },
    { key: 'history', label: 'History' },
  ];
  return (
    <View className="flex-row gap-1 rounded-full border border-rule bg-card p-1">
      {tabs.map((tab) => {
        const active = tab.key === value;
        return (
          <Pressable
            key={tab.key}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={tab.label}
            onPress={() => onChange(tab.key)}
            className={`flex-1 items-center rounded-full py-2 ${active ? 'bg-accent-tint' : ''}`}
          >
            <AppText variant="meta" className={active ? 'text-accent' : 'text-ink-3'}>
              {tab.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function ApprovalsScreen() {
  const [segment, setSegment] = useState<Segment>('pending');
  const pending = useApi<MobileApprovalsResponse>('/api/mobile/approvals');
  const history = useApi<MobileApprovalsHistoryResponse>('/api/mobile/approvals/history');
  const [resolved, setResolved] = useState<Set<string>>(new Set());

  const active = segment === 'pending' ? pending : history;
  const visiblePending = pending.data
    ? { approvals: pending.data.approvals.filter((a) => !resolved.has(a.id)) }
    : null;

  return (
    <Screen
      scroll
      className="gap-5"
      refreshControl={useTintedRefresh(active.refreshing, active.refresh)}
    >
      <ScreenHeader title="Approvals" back />
      <Segmented value={segment} onChange={setSegment} />
      {active.status === 'loading' ? <LoadingState /> : null}
      {active.status === 'error' ? (
        <ErrorState message={active.error ?? ''} onRetry={active.reload} />
      ) : null}
      {segment === 'pending' && pending.status === 'ready' && visiblePending ? (
        <ApprovalsBody
          data={visiblePending}
          onResolve={(id) => setResolved((prev) => new Set(prev).add(id))}
        />
      ) : null}
      {segment === 'history' && history.status === 'ready' && history.data ? (
        <HistoryBody history={history.data.history} />
      ) : null}
    </Screen>
  );
}
