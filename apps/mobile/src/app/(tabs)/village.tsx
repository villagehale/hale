import { router } from 'expo-router';
import { memo, useCallback, useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, Share, View } from 'react-native';

import { ResourcesRail } from '@/components/hale/resources-rail';
import { TypingDots } from '@/components/hale/typing-dots';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { useTintedRefresh } from '@/components/ui/pull-refresh';
import { Screen } from '@/components/ui/screen';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { Sheet } from '@/components/ui/sheet';
import { Tag } from '@/components/ui/tag';
import { TintChip } from '@/components/ui/tint-chip';
import { useMeadowColor } from '@/constants/meadow';
import { ApiError, api } from '@/lib/api-client';
import type { MobileVillageResponse, VillageCandidateView } from '@/lib/api-types';
import { foundStamp } from '@/lib/format';
import { STUB_CHILDCARE, type StubChildcareProvider } from '@/lib/stub-data';
import { useApi } from '@/lib/use-api';
import {
  CADENCE_OPTIONS,
  type CadenceFilter,
  SEASON_FILTER_KEYS,
  type SeasonFilterKey,
  applyFilters,
  cadenceChip,
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

/** A selectable pill (a filter chip) inside the Filters sheet. */
function FilterChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Filter: ${label}`}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      className={`min-h-11 items-center justify-center rounded-full border px-4 py-2.5 ${
        active ? 'border-ink bg-ink' : 'border-rule bg-card'
      }`}
    >
      <AppText variant="meta" className={`capitalize ${active ? 'text-on-ink' : 'text-ink-2'}`}>
        {label}
      </AppText>
    </Pressable>
  );
}

/**
 * The Filters sheet: season chips that narrow the ALREADY-LOADED feed client-side
 * (no request, no new location signal — rule #1). This is the loaded-feed SEASON
 * filter, kept deliberately distinct from the season SEARCH (a separate LLM discovery
 * run in SeasonSearch). The other honest axis — cadence — lives inline as the chip row
 * (the handoff's primary filter chips), so the sheet holds only seasons. Kind is a
 * single hardcoded value today and distance has no family centroid, so both are
 * omitted rather than faked. Selections are staged locally and applied on "Show N
 * results", so the count reflects the pending choice (against the applied cadence)
 * before the sheet closes.
 */
function FiltersSheet({
  visible,
  onClose,
  cadence,
  seasons,
  resultCountFor,
  onApply,
}: {
  visible: boolean;
  onClose: () => void;
  cadence: CadenceFilter;
  seasons: ReadonlySet<SeasonFilterKey>;
  resultCountFor: (cadence: CadenceFilter, seasons: ReadonlySet<SeasonFilterKey>) => number;
  onApply: (seasons: ReadonlySet<SeasonFilterKey>) => void;
}) {
  const [draftSeasons, setDraftSeasons] = useState<Set<SeasonFilterKey>>(new Set(seasons));

  // Re-seed the draft from the applied filter each time the sheet opens.
  const seed = () => setDraftSeasons(new Set(seasons));

  const toggleSeason = (s: SeasonFilterKey) => {
    setDraftSeasons((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  const count = resultCountFor(cadence, draftSeasons);
  const anyActive = draftSeasons.size > 0;

  return (
    <Sheet
      visible={visible}
      onClose={() => {
        // Discard an unapplied draft on dismiss — the applied filter stands.
        seed();
        onClose();
      }}
    >
      <View className="mb-4 flex-row items-center justify-between">
        <AppText variant="title">Filters</AppText>
        {anyActive ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear season filters"
            hitSlop={8}
            onPress={() => setDraftSeasons(new Set())}
            className="active:opacity-70"
          >
            <AppText variant="meta" className="text-accent">
              Clear all
            </AppText>
          </Pressable>
        ) : null}
      </View>

      <AppText variant="eyebrow" className="mb-2">
        Season
      </AppText>
      <View className="mb-6 flex-row flex-wrap gap-2">
        {SEASON_FILTER_KEYS.map((season) => (
          <FilterChip
            key={season}
            label={season}
            active={draftSeasons.has(season)}
            onPress={() => toggleSeason(season)}
          />
        ))}
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Show ${count} result${count === 1 ? '' : 's'}`}
        onPress={() => {
          onApply(draftSeasons);
          onClose();
        }}
        className="min-h-12 items-center justify-center rounded-full bg-ink px-4 active:opacity-80"
      >
        <AppText variant="meta" className="text-on-ink">
          Show {count} result{count === 1 ? '' : 's'}
        </AppText>
      </Pressable>
    </Sheet>
  );
}

