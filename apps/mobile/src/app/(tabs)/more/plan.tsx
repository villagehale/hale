import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { VillageDetailSheet } from '@/components/hale/village-detail-sheet';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { useTintedRefresh } from '@/components/ui/pull-refresh';
import { Screen } from '@/components/ui/screen';
import { ScreenHeader } from '@/components/ui/screen-header';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { Tag } from '@/components/ui/tag';
import { useMeadowColor } from '@/constants/meadow';
import type { MobilePlanResponse, VillageCandidateView } from '@/lib/api-types';
import { useApi } from '@/lib/use-api';

function SectionTitle({ children }: { children: string }) {
  return (
    <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
      {children}
    </AppText>
  );
}

function PlanBody({ data, onRefresh }: { data: MobilePlanResponse; onRefresh: () => void }) {
  const { addedActivities, routine, childItems, hasPlan } = data;
  const [openRec, setOpenRec] = useState<VillageCandidateView | null>(null);
  const chevron = useMeadowColor('ink3');

  if (!hasPlan) {
    return (
      <Card className="mt-2 items-center gap-2 py-10">
        <AppText variant="title">A quiet week ahead</AppText>
        <AppText variant="meta" className="text-center">
          Nothing is scheduled yet. Add activities in Village and check back here.
        </AppText>
      </Card>
    );
  }

  return (
    <>
      {addedActivities.length > 0 ? (
        <View className="gap-2">
          <SectionTitle>Added to your week</SectionTitle>
          <View className="gap-3">
            {addedActivities.map((activity) => (
              // The added activity is a full VillageCandidateView (rich fields already
              // in /api/mobile/plan), so it opens the SAME detail sheet as the feed.
              <Pressable
                key={activity.id}
                accessibilityRole="button"
                accessibilityLabel={`Open ${activity.title}`}
                onPress={() => setOpenRec(activity)}
                className="active:opacity-80"
              >
                <Card className="gap-1">
                  <View className="flex-row items-start justify-between gap-3">
                    <Tag label={activity.kind} tone="coach" />
                    <Icon name="chevron.right" size={13} color={chevron} />
                  </View>
                  <AppText variant="title" className="mt-1">
                    {activity.title}
                  </AppText>
                </Card>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      {routine && routine.items.length > 0 ? (
        <View className="gap-2">
          <SectionTitle>A gentle routine</SectionTitle>
          <AppText variant="meta" className="-mt-1">
            Week of {routine.weekOf}
          </AppText>
          <View className="gap-3">
            {routine.items.map((item, i) => (
              <Card key={`${item.kind}-${i}`} className="gap-1">
                <View className="flex-row items-center justify-between">
                  <Tag label={item.kind} tone="neutral" />
                  {item.day ? (
                    <AppText variant="mono" className="capitalize text-ink-3">
                      {item.day}
                    </AppText>
                  ) : null}
                </View>
                <AppText variant="title" className="mt-1">
                  {item.title}
                </AppText>
                {item.stageNote ? <AppText variant="meta">{item.stageNote}</AppText> : null}
              </Card>
            ))}
          </View>
        </View>
      ) : null}

      {childItems.length > 0 ? (
        <View className="gap-2">
          <SectionTitle>Coming up for your kids</SectionTitle>
          <View className="gap-3">
            {childItems.map((item) =>
              item.teenRedacted ? (
                // Rule #1 (policy 3): one locked line for a 13+ teen — no name, no
                // content, no "when"; the parent sees THAT a plan exists.
                <Card key={item.key} className="gap-1">
                  <Tag label="private" tone="attention" />
                  <AppText variant="title" className="mt-1">
                    {item.what}
                  </AppText>
                </Card>
              ) : (
                // A per-child item is a shallow computed fold — there is no deeper
                // view to fabricate, so the row links to the Companion tab where that
                // child's full picture lives.
                <Pressable
                  key={item.key}
                  accessibilityRole="button"
                  accessibilityLabel={`${item.what} — open Companion`}
                  onPress={() => router.push('/companion')}
                  className="active:opacity-80"
                >
                  <Card className="gap-1">
                    <View className="flex-row items-center justify-between">
                      <Tag label={item.kindLabel} tone="coach" />
                      <View className="flex-row items-center gap-2">
                        <AppText variant="mono" className="text-ink-3">
                          {item.childName}
                        </AppText>
                        <Icon name="chevron.right" size={13} color={chevron} />
                      </View>
                    </View>
                    <AppText variant="title" className="mt-1">
                      {item.what}
                    </AppText>
                    <AppText variant="meta">{item.when}</AppText>
                  </Card>
                </Pressable>
              ),
            )}
          </View>
          <AppText variant="meta" className="mt-1 text-center">
            Timing is the standard Canadian schedule — confirm with your provider.
          </AppText>
        </View>
      ) : null}

      <VillageDetailSheet
        rec={openRec}
        visible={openRec !== null}
        onClose={() => setOpenRec(null)}
        onChanged={onRefresh}
      />
    </>
  );
}

export default function PlanScreen() {
  const { status, data, error, refreshing, reload, refresh } =
    useApi<MobilePlanResponse>('/api/mobile/plan');

  return (
    <Screen scroll className="gap-5" refreshControl={useTintedRefresh(refreshing, refresh)}>
      <ScreenHeader title="Plan" back />
      <AppText variant="meta" className="-mt-2">
        The week ahead — endorsed activities, your routine, and what's coming up per child.
      </AppText>
      {status === 'loading' ? <LoadingState /> : null}
      {status === 'error' ? <ErrorState message={error ?? ''} onRetry={reload} /> : null}
      {status === 'ready' && data ? <PlanBody data={data} onRefresh={refresh} /> : null}
    </Screen>
  );
}
