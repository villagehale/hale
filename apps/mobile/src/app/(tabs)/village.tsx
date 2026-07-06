import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { TypingDots } from '@/components/hale/typing-dots';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { useTintedRefresh } from '@/components/ui/pull-refresh';
import { Screen } from '@/components/ui/screen';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { Tag } from '@/components/ui/tag';
import { useMeadowColor } from '@/constants/meadow';
import { ApiError, api } from '@/lib/api-client';
import type { MobileVillageResponse, VillageCandidateView } from '@/lib/api-types';
import { foundStamp } from '@/lib/format';
import { useApi } from '@/lib/use-api';
import {
  CADENCE_OPTIONS,
  type CadenceFilter,
  cadenceChip,
  filterByCadence,
} from '@/lib/village-filter';
import {
  type DiscoverResult,
  SEASON_KEYS,
  type SeasonKey,
  searchOutcomeFromError,
  searchOutcomeFromResult,
  searchReadPath,
} from '@/lib/village-search';

const STANDING_PATH = '/api/mobile/village';

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
            className={`min-h-11 items-center justify-center rounded-full border px-4 py-2.5 ${
              active ? 'border-ink bg-ink' : 'border-rule bg-card'
            }`}
          >
            <AppText variant="meta" className={active ? 'text-on-ink' : 'text-ink-2'}>
              {option.label}
            </AppText>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/**
 * The Village's ONE source control: a search bar for season discovery. Tapping it
 * discloses the four seasons; picking one runs a season-scoped discovery and the
 * bar collapses to show the active season with a clear (×) back to the feed.
 * This replaces the old second chip row — search reads as search (a field with a
 * magnifier), leaving the cadence chips below as the single, visually-distinct
 * FILTER. The two rows no longer look like duplicates of each other.
 */
