import { View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { useTintedRefresh } from '@/components/ui/pull-refresh';
import { Screen } from '@/components/ui/screen';
import { ScreenHeader } from '@/components/ui/screen-header';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { Tag } from '@/components/ui/tag';
import type { MobilePlanResponse } from '@/lib/api-types';
import { useApi } from '@/lib/use-api';

function SectionTitle({ children }: { children: string }) {
  return <AppText variant="section">{children}</AppText>;
}

function PlanBody({ data }: { data: MobilePlanResponse }) {
  const { addedActivities, routine, childItems, hasPlan } = data;

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
              <Card key={activity.id} className="gap-1">
                <Tag label={activity.kind} tone="coach" />
                <AppText variant="title" className="mt-1">
                  {activity.title}
                </AppText>
              </Card>
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
                <Card key={item.key} className="gap-1">
                  <View className="flex-row items-center justify-between">
                    <Tag label={item.kindLabel} tone="coach" />
                    <AppText variant="mono" className="text-ink-3">
                      {item.childName}
                    </AppText>
                  </View>
                  <AppText variant="title" className="mt-1">
                    {item.what}
                  </AppText>
                  <AppText variant="meta">{item.when}</AppText>
                </Card>
              ),
            )}
          </View>
          <AppText variant="meta" className="mt-1 text-center">
            Timing is the standard Canadian schedule — confirm with your provider.
          </AppText>
        </View>
      ) : null}
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
      {status === 'ready' && data ? <PlanBody data={data} /> : null}
    </Screen>
  );
}