/** A location chip beside the Village title (handoff). Static — Hale keeps only a
 * coarse area (never an exact address), and there is no area picker, so this reads
 * "Near you" without a chevron rather than implying a selector that doesn't exist. */
function LocationChip() {
  const pin = useMeadowColor('ink2');
  return (
    <View className="flex-row items-center gap-1.5">
      <Icon name="map-pin" size={14} color={pin} />
      <AppText variant="meta" className="text-ink" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
        Near you
      </AppText>
    </View>
  );
}

/** One cadence filter pill in the inline chip row (handoff's primary filter chips):
 * navy fill when active, quiet card otherwise. Labels are the real cadence model. */
function CadencePill({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Filter: ${label}`}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      className={`rounded-full border px-4 py-2 active:opacity-80 ${
        active ? 'border-brand bg-brand' : 'border-rule bg-card'
      }`}
    >
      <AppText variant="meta" className={`capitalize ${active ? 'text-on-ink' : 'text-ink-2'}`}>
        {label}
      </AppText>
    </Pressable>
  );
}

/** The inline filter row: a Filters (season) button + the cadence pills, one
 * horizontal scroll, matching the handoff's chip row. The button carries a count
 * badge when a season filter is active. */
function FilterRow({
  cadence,
  seasonCount,
  onSetCadence,
  onOpenFilters,
}: {
  cadence: CadenceFilter;
  seasonCount: number;
  onSetCadence: (c: CadenceFilter) => void;
  onOpenFilters: () => void;
}) {
  const sliders = useMeadowColor('ink2');
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="gap-2 pr-5"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={seasonCount > 0 ? `Filters, ${seasonCount} active` : 'Filters'}
        onPress={onOpenFilters}
        className="flex-row items-center gap-1.5 rounded-full border border-rule bg-card px-3.5 py-2 active:opacity-80"
      >
        <Icon name="sliders-horizontal" size={15} color={sliders} />
        {seasonCount > 0 ? (
          <View className="h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5">
            <AppText variant="meta" className="text-[11px] leading-none text-on-ink">
              {seasonCount}
            </AppText>
          </View>
        ) : null}
      </Pressable>
      {CADENCE_OPTIONS.map((option) => (
        <CadencePill
          key={option.value}
          label={option.label}
          active={cadence === option.value}
          onPress={() => onSetCadence(option.value)}
        />
      ))}
    </ScrollView>
  );
}

/** A childcare capacity badge — the prototype's Accepting / Waitlist stamp, mapped to
 * the design's Tag tones (done = green accepting, accent = amber waitlist). */
function ChildcareBadge({ status }: { status: StubChildcareProvider['status'] }) {
  return status === 'accepting' ? (
    <Tag label="Accepting" tone="done" />
  ) : (
    <Tag label="Waitlist" tone="accent" />
  );
}

/**
 * The "Childcare near you" section (handoff). STUB: Hale has no childcare directory or
 * live-capacity feed, so these are SAMPLE listings from stub-data — disclosed by the
 * caveat line, and carrying no fabricated distances/ratings. The rows are inert (no
 * dead links to detail pages that don't exist); only the Accepting/Waitlist badge and
 * provider kind are shown.
 */
function ChildcareSection() {
  return (
    <View className="gap-2.5">
      <AppText variant="eyebrow">Childcare near you</AppText>
      <View className="overflow-hidden rounded-[20px] border border-rule bg-card">
        {STUB_CHILDCARE.map((provider, i) => (
          <View
            key={provider.name}
            className={`flex-row items-center gap-3 px-4 py-3.5 ${
              i === STUB_CHILDCARE.length - 1 ? '' : 'border-b border-hairline'
            }`}
          >
            <View className="flex-1">
              <AppText
                className="text-[14px] text-ink"
                style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
              >
                {provider.name}
              </AppText>
              <AppText variant="meta" className="text-caption">
                {provider.kind}
              </AppText>
            </View>
            <ChildcareBadge status={provider.status} />
          </View>
        ))}
      </View>
      <AppText variant="meta" className="text-caption">
        Sample listings — Hale&rsquo;s live childcare search is coming.
      </AppText>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="View all childcare options"
        onPress={() => router.push('/childcare')}
        className="min-h-12 flex-row items-center justify-center gap-2 rounded-[14px] border border-rule bg-card active:opacity-80"
      >
        <AppText variant="meta" className="text-ink" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
          View all childcare options
        </AppText>
      </Pressable>
    </View>
  );
}

/** A quiet directory link to the Government Benefits page (handoff's Resources →
 * Government Benefits row). Kept on the standing feed only, beside the childcare and
 * resources directories it belongs with. */
function BenefitsLink() {
  const chevron = useMeadowColor('ink3');
  return (
    <Card onPress={() => router.push('/benefits')} className="flex-row items-center gap-3">
      <TintChip icon="credit-card" tone="yellow" />
      <View className="flex-1">
        <AppText className="text-[14px] text-ink" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
          Government Benefits
        </AppText>
        <AppText variant="meta" className="text-caption">
          Programs your family may qualify for
        </AppText>
      </View>
      <Icon name="chevron-right" size={15} color={chevron} />
    </Card>
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
        <Icon name="search" size={15} color={accentIcon} />
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
          <Icon name="circle-x" size={18} color={iconColor} />
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
        <Icon name="search" size={16} color={iconColor} />
        <AppText variant="body" className="flex-1 text-ink-3">
          Search activities by season
        </AppText>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={13} color={iconColor} />
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

/** Maps a failed share-link mint to an honest, parent-facing line (mirrors web
 * shareErrorMessage). A 401 never lands here — api() redirects to sign-in. */
function shareErrorMessage(status: number): string {
  if (status === 404) return 'Nothing to share here yet.';
  if (status === 403 || status === 501) return "Sharing isn't available for this one.";
  return "Couldn't make a link just now — try again in a moment.";
}

function ShareRow({ shareHref }: { shareHref: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const iconColor = useMeadowColor('ink2');

  const onShare = async () => {
    setBusy(true);
    setError(null);
    let link: string;
    try {
      ({ link } = await api<{ link: string }>(shareHref, { method: 'POST' }));
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError(shareErrorMessage(e instanceof ApiError ? e.status : 0));
      }
      setBusy(false);
      return;
    }
    try {
      await Share.share(Platform.OS === 'ios' ? { url: link } : { message: link });
    } catch {
      // The mint succeeded — only the native sheet failed, so say that.
      setError("Couldn't open the share sheet — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View className="mt-1 gap-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Share this activity"
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        onPress={onShare}
        className={`min-h-11 flex-row items-center gap-2 self-start rounded-full border border-rule bg-raised px-4 py-2.5 ${
          busy ? 'opacity-50' : 'active:opacity-80'
        }`}
      >
        <Icon name="share" size={15} color={iconColor} />
        <AppText variant="meta" className="text-ink-2">
          {busy ? 'Making a link…' : 'Share'}
        </AppText>
      </Pressable>
      {error ? (
        <AppText variant="meta" className="text-berry" accessibilityLiveRegion="polite">
          {error}
        </AppText>
      ) : null}
    </View>
  );
}

/** A compact private-save (bookmark) toggle for the RecCard. The save is PRIVATE
 * and low-commitment — it neither enrolls nor sends for approval (rule #4), so it
 * reads as a bookmark, never as Accept. Optimistic: the tapped state wins over the
 * server's until the feed refreshes. A 401 is swallowed (api() redirects). */
function SaveToggle({ rec, onChanged }: { rec: VillageCandidateView; onChanged: () => void }) {
  const [saved, setSaved] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const inkIcon = useMeadowColor('ink2');
  const accentIcon = useMeadowColor('accentFill');
  const isSaved = saved ?? rec.saved;

  const toggle = async () => {
    setBusy(true);
    try {
      const { saved: nowSaved } = await api<{ saved: boolean }>(rec.saveHref, { method: 'POST' });
      setSaved(nowSaved);
      onChanged();
    } catch (e) {
      // A 401 already redirected to sign-in; any other error just leaves the state.
      if (e instanceof ApiError && e.status === 401) return;
    } finally {
      setBusy(false);
    }
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={isSaved ? `Saved ${rec.title}` : `Save ${rec.title} — I'm interested`}
      accessibilityState={{ selected: isSaved, disabled: busy }}
      disabled={busy}
      hitSlop={8}
      onPress={toggle}
      className={busy ? 'opacity-50' : 'active:opacity-70'}
    >
      <Icon
        name={isSaved ? 'bookmark-check' : 'bookmark'}
        size={18}
        color={isSaved ? accentIcon : inkIcon}
      />
    </Pressable>
  );
}

