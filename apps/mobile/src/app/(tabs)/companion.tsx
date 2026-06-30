import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Screen } from '@/components/ui/screen';
import { Tag, type TagTone } from '@/components/ui/tag';
import {
  COMPANION_CHILDREN,
  type TimelineEntry,
  type TimelineKind,
} from '@/constants/companion-data';

const KIND_LABEL: Record<TimelineKind, string> = {
  checkup: 'Checkup',
  immunization: 'Immunization',
  milestone: 'Milestone',
  log: 'Logged',
};

const KIND_TONE: Record<TimelineKind, TagTone> = {
  checkup: 'coach',
  immunization: 'attention',
  milestone: 'coach',
  log: 'done',
};

function ChildSwitcher({
  selectedId,
  onSelect,
}: {
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <View className="flex-row gap-2 rounded-full border border-rule bg-card p-1">
      {COMPANION_CHILDREN.map((child) => {
        const active = child.id === selectedId;
        return (
          <Pressable
            key={child.id}
            accessibilityRole="button"
            accessibilityLabel={`Show ${child.name}`}
            accessibilityState={active ? { selected: true } : {}}
            onPress={() => onSelect(child.id)}
            className={`flex-1 items-center rounded-full py-2 ${active ? 'bg-raised' : ''}`}
          >
            <AppText variant="meta" className={active ? 'text-ink' : 'text-ink-3'}>
              {child.name}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

function TimelineRow({ entry, last }: { entry: TimelineEntry; last: boolean }) {
  return (
    <View className="flex-row gap-3">
      <View className="items-center">
        <View
          className={`mt-1.5 h-3 w-3 rounded-full border-2 ${
            entry.upcoming ? 'border-accent bg-canvas' : 'border-rule-strong bg-card'
          }`}
        />
        {last ? null : <View className="my-1 w-0.5 flex-1 bg-rule" />}
      </View>
      <Card className={`mb-3 flex-1 gap-1 ${entry.upcoming ? '' : 'opacity-90'}`}>
        <View className="flex-row items-center justify-between">
          <Tag label={KIND_LABEL[entry.kind]} tone={KIND_TONE[entry.kind]} />
          <AppText variant="mono" className="text-ink-3">
            {entry.when}
          </AppText>
        </View>
        <AppText variant="title" className="mt-1">
          {entry.title}
        </AppText>
        <AppText variant="meta">{entry.detail}</AppText>
      </Card>
    </View>
  );
}

export default function CompanionScreen() {
  const [selectedId, setSelectedId] = useState(COMPANION_CHILDREN[0].id);
  const child = COMPANION_CHILDREN.find((c) => c.id === selectedId) ?? COMPANION_CHILDREN[0];

  return (
    <Screen scroll className="gap-5">
      <View className="flex-row items-end justify-between pt-2">
        <AppText variant="display">Companion</AppText>
        <AppText variant="mono" className="text-ink-3">
          {child.ageMonths} mo · {child.stage}
        </AppText>
      </View>

      <ChildSwitcher selectedId={selectedId} onSelect={setSelectedId} />

      <View>
        {child.timeline.map((entry, i) => (
          <TimelineRow key={entry.id} entry={entry} last={i === child.timeline.length - 1} />
        ))}
      </View>

      <Card raised className="gap-2">
        <Tag label="Autonomy" tone="coach" />
        <AppText variant="title">Let Hale book the next checkup?</AppText>
        <AppText variant="body">
          You've confirmed Hale's suggestions 4 times. One more and you can let it handle bookings
          for you, with every action logged for your review.
        </AppText>
        <Button label="See how autonomy works" variant="secondary" className="mt-1 self-start" />
      </Card>
    </Screen>
  );
}
