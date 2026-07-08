import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { useTintedRefresh } from '@/components/ui/pull-refresh';
import { type LogKind, QuickLogModal } from '@/components/ui/quick-log-modal';
import { Screen } from '@/components/ui/screen';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { Tag } from '@/components/ui/tag';
import { useMeadowColor } from '@/constants/meadow';
import type { ChildCompanionView, MobileCompanionResponse, RecentLogView } from '@/lib/api-types';
import { MILESTONE_TIMING_LABEL, STAGE_LABEL, agePhrase, duePhrase, whenPhrase } from '@/lib/format';
import { useApi } from '@/lib/use-api';

const LOG_KINDS: { kind: LogKind; label: string }[] = [
  { kind: 'feed', label: 'Feed' },
  { kind: 'nap', label: 'Nap' },
  { kind: 'milestone', label: 'Milestone' },
];

/**
 * Header initial-chips (the mockup's circular child chip, made plural): every
 * kid is a small circle; the selected one is filled Prussian, the rest outlined.
 * The tab stays "Companion" (a stable place); the PAGE is one child in focus —
 * multi-child switching is one tap here, never a stacked double-length scroll.
 */
function ChildChips({
  kids,
  selectedId,
  onSelect,
}: {
  kids: ChildCompanionView[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <View className="flex-row items-center gap-2">
      {kids.map((child) => {
        const active = child.id === selectedId;
        const initial = (child.name ?? '?').trim().charAt(0).toUpperCase() || '?';
        return (
          <Pressable
            key={child.id}
            accessibilityRole="button"
            accessibilityLabel={`Show ${child.name ?? 'child'}`}
            accessibilityState={active ? { selected: true } : {}}
            onPress={() => onSelect(child.id)}
            className={`h-10 w-10 items-center justify-center rounded-full ${
              active ? 'bg-ink' : 'border border-rule bg-card'
            }`}
          >
            <AppText variant="title" className={active ? 'text-on-ink' : 'text-ink-3'}>
              {initial}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * A health / milestone row. The timing sits in its own column that reads FULLY —
 * only the "now" state (or done) earns a Tag pill; every other timing is plain
 * uppercase eyebrow ink, mirroring the web companion (stamp for in-window, plain
 * eyebrow otherwise). A pill on every row read messy and clipped "IN ~4 MONTHS";
 * the label column now wraps instead of a fixed too-narrow pill.
 */
function InfoRow({
  when,
  stamp,
  what,
  first,
  done = false,
}: {
  when: string;
  stamp: boolean;
  what: string;
  first: boolean;
  done?: boolean;
}) {
  return (
    <View className={`flex-row items-start gap-3 ${first ? '' : 'border-t border-rule pt-3'}`}>
      {/* Wide enough for the longest stamp, "around now" (11px uppercase, 0.12em
          tracking ≈ 103px pill) — at 104px it clipped to "AROUND N". */}
      <View className="w-[124px] shrink-0 pt-0.5">
        {done ? (
          <Tag label="done" tone="done" />
        ) : stamp ? (
          <Tag label={when} tone="accent" />
        ) : (
          <AppText
            variant="meta"
            className="text-[11px] uppercase leading-[15px] tracking-eyebrow text-ink-2"
          >
            {when}
          </AppText>
        )}
      </View>
      <AppText variant="body" className={`flex-1 ${done ? 'text-ink-3' : ''}`}>
        {what}
      </AppText>
    </View>
  );
}

function QuickLogCard({
  child,
  onLogged,
}: {
  child: ChildCompanionView;
  onLogged: () => void;
}) {
  const [logKind, setLogKind] = useState<LogKind | null>(null);

  return (
    <Card raised className="gap-3">
      <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
        Quick log
      </AppText>
      <View className="flex-row gap-2">
        {LOG_KINDS.map((k) => (
          <Pressable
            key={k.kind}
            accessibilityRole="button"
            accessibilityLabel={k.label}
            onPress={() => setLogKind(k.kind)}
            className="h-11 flex-1 items-center justify-center rounded-full border border-rule bg-card active:opacity-80"
          >
            <AppText variant="meta" className="text-ink-2">
              {k.label}
            </AppText>
          </Pressable>
        ))}
      </View>
      <QuickLogModal
        visible={logKind !== null}
        kind={logKind}
        kids={[{ id: child.id, name: child.name }]}
        onClose={() => setLogKind(null)}
        onLogged={onLogged}
      />
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
  // Above the early return — a hook after it crashes React when the child count
  // transitions between renders (rules of hooks).
  const accentFill = useMeadowColor('accentFill');
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
      {/* Child-centric header (mockup 2): the child IS the page; the initial
          chips are the switcher when there is more than one. */}
      <View className="flex-row items-center justify-between pt-2">
        <View className="flex-1 gap-0.5 pr-3">
          <AppText variant="display">{child.name ?? 'Your child'}</AppText>
          <AppText variant="meta" numberOfLines={1} className="text-ink-3">
            {agePhrase(child.ageMonths)} · {STAGE_LABEL[child.stage]}
          </AppText>
        </View>
        {data.children.length > 1 ? (
          <ChildChips kids={data.children} selectedId={child.id} onSelect={setSelectedId} />
        ) : null}
      </View>

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
                key={item.key}
                when={duePhrase(item.dueInWeeks)}
                stamp={item.dueInWeeks <= 0}
                what={item.what}
                first={i === 0}
                done={item.done}
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
              done={milestone.done}
            />
          ))}
        </View>
        <View className="mt-1 flex-row items-start gap-2.5 rounded-md bg-accent-tint px-3.5 py-3">
          <Icon name="sparkles" size={16} color={accentFill} />
          <AppText variant="meta" className="flex-1 text-ink">
            Every child grows at their own pace — if something's not happening yet, it's worth
            asking, never a verdict.
          </AppText>
        </View>
      </Card>

      <QuickLogCard child={child} onLogged={onLogged} />

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