function SeasonSearch({
  activeSeason,
  onSearch,
  onClear,
  disabled,
}: {
  activeSeason: SeasonKey | null;
  onSearch: (s: SeasonKey) => void;
  onClear: () => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const iconColor = useMeadowColor('ink3');
  const accentIcon = useMeadowColor('accentFill');

  if (activeSeason) {
    return (
      <View className="flex-row items-center gap-2 rounded-full border border-accent bg-accent-tint px-4 py-2.5">
        <Icon name="magnifyingglass" size={15} color={accentIcon} />
        <AppText variant="meta" className="flex-1 capitalize text-ink">
          {activeSeason} activities
        </AppText>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear season search, back to your feed"
          hitSlop={8}
          onPress={onClear}
          className="active:opacity-70"
        >
          <Icon name="xmark.circle.fill" size={18} color={iconColor} />
        </Pressable>
      </View>
    );
  }

  return (
    <View className="gap-2">
      <Pressable
        accessibilityRole="search"
        accessibilityLabel="Search activities by season"
        accessibilityState={{ expanded: open, disabled }}
        disabled={disabled}
        onPress={() => setOpen((o) => !o)}
        className={`h-12 flex-row items-center gap-2.5 rounded-full border border-rule bg-card px-4 active:opacity-80 ${
          disabled ? 'opacity-50' : ''
        }`}
      >
        <Icon name="magnifyingglass" size={16} color={iconColor} />
        <AppText variant="body" className="flex-1 text-ink-3">
          Search activities by season
        </AppText>
        <Icon name={open ? 'chevron.up' : 'chevron.down'} size={13} color={iconColor} />
      </Pressable>

      {open ? (
        <View className="flex-row flex-wrap gap-2 px-1">
          {SEASON_KEYS.map((season) => (
            <Pressable
              key={season}
              accessibilityRole="button"
              accessibilityLabel={`Search ${season} activities`}
              disabled={disabled}
              onPress={() => {
                setOpen(false);
                onSearch(season);
              }}
              className="min-h-11 items-center justify-center rounded-full border border-rule bg-raised px-4 py-2.5 active:opacity-80"
            >
              <AppText variant="meta" className="capitalize text-ink-2">
                {season}
              </AppText>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function SearchPending({ season }: { season: SeasonKey }) {
  return (
    <Card className="mt-2 items-center gap-3 py-10">
      <TypingDots />
      <AppText variant="meta" className="text-center">
        Searching {season} activities…
      </AppText>
    </Card>
  );
}

function CadenceChip({ cadence }: { cadence: string | null }) {
  const chip = cadenceChip(cadence);
  if (!chip) return null;
  return (
    <View
      className={`h-6 min-w-6 items-center justify-center self-start rounded-full px-2.5 ${chip.bg}`}
    >
      <AppText
        variant="meta"
        className={`text-[11px] uppercase leading-none tracking-eyebrow ${chip.text}`}
      >
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
        <AppText variant="meta">
          Recommended by {rec.endorsementCount}{' '}
          {rec.endorsementCount === 1 ? 'family' : 'families'}
        </AppText>
      ) : null}
      <AppText variant="body">{rec.summary}</AppText>
      {rec.accepted ? (
        <View className="mt-1 h-7 items-center justify-center self-start rounded-full bg-sage-tint px-3">
          <AppText variant="meta" className="leading-none text-sage">
            Added to your week
          </AppText>
        </View>
      ) : null}
    </Card>
  );
}

function VillageBody({
  data,
  searchSeason,
  showFilter,
}: {
  data: MobileVillageResponse;
  searchSeason: SeasonKey | null;
  showFilter: boolean;
}) {
  const [cadence, setCadence] = useState<CadenceFilter>('all');
  const recs = useMemo(() => filterByCadence(data.candidates, cadence), [data.candidates, cadence]);
  const hasAny = data.candidates.length > 0;

  return (
    <>
      {hasAny && showFilter ? (
        <View className="gap-2">
          <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
            Filter
          </AppText>
          <CadenceRow value={cadence} onSelect={setCadence} />
        </View>
      ) : null}

      {recs.length === 0 ? (
        <Card className="mt-2 items-center gap-2 py-8">
          <AppText variant="title">
            {hasAny
              ? 'Nothing in this filter'
              : searchSeason
                ? 'No matches yet'
                : 'Fresh picks coming'}
          </AppText>
          <AppText variant="meta" className="text-center">
            {hasAny
              ? 'No activities match this cadence right now — try "all".'
              : searchSeason
                ? `No ${searchSeason} activities found near you yet.`
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
  const [activeSeason, setActiveSeason] = useState<SeasonKey | null>(null);
  const [pendingSeason, setPendingSeason] = useState<SeasonKey | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const readPath = activeSeason ? searchReadPath(activeSeason) : STANDING_PATH;
  const { status, data, error, refreshing, reload, refresh } =
    useApi<MobileVillageResponse>(readPath);

  const clearToFeed = useCallback(() => {
    setActiveSeason(null);
    setPendingSeason(null);
    setSearchError(null);
  }, []);

  const runSearch = useCallback(async (season: SeasonKey) => {
    setSearchError(null);
    setPendingSeason(season);
    try {
      const result = await api<DiscoverResult>('/api/mobile/village/search', {
        method: 'POST',
        body: JSON.stringify({ season }),
        // A season search re-runs discovery (an LLM agent call) — far slower than
        // the 15s default, so a working search must not be aborted early.
        timeoutMs: 120_000,
      });
      const outcome = searchOutcomeFromResult(season, result);
      if (outcome.kind === 'search') setActiveSeason(outcome.season);
      else setSearchError(outcome.message);
    } catch (e) {
      // A 401 already redirected to sign-in (mirrors useApi); swallow only that.
      if (e instanceof ApiError && e.status === 401) return;
      const err = e as ApiError;
      setSearchError(searchOutcomeFromError(err.status ?? 0, err.message).message);
    } finally {
      setPendingSeason(null);
    }
  }, []);

  return (
    <Screen scroll className="gap-4" refreshControl={useTintedRefresh(refreshing, refresh)}>
      <View className="flex-row items-end justify-between pt-2">
        <AppText variant="display">Village</AppText>
      </View>

      <SeasonSearch
        activeSeason={activeSeason}
        onSearch={runSearch}
        onClear={clearToFeed}
        disabled={pendingSeason !== null}
      />

      {searchError ? (
        <Card className="items-center gap-3 py-6">
          <AppText variant="meta" className="text-center">
            {searchError}
          </AppText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss and go back to your feed"
            hitSlop={8}
            onPress={clearToFeed}
            className="rounded-full border border-rule bg-raised px-4 py-2 active:opacity-70"
          >
            <AppText variant="meta" className="text-ink-2">
              Back to your feed
            </AppText>
          </Pressable>
        </Card>
      ) : null}

      {pendingSeason ? <SearchPending season={pendingSeason} /> : null}

      {!pendingSeason && status === 'loading' ? <LoadingState /> : null}
      {!pendingSeason && status === 'error' ? (
        <ErrorState message={error ?? ''} onRetry={reload} />
      ) : null}
      {!pendingSeason && status === 'ready' && data ? (
        <VillageBody data={data} searchSeason={activeSeason} showFilter={activeSeason === null} />
      ) : null}
    </Screen>
  );
}
