import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { useTintedRefresh } from '@/components/ui/pull-refresh';
import { Screen } from '@/components/ui/screen';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { Tag } from '@/components/ui/tag';
import type { ChildCompanionView, MobileCompanionResponse, RecentLogView } from '@/lib/api-types';
import { api, ApiError } from '@/lib/api-client';
import { MILESTONE_TIMING_LABEL, agePhrase, duePhrase, whenPhrase } from '@/lib/format';
import { useApi } from '@/lib/use-api';

type LogKind = 'feed' | 'nap' | 'milestone';

const LOG_KINDS: { kind: LogKind; label: string; field: string; keyboard: 'numeric' | 'default' }[] =
  [
    { kind: 'feed', label: 'Feed', field: 'Amount (ml)', keyboard: 'numeric' },
    { kind: 'nap', label: 'Nap', field: 'Duration (min)', keyboard: 'numeric' },
    { kind: 'milestone', label: 'Milestone', field: 'What happened', keyboard: 'default' },
  ];

function ChildSwitcher({
  kids,
  selectedId,
  onSelect,
}: {
  kids: ChildCompanionView[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <View className="flex-row gap-2 rounded-full border border-rule bg-card p-1">
      {kids.map((child) => {
        const active = child.id === selectedId;
        return (
          <Pressable
            key={child.id}
            accessibilityRole="button"
            accessibilityLabel={`Show ${child.name ?? 'child'}`}
            accessibilityState={active ? { selected: true } : {}}
            onPress={() => onSelect(child.id)}
            className={`flex-1 items-center rounded-full py-2 ${active ? 'bg-raised' : ''}`}
          >
            <AppText variant="meta" className={active ? 'text-ink' : 'text-ink-3'}>
              {child.name ?? 'Child'}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

function InfoRow({
  when,
  stamp,
  what,
  first,
}: {
  when: string;
  stamp: boolean;
  what: string;
  first: boolean;
}) {
  return (
    <View
      className={`flex-row items-baseline gap-3 ${first ? '' : 'border-t border-rule pt-3'}`}
    >
      <View className="w-24 shrink-0">
        <Tag label={when} tone={stamp ? 'attention' : 'neutral'} />
      </View>
      <AppText variant="body" className="flex-1">
        {what}
      </AppText>
    </View>
  );
}

function LogForm({ childId, onLogged }: { childId: string; onLogged: () => void }) {
  const [kind, setKind] = useState<LogKind>('feed');
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = LOG_KINDS.find((k) => k.kind === kind) ?? LOG_KINDS[0];

  const save = async () => {
    const entry = value.trim();
    if (!entry) {
      setError(`Enter ${meta.field.toLowerCase()} before saving.`);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const payload =
        kind === 'feed'
          ? { kind, childId, amountMl: entry }
          : kind === 'nap'
            ? { kind, childId, durationMin: entry }
            : { kind, childId, milestone: entry };
      await api('/api/mobile/companion/log', { method: 'POST', body: JSON.stringify(payload) });
      setValue('');
      onLogged();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card raised className="gap-3">
      <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
        Quick log
      </AppText>
      <View className="flex-row gap-2">
        {LOG_KINDS.map((k) => {
          const active = k.kind === kind;
          return (
            <Pressable
              key={k.kind}
              accessibilityRole="button"
              accessibilityLabel={k.label}
              accessibilityState={active ? { selected: true } : {}}
              onPress={() => {
                setKind(k.kind);
                setValue('');
                setError(null);
              }}
              className={`flex-1 items-center rounded-full border py-2 ${
                active ? 'border-ink bg-ink' : 'border-rule bg-card'
              }`}
            >
              <AppText variant="meta" className={active ? 'text-canvas' : 'text-ink-2'}>
                {k.label}
              </AppText>
            </Pressable>
          );
        })}
      </View>
      <Field
        label={meta.field}
        value={value}
        onChangeText={setValue}
        keyboardType={meta.keyboard}
        autoCapitalize={kind === 'milestone' ? 'sentences' : 'none'}
      />
      {error ? (
        <AppText variant="meta" className="text-berry" accessibilityLiveRegion="polite">
          {error}
        </AppText>
      ) : null}
      <Button label={saving ? 'Saving…' : 'Save log'} onPress={save} className="self-start" />
    </Card>
  );
}

function RecentLogs({ logs }: { logs: RecentLogView[] }) {
  if (logs.length === 0) {
    return (
      <AppText variant="body">
        Nothing logged yet — use quick log above to note a feed, a nap, or a milestone.
      </AppText>
    );
  }
  return (
    <View className="gap-3">
      {logs.map((log, i) => (
        <View
          key={log.id}
          className={`flex-row items-baseline gap-3 ${i === 0 ? '' : 'border-t border-rule pt-3'}`}
        >
          <AppText variant="body" className="flex-1">
            {log.summary}
          </AppText>
          <AppText variant="mono" className="text-ink-3">
            {whenPhrase(log.occurredAt)}
          </AppText>
        </View>
      ))}
    </View>
  );
}

function CompanionBody({
  data,
  onLogged,
}: {
  data: MobileCompanionResponse;
  onLogged: () => void;
}) {
  const [selectedId, setSelectedId] = useState(data.children[0]?.id ?? '');
  const child = data.children.find((c) => c.id === selectedId) ?? data.children[0];
  if (!child) {
    return (
      <Card className="mt-2 items-center gap-2 py-10">
        <AppText variant="title">No children yet</AppText>
        <AppText variant="meta" className="text-center">
          Add a child in Family and their companion guide will appear here.
        </AppText>
      </Card>
    );
  }

  const childLogs = data.recentLogs.filter((l) => l.childId === child.id);

  return (
    <>
      <View className="flex-row items-end justify-between pt-2">
        <AppText variant="display">Companion</AppText>
        <AppText variant="mono" className="text-ink-3">
          {agePhrase(child.ageMonths)} · {child.stage}
        </AppText>
      </View>

      {data.children.length > 1 ? (
        <ChildSwitcher kids={data.children} selectedId={child.id} onSelect={setSelectedId} />
      ) : null}

      <Card className="gap-3">
        <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
          Next health items
        </AppText>
        {child.nextHealth.length === 0 ? (
          <AppText variant="body">
            No routine items left on the standard schedule — keep up periodic visits.
          </AppText>
        ) : (
          <View className="gap-3">
            {child.nextHealth.slice(0, 3).map((item, i) => (
              <InfoRow
                key={`${item.ageMonths}-${item.kind}`}
                when={duePhrase(item.dueInWeeks)}
                stamp={item.dueInWeeks <= 0}
                what={item.what}
                first={i === 0}
              />
            ))}
          </View>
        )}
        <AppText variant="meta">
          Timing is the standard Canadian schedule — confirm with your provider.
        </AppText>
      </Card>

      <Card className="gap-3">
        <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
          Milestones
        </AppText>
        <View className="gap-3">
          {child.milestones.map((milestone, i) => (
            <InfoRow
              key={milestone.what}
              when={MILESTONE_TIMING_LABEL[milestone.timing]}
              stamp={milestone.timing === 'in_window'}
              what={milestone.what}
              first={i === 0}
            />
          ))}
        </View>
        <AppText variant="meta">
          Every child grows at their own pace — if something's not happening yet, it's worth asking,
          never a verdict.
        </AppText>
      </Card>

      <LogForm childId={child.id} onLogged={onLogged} />

      <View className="gap-2">
        <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
          Recent logs
        </AppText>
        <Card className="gap-1">
          <RecentLogs logs={childLogs} />
        </Card>
      </View>
    </>
  );
}

export default function CompanionScreen() {
  const { status, data, error, refreshing, reload, refresh } = useApi<MobileCompanionResponse>(
    '/api/mobile/companion',
  );

  return (
    <Screen scroll className="gap-5" refreshControl={useTintedRefresh(refreshing, refresh)}>
      {status === 'loading' ? <LoadingState /> : null}
      {status === 'error' ? <ErrorState message={error ?? ''} onRetry={reload} /> : null}
      {status === 'ready' && data ? <CompanionBody data={data} onLogged={refresh} /> : null}
    </Screen>
  );
}
