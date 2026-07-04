import { useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { useTintedRefresh } from '@/components/ui/pull-refresh';
import { Screen } from '@/components/ui/screen';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { Tag } from '@/components/ui/tag';
import type { MobileVillageResponse, VillageCandidateView } from '@/lib/api-types';
import { foundStamp } from '@/lib/format';
import { useApi } from '@/lib/use-api';
import {
  CADENCE_OPTIONS,
  type CadenceFilter,
  cadenceChip,
  filterByCadence,
} from '@/lib/village-filter';

function CadenceRow({
  value,
  onSelect,
}: {
  value: CadenceFilter;
  onSelect: (c: CadenceFilter) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="gap-2 pr-5"
    >
      {CADENCE_OPTIONS.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityLabel={`Filter: ${option.label}`}
            accessibilityState={active ? { selected: true } : {}}
            onPress={() => onSelect(option.value)}
            className={`rounded-full border px-4 py-2 ${
              active ? 'border-ink bg-ink' : 'border-rule bg-card'
            }`}
          >
            <AppText variant="meta" className={active ? 'text-canvas' : 'text-ink-2'}>
              {option.label}
            </AppText>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function CadenceChip({ cadence }: { cadence: string | null }) {
  const chip = cadenceChip(cadence);
  if (!chip) return null;
  return (
    <View className={`self-start rounded-full px-2.5 py-1 ${chip.bg}`}>
      <AppText variant="meta" className={`text-[12px] leading-[16px] ${chip.text}`}>
        {chip.label}
      </AppText>
    </View>
  );
}

function RecCard({ rec }: { rec: VillageCandidateView }) {
  if (rec.teenAttributed) {
    return (
      <Card className="gap-2">
        <Tag label="Redacted · teen privacy" tone="attention" />
        <AppText variant="meta">
          Category: {rec.kind}. Raw content is hidden by default to protect a teen's privacy.
        </AppText>
      </Card>
    );
  }
  return (
    <Card className="gap-2">
      <View className="flex-row items-start justify-between gap-3">
        <AppText variant="title" className="flex-1">
          {rec.title}
        </AppText>
        <Tag label={rec.kind} tone="coach" />
      </View>
      <View className="flex-row flex-wrap items-center gap-2">
        <CadenceChip cadence={rec.cadence} />
        <AppText variant="meta" className="text-ink-3">
          {foundStamp(rec.discoveredAt)}
        </AppText>
      </View>
      {rec.endorsementCount > 0 ? (
        <AppText variant="meta">Recommended by {rec.endorsementCount} families</AppText>
      ) : null}
      <AppText variant="body">{rec.summary}</AppText>
      {rec.accepted ? (
        <View className="mt-1 self-start rounded-full bg-sage-tint px-3 py-1.5">
          <AppText variant="meta" className="text-sage">
            Added to your week
          </AppText>
        </View>
      ) : null}
    </Card>
  );
}

function VillageBody({ data }: { data: MobileVillageResponse }) {
  const [cadence, setCadence] = useState<CadenceFilter>('all');
  const recs = useMemo(
    () => filterByCadence(data.candidates, cadence),
    [data.candidates, cadence],
  );
  const hasAny = data.candidates.length > 0;

  return (
    <>
      <View className="flex-row items-end justify-between pt-2">
        <AppText variant="display">Village</AppText>
      </View>

      {hasAny ? <CadenceRow value={cadence} onSelect={setCadence} /> : null}

      {recs.length === 0 ? (
        <Card className="mt-2 items-center gap-2 py-8">
          <AppText variant="title">{hasAny ? 'Nothing in this filter' : 'Fresh picks coming'}</AppText>
          <AppText variant="meta" className="text-center">
            {hasAny
              ? 'No activities match this cadence right now — try "all".'
              : 'Your village refreshes with current, in-season activities. Check back soon.'}
          </AppText>
        </Card>
      ) : (
        <View className="gap-3">
          {recs.map((rec) => (
            <RecCard key={rec.id} rec={rec} />
          ))}
        </View>
      )}

      <AppText variant="meta" className="mt-2 text-center">
        Recommendations use your coarse area only — never your exact address. Data stays in Canada.
      </AppText>
    </>
  );
}

export default function VillageScreen() {
  const { status, data, error, refreshing, reload, refresh } =
    useApi<MobileVillageResponse>('/api/mobile/village');

  return (
    <Screen scroll className="gap-4" refreshControl={useTintedRefresh(refreshing, refresh)}>
      {status === 'loading' ? <LoadingState /> : null}
      {status === 'error' ? <ErrorState message={error ?? ''} onRetry={reload} /> : null}
      {status === 'ready' && data ? <VillageBody data={data} /> : null}
    </Screen>
  );
}
