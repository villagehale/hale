import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { LogsDetailSheet } from '@/components/hale/logs-detail-sheet';
import { VillageDetailSheet } from '@/components/hale/village-detail-sheet';
import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { LogoMark } from '@/components/ui/logo-mark';
import { Pill } from '@/components/ui/pill';
import { useTintedRefresh } from '@/components/ui/pull-refresh';
import { type LogKind, QuickLogModal } from '@/components/ui/quick-log-modal';
import { Screen } from '@/components/ui/screen';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { useMeadowColor } from '@/constants/meadow';
import type { ChildCompanionView, MobileHomeResponse, VillageCandidateView } from '@/lib/api-types';
import { agePhrase } from '@/lib/format';
import { timeGreeting } from '@/lib/greeting';
import { homeStatCells } from '@/lib/home-stats';
import { useApi } from '@/lib/use-api';
import { rememberViewerFirstName } from '@/lib/viewer-name';

function nextForChild(child: ChildCompanionView): string {
  const health = child.nextHealth[0];
  if (health) return health.dueInWeeks <= 0 ? `${health.what} — due now` : health.what;
  const milestone = child.milestones.find((m) => m.timing === 'in_window') ?? child.milestones[0];
  if (milestone) return `${milestone.what} — worth watching`;
  return child.whatsNext;
}

function firstVillageRec(candidates: VillageCandidateView[]): VillageCandidateView | null {
  return candidates.find((c) => !c.teenAttributed) ?? null;
}

/** "Good evening, Alex" — the time-of-day phrase, warmed with the SIGNED-IN
 * parent's first name (the viewer, not the primary-parent slot, so a co-parent
 * sees their own name). Falls back to the bare phrase for a name-less account. */
function homeGreeting(viewer: MobileHomeResponse['viewer']): string {
  const firstName = viewer.name?.trim().split(/\s+/)[0];
  return firstName ? `${timeGreeting()}, ${firstName}` : timeGreeting();
}

/** The stat row: three honest counts (this week's logs, checkups coming up, saved
 * places). A zero stat reads a calm phrase, never a fake "0" (homeStatCells). Counts
 * only — no content — so rule #1 can't leak here. */
function HomeStatsRow({ stats }: { stats: MobileHomeResponse['stats'] }) {
  return (
    <View className="flex-row gap-2">
      {homeStatCells(stats).map((cell) => (
        <Card key={cell.label} className="flex-1 gap-0.5">
          {cell.count === null ? (
            <AppText variant="meta" className="text-ink-3">
              {cell.label}
            </AppText>
          ) : (
            <>
              <AppText variant="display" className="text-ink">
                {cell.count}
              </AppText>
              <AppText variant="meta" className="text-ink-3">
                {cell.label}
              </AppText>
            </>
          )}
        </Card>
      ))}
    </View>
  );
}