const RecCard = memo(function RecCard({
  rec,
  onOpen,
  onChanged,
}: {
  rec: VillageCandidateView;
  onOpen: (rec: VillageCandidateView) => void;
  onChanged: () => void;
}) {
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
      {/* The bookmark sits OUTSIDE the body Pressable so tapping "save" doesn't also
          open the sheet. The body opens the detail sheet (accept / endorse / share /
          maps); the inline ShareRow below stays as the untouched one-tap share. */}
      <View className="flex-row items-start justify-between gap-3">
        <AppText variant="title" className="flex-1">
          {rec.title}
        </AppText>
        <View className="flex-row items-center gap-2">
          <Tag label={rec.kind} tone="coach" />
          <SaveToggle rec={rec} onChanged={onChanged} />
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${rec.title}`}
        onPress={() => onOpen(rec)}
        className="gap-2 active:opacity-80"
      >
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
          <AppText variant="meta" className="mt-1 self-start text-ink-3">
            Sent for your approval
          </AppText>
        ) : null}
      </Pressable>
      <ShareRow shareHref={rec.shareHref} />
    </Card>
  );
});

function VillageBody({
  data,
  searchSeason,
  showFilter,
  onRefresh,
}: {
  data: MobileVillageResponse;
  searchSeason: SeasonKey | null;
  showFilter: boolean;
  onRefresh: () => void;
}) {
  const [cadence, setCadence] = useState<CadenceFilter>('all');
  const [seasons, setSeasons] = useState<Set<SeasonFilterKey>>(new Set());
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Stable so RecCard's memo holds — pushes the shared Activity route by candidate id.
  const openActivity = useCallback(
    (rec: VillageCandidateView) => router.push(`/activity/${rec.id}`),
    [],
  );
  const recs = useMemo(
    () => applyFilters(data.candidates, cadence, seasons),
    [data.candidates, cadence, seasons],
  );
  const hasAny = data.candidates.length > 0;

  const resultCountFor = useCallback(
    (c: CadenceFilter, s: ReadonlySet<SeasonFilterKey>) => applyFilters(data.candidates, c, s).length,
    [data.candidates],
  );

  return (
    <>
      {hasAny && showFilter ? (
        <FilterRow
          cadence={cadence}
          seasonCount={seasons.size}
          onSetCadence={setCadence}
          onOpenFilters={() => setFiltersOpen(true)}
        />
      ) : null}

      {recs.length === 0 ? (
        <Card className="mt-2 items-center gap-2 py-8">
          <AppText variant="title">
            {hasAny
              ? 'Nothing in these filters'
              : searchSeason
                ? 'No matches yet'
                : 'Fresh picks coming'}
          </AppText>
          <AppText variant="meta" className="text-center">
            {hasAny
              ? 'No activities match these filters right now — try clearing them.'
              : searchSeason
                ? `No ${searchSeason} activities found near you yet.`
                : 'Your village refreshes with current, in-season activities. Check back soon.'}
          </AppText>
        </Card>
      ) : (
        <View className="gap-3">
          {recs.map((rec) => (
            <RecCard key={rec.id} rec={rec} onOpen={openActivity} onChanged={onRefresh} />
          ))}
        </View>
      )}

      <FiltersSheet
        visible={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        cadence={cadence}
        seasons={seasons}
        resultCountFor={resultCountFor}
        onApply={(s) => setSeasons(new Set(s))}
      />

      {/* Childcare + Resources are directory-style reference content — they belong on
          the standing feed only (not a season search). Childcare is a disclosed stub;
          the server only sends `resources` on the standing read. */}
      {searchSeason === null ? <ChildcareSection /> : null}
      {searchSeason === null ? <ResourcesRail resources={data.resources} /> : null}
      {searchSeason === null ? <BenefitsLink /> : null}

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
    useApi<MobileVillageResponse>(readPath, { refetchOnFocus: true });

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
      <View className="pt-2">
        <View className="flex-row items-center justify-between">
          <AppText variant="display">Village</AppText>
          <LocationChip />
        </View>
        <AppText variant="meta" className="mt-0.5 text-ink-3">
          Find support, activities &amp; resources near you.
        </AppText>
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
        <VillageBody
          data={data}
          searchSeason={activeSeason}
          showFilter={activeSeason === null}
          onRefresh={refresh}
        />
      ) : null}
    </Screen>
  );
}
