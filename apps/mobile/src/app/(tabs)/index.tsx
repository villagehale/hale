import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
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
import { useApi } from '@/lib/use-api';

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

function HomeBody({ data, onLogged }: { data: MobileHomeResponse; onLogged: () => void }) {
  const askIconColor = useMeadowColor('ink3');
  const rec = firstVillageRec(data.village.candidates);
  const [logKind, setLogKind] = useState<LogKind | null>(null);
  const hasChildren = data.children.length > 0;

  return (
    <>
      <View className="flex-row items-center justify-between pt-2">
        <AppText variant="display">{timeGreeting()}</AppText>
        <View className="flex-row items-center gap-2">
          <LogoMark size={26} />
          <AppText variant="title" className="text-sea">
            Hale
          </AppText>
        </View>
      </View>

      {hasChildren ? (
        <View className="flex-row items-center gap-2">
          <Pill
            label="Feed"
            icon="drop.fill"
            className="flex-1"
            onPress={() => setLogKind('feed')}
          />
          <Pill label="Nap" icon="moon.fill" className="flex-1" onPress={() => setLogKind('nap')} />
          <Pill
            label="Milestone"
            icon="star.fill"
            className="flex-1"
            onPress={() => setLogKind('milestone')}
          />
        </View>
      ) : null}

      <QuickLogModal
        visible={logKind !== null}
        kind={logKind}
        kids={data.children.map((c) => ({ id: c.id, name: c.name }))}
        onClose={() => setLogKind(null)}
        onLogged={onLogged}
      />

      <Card onPress={() => router.push('/ask')} className="flex-row items-center justify-between">
        <AppText variant="body" className="text-ink-3">
          Ask Hale anything
        </AppText>
        <Icon name="mic" size={20} color={askIconColor} />
      </Card>

      {rec ? (
        <View className="gap-2">
          <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
            From the village
          </AppText>
          <Card onPress={() => router.push('/village')} className="gap-1">
            <AppText variant="title">{rec.title}</AppText>
            <AppText variant="mono" className="text-ink-3">
              {rec.kind}
              {rec.endorsementCount > 0 ? ` · endorsed by ${rec.endorsementCount} families` : ''}
            </AppText>
            <AppText variant="body" className="mt-1">
              {rec.summary}
            </AppText>
          </Card>
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
                onPress={() => router.push('/companion')}
                className="min-w-[45%] flex-1 gap-1"
              >
                <View className="flex-row items-baseline justify-between">
                  <AppText variant="title">{child.name ?? 'Your child'}</AppText>
                  <AppText variant="mono" className="text-ink-3">
                    {agePhrase(child.ageMonths)}
                  </AppText>
                </View>
                <AppText variant="meta" className="mt-1">
                  {nextForChild(child)}
                </AppText>
              </Card>
            ))}
          </View>
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
      {status === 'ready' && data ? <HomeBody data={data} onLogged={refresh} /> : null}
    </Screen>
  );
}
