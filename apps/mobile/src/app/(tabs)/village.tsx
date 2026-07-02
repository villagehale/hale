import { useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { useTintedRefresh } from '@/components/ui/pull-refresh';
import { Screen } from '@/components/ui/screen';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { Tag } from '@/components/ui/tag';
import type { MobileVillageResponse, VillageCandidateView } from '@/lib/api-types';
import { useApi } from '@/lib/use-api';

const ALL = 'All';

function FilterRow({
  kinds,
  selected,
  onSelect,
}: {
  kinds: string[];
  selected: string;
  onSelect: (k: string) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="gap-2 pr-5"
    >
      {[ALL, ...kinds].map((kind) => {
        const active = kind === selected;
        return (
          <Pressable
            key={kind}
            accessibilityRole="button"
            accessibilityLabel={`Filter: ${kind}`}
            accessibilityState={active ? { selected: true } : {}}
            onPress={() => onSelect(kind)}
            className={`rounded-full border px-4 py-2 ${
              active ? 'border-ink bg-ink' : 'border-rule bg-card'
            }`}
          >
            <AppText variant="meta" className={active ? 'text-canvas' : 'text-ink-2'}>
              {kind}
            </AppText>
          </Pressable>
        );
      })}
    </ScrollView>
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
  const [kind, setKind] = useState(ALL);
  const kinds = useMemo(
    () => [...new Set(data.candidates.filter((c) => !c.teenAttributed).map((c) => c.kind))],
    [data.candidates],
  );
  const recs = kind === ALL ? data.candidates : data.candidates.filter((c) => c.kind === kind);

  return (
    <>
      <View className="flex-row items-end justify-between pt-2">
        <AppText variant="display">Village</AppText>
      </View>

      {kinds.length > 0 ? <FilterRow kinds={kinds} selected={kind} onSelect={setKind} /> : null}

      {recs.length === 0 ? (
        <Card className="mt-2 items-center gap-2 py-8">
          <AppText variant="title">Nothing here yet</AppText>
          <AppText variant="meta" className="text-center">
            No spots to show right now. Check back as more families share.
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