function HomeBody({
  data,
  onLogged,
  onRefresh,
}: {
  data: MobileHomeResponse;
  onLogged: () => void;
  onRefresh: () => void;
}) {
  const askIconColor = useMeadowColor('ink3');
  const rec = firstVillageRec(data.village.candidates);
  const [logKind, setLogKind] = useState<LogKind | null>(null);
  const [villageOpen, setVillageOpen] = useState(false);
  const [glanceChild, setGlanceChild] = useState<ChildCompanionView | null>(null);
  const hasChildren = data.children.length > 0;
  const greeting = homeGreeting(data.viewer);
  rememberViewerFirstName(data.viewer.name);

  return (
    <>
      <View className="gap-0.5 pt-2">
        <View className="flex-row items-center justify-between">
          <AppText variant="display" className="flex-1 pr-3">
            {greeting}
          </AppText>
          <LogoMark size={30} />
        </View>
        <AppText variant="meta" className="text-ink-3">
          Here&rsquo;s what&rsquo;s happening today.
        </AppText>
      </View>

      {hasChildren ? (
        <View className="flex-row items-center gap-2">
          <Pill
            label="Log feed"
            icon="drop.fill"
            className="flex-1"
            onPress={() => setLogKind('feed')}
          />
          <Pill
            label="Log nap"
            icon="moon.fill"
            className="flex-1"
            onPress={() => setLogKind('nap')}
          />
          <Pill
            label="Milestone"
            icon="star.fill"
            accent
            className="flex-1"
            onPress={() => setLogKind('milestone')}
          />
        </View>
      ) : (
        <Card className="gap-3">
          <AppText variant="title">Add your first child</AppText>
          <AppText variant="meta">
            Add a child and Hale unlocks one-tap logging for feeds and naps, their milestones and
            checkups, and a companion guide tuned to their stage.
          </AppText>
          <Button label="Add a child" onPress={() => router.push('/more/family')} />
        </Card>
      )}

      {hasChildren ? <HomeStatsRow stats={data.stats} /> : null}

      <QuickLogModal
        visible={logKind !== null}
        kind={logKind}
        kids={data.children.map((c) => ({
          id: c.id,
          name: c.name,
          milestoneSuggestions: c.milestones.map((m) => m.what),
        }))}
        onClose={() => setLogKind(null)}
        onLogged={onLogged}
      />

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Ask Concierge anything"
        onPress={() => router.push('/ask')}
        className="h-12 flex-row items-center gap-2.5 rounded-full border border-rule bg-card px-4 active:opacity-80"
      >
        <Icon name="sparkles" size={17} color={askIconColor} />
        <AppText variant="body" className="flex-1 text-ink-3">
          Ask Concierge anything
        </AppText>
        <Icon name="mic" size={18} color={askIconColor} />
      </Pressable>

      {rec ? (
        <View className="gap-2">
          <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
            From the village
          </AppText>
          <Card onPress={() => setVillageOpen(true)} className="gap-1">
            <AppText variant="title">{rec.title}</AppText>
            <AppText variant="mono" className="text-ink-3">
              {rec.kind}
              {rec.endorsementCount > 0 ? ` · endorsed by ${rec.endorsementCount} families` : ''}
            </AppText>
            <AppText variant="body" className="mt-1">
              {rec.summary}
            </AppText>
          </Card>
          <VillageDetailSheet
            rec={rec}
            visible={villageOpen}
            onClose={() => setVillageOpen(false)}
            onChanged={onRefresh}
          />
        </View>
      ) : null}

      {data.children.length > 0 ? (
        <View className="gap-2">
          <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
            Companion
          </AppText>
          <View className="flex-row flex-wrap gap-3">
            {data.children.map((child) => (
              <Card
                key={child.id}
                onPress={() => setGlanceChild(child)}
                className="min-w-[45%] flex-1 gap-1"
              >
                <View className="flex-row items-baseline justify-between">
                  <AppText variant="title" numberOfLines={1} className="mr-2 flex-1">
                    {child.name ?? 'Your child'}
                  </AppText>
                  <AppText variant="mono" className="shrink-0 text-ink-3">
                    {agePhrase(child.ageMonths)}
                  </AppText>
                </View>
                <AppText variant="meta" className="mt-1">
                  {nextForChild(child)}
                </AppText>
              </Card>
            ))}
          </View>

          <LogsDetailSheet
            childId={glanceChild?.id ?? null}
            childName={glanceChild?.name ?? null}
            visible={glanceChild !== null}
            onClose={() => setGlanceChild(null)}
          />
        </View>
      ) : null}
    </>
  );
}

export default function HomeScreen() {
  const { status, data, error, refreshing, reload, refresh } =
    useApi<MobileHomeResponse>('/api/mobile/home');

  return (
    <Screen scroll className="gap-5" refreshControl={useTintedRefresh(refreshing, refresh)}>
      {status === 'loading' ? <LoadingState /> : null}
      {status === 'error' ? <ErrorState message={error ?? ''} onRetry={reload} /> : null}
      {status === 'ready' && data ? (
        <HomeBody data={data} onLogged={refresh} onRefresh={refresh} />
      ) : null}
    </Screen>
  );
}
