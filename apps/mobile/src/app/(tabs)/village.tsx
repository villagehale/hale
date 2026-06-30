import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Screen } from '@/components/ui/screen';
import {
  COARSE_AREA,
  VILLAGE_INTERESTS,
  VILLAGE_RECS,
  type VillageInterest,
  type VillageRec,
} from '@/constants/village-data';

function FilterRow({
  selected,
  onSelect,
}: {
  selected: VillageInterest;
  onSelect: (i: VillageInterest) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="gap-2 pr-5"
    >
      {VILLAGE_INTERESTS.map((interest) => {
        const active = interest === selected;
        return (
          <Pressable
            key={interest}
            accessibilityRole="button"
            accessibilityLabel={`Filter: ${interest}`}
            accessibilityState={active ? { selected: true } : {}}
            onPress={() => onSelect(interest)}
            className={`rounded-full border px-4 py-2 ${
              active ? 'border-ink bg-ink' : 'border-rule bg-card'
            }`}
          >
            <AppText variant="meta" className={active ? 'text-canvas' : 'text-ink-2'}>
              {interest}
            </AppText>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function RecCard({
  rec,
  added,
  onAdd,
}: {
  rec: VillageRec;
  added: boolean;
  onAdd: () => void;
}) {
  return (
    <Card className="gap-2">
      <View className="flex-row items-start justify-between gap-3">
        <AppText variant="title" className="flex-1">
          {rec.title}
        </AppText>
        <AppText variant="mono" className="text-ink-3">
          ~{rec.distanceKm.toFixed(1)} km
        </AppText>
      </View>
      <AppText variant="meta">
        {rec.interest} · {rec.hours} · recommended by {rec.recommendedBy} families
      </AppText>
      <AppText variant="body">{rec.blurb}</AppText>
      {added ? (
        <View className="mt-1 self-start rounded-full bg-sage-tint px-3 py-1.5">
          <AppText variant="meta" className="text-sage">
            Added to routine
          </AppText>
        </View>
      ) : (
        <Button
          label="Add to routine"
          variant="secondary"
          onPress={onAdd}
          className="mt-1 self-start"
        />
      )}
    </Card>
  );
}

export default function VillageScreen() {
  const [interest, setInterest] = useState<VillageInterest>('All');
  const [added, setAdded] = useState<Record<string, boolean>>({});

  const recs =
    interest === 'All' ? VILLAGE_RECS : VILLAGE_RECS.filter((r) => r.interest === interest);

  return (
    <Screen scroll className="gap-4">
      <View className="flex-row items-end justify-between pt-2">
        <AppText variant="display">Village</AppText>
        <AppText variant="mono" className="text-ink-3">
          {COARSE_AREA}
        </AppText>
      </View>

      <FilterRow selected={interest} onSelect={setInterest} />

      {recs.length === 0 ? (
        <Card className="mt-2 items-center gap-2 py-8">
          <AppText variant="title">Nothing here yet</AppText>
          <AppText variant="meta" className="text-center">
            No {interest.toLowerCase()} spots in your area right now. Try another filter, or check
            back as more families share.
          </AppText>
          <Button
            label="Show all"
            variant="secondary"
            onPress={() => setInterest('All')}
            className="mt-1"
          />
        </Card>
      ) : (
        <View className="gap-3">
          {recs.map((rec) => (
            <RecCard
              key={rec.id}
              rec={rec}
              added={!!added[rec.id]}
              onAdd={() => setAdded((prev) => ({ ...prev, [rec.id]: true }))}
            />
          ))}
        </View>
      )}

      <AppText variant="meta" className="mt-2 text-center">
        Recommendations use your coarse area ({COARSE_AREA}) only — never your exact address. Data
        stays in Canada.
      </AppText>
    </Screen>
  );
}
