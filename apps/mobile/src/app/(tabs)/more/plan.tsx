import { Share, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { IconButton } from '@/components/ui/icon-button';
import { Screen } from '@/components/ui/screen';
import { ScreenHeader } from '@/components/ui/screen-header';
import { Tag, type TagTone } from '@/components/ui/tag';
import { PLAN_WEEK, type PlanItem, type PlanItemKind } from '@/constants/plan-data';

const KIND_LABEL: Record<PlanItemKind, string> = {
  activity: 'Village',
  routine: 'Routine',
  checkup: 'Checkup',
  immunization: 'Immunization',
  milestone: 'Milestone',
};

const KIND_TONE: Record<PlanItemKind, TagTone> = {
  activity: 'coach',
  routine: 'neutral',
  checkup: 'coach',
  immunization: 'attention',
  milestone: 'coach',
};

function ItemRow({ item }: { item: PlanItem }) {
  const shareRoutine = () =>
    Share.share({ message: `Our routine with Hale: ${item.title} — ${item.detail}` });

  return (
    <Card className="gap-1">
      <View className="flex-row items-start justify-between gap-3">
        <Tag label={KIND_LABEL[item.kind]} tone={KIND_TONE[item.kind]} />
        {item.kind === 'routine' ? (
          <IconButton
            icon="square.and.arrow.up"
            accessibilityLabel="Share this routine"
            size={16}
            onPress={shareRoutine}
            className="h-9 w-9 bg-raised"
          />
        ) : item.child ? (
          <AppText variant="mono" className="text-ink-3">
            {item.child}
          </AppText>
        ) : null}
      </View>
      <AppText variant="title" className="mt-1">
        {item.title}
      </AppText>
      <AppText variant="meta">{item.detail}</AppText>
    </Card>
  );
}

export default function PlanScreen() {
  return (
    <Screen scroll className="gap-5">
      <ScreenHeader title="Plan" back />
      <AppText variant="meta" className="-mt-2">
        The week ahead — endorsed activities, your routine, and what's coming up per child.
      </AppText>

      {PLAN_WEEK.map((day) => (
        <View key={day.id} className="gap-2">
          <View className="flex-row items-baseline gap-2">
            <AppText variant="title">{day.label}</AppText>
            <AppText variant="mono" className="text-ink-3">
              {day.date}
            </AppText>
          </View>
          <View className="gap-3">
            {day.items.map((item) => (
              <ItemRow key={item.id} item={item} />
            ))}
          </View>
        </View>
      ))}

      <AppText variant="meta" className="mt-1 text-center">
        Always confirm health and milestones with your provider.
      </AppText>
    </Screen>
  );
}
