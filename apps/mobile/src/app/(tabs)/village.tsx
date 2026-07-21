import { router } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, Share, TextInput, View } from 'react-native';

import { FamilyAreaSheet } from '@/components/hale/family-area-sheet';
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
import { PROMPT_BAR_ACTION, PROMPT_BAR_CONTAINER, PROMPT_BAR_INPUT } from '@/constants/prompt-bar';
import { ApiError, api } from '@/lib/api-client';
import type {
  MobileVillageAiSearchResponse,
  MobileVillageResponse,
  SavedAreaLabel,
  VillageCandidateView,
} from '@/lib/api-types';
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
  type AiSearchView,
  aiSearchErrorMessage,
  aiSearchViewFrom,
} from '@/lib/village-ai-search';
import { headerLabel, subtitleCopy, villageFeedKey } from '@/lib/village-region';
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
 * run from the season chips under the search bar). The other honest axis — cadence —
 * lives inline as the chip row
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

/** The live location button beside the Village title (handoff Feature 2): a pin, the
 * active area label (the city, or "Near you" when the family has saved none), and a
 * chevron — tapping opens the "Family area" switcher sheet. Coarse only; Hale never
 * keeps an exact address (rule #1). */
function LocationButton({ label, onPress }: { label: string; onPress: () => void }) {
  const pin = useMeadowColor('ink');
  const chevron = useMeadowColor('ink3');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Family area: ${label}. Change area`}
      hitSlop={8}
      onPress={onPress}
      className="flex-row items-center gap-1.5 active:opacity-70"
    >
      <Icon name="map-pin" size={14} color={pin} />
      <AppText variant="meta" className="text-ink" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
        {label}
      </AppText>
      <Icon name="chevron-down" size={12} color={chevron} />
    </Pressable>
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
      className={`min-h-11 items-center justify-center rounded-full border px-4 py-2 active:opacity-80 ${
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
/** Season suggestion chips under the single search bar (prototype: one search field +
 * a scrolling chip row — NOT a second look-alike search field). Tapping a chip runs the
 * season discovery; the active season's chip highlights with a clear affordance. */
function SeasonChips({
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
  const accentIcon = useMeadowColor('accentFill');
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="gap-2 px-0.5"
      keyboardShouldPersistTaps="handled"
    >
      {SEASON_KEYS.map((season) => {
        const active = activeSeason === season;
        return (
          <Pressable
            key={season}
            accessibilityRole="button"
            accessibilityLabel={
              active ? `Clear ${season} activities search` : `Search ${season} activities`
            }
            accessibilityState={{ selected: active, disabled }}
            disabled={disabled}
            onPress={() => (active ? onClear() : onSearch(season))}
            className={`min-h-11 flex-row items-center gap-1.5 rounded-full border px-4 py-2 active:opacity-80 ${
              active ? 'border-accent bg-accent-tint' : 'border-rule bg-card'
            }`}
          >
            <AppText
              variant="meta"
              className={`capitalize ${active ? 'text-ink' : 'text-ink-2'}`}
              style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
            >
              {season}
            </AppText>
            {active ? <Icon name="x" size={13} color={accentIcon} /> : null}
          </Pressable>
        );
      })}
    </ScrollView>
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

/** The natural-language search bar (handoff): a sparkle, a prompt field, and a navy
 * send — or a clear ✕ once a search is showing. Submitting asks Hale in the parent's
 * own words; the interpretation echo + results replace the feed until cleared. */
function VillageAiSearch({
  value,
  onChange,
  onSubmit,
  pending,
  active,
  dirty,
  onClear,
}: {
  value: string;
  onChange: (t: string) => void;
  onSubmit: () => void;
  pending: boolean;
  /** A search/result is showing (a clear is offered). */
  active: boolean;
  /** The prompt differs from the last-searched one — a fresh submit is possible. */
  dirty: boolean;
  onClear: () => void;
}) {
  const placeholderColor = useMeadowColor('ink3');
  const inputColor = useMeadowColor('ink');
  const sparkle = useMeadowColor('brand');
  const sendColor = useMeadowColor('onAccent');
  const clearColor = useMeadowColor('ink3');
  const canSend = value.trim().length > 0 && !pending;
  // Send stays VISIBLE and re-enables the moment the prompt changes, so editing a shown
  // search always has a submit affordance; clear is the secondary control while active.
  const sendEnabled = canSend && (!active || dirty);
  return (
    <View className={`flex-row items-center gap-2 ${PROMPT_BAR_CONTAINER} py-1.5 pl-3 pr-1.5`}>
      <Icon name="sparkles" size={16} color={sparkle} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder="Ask for anything — “toddler swim this fall”"
        placeholderTextColor={placeholderColor}
        accessibilityLabel="Search your village in your own words"
        returnKeyType="search"
        onSubmitEditing={onSubmit}
        editable={!pending}
        style={{ color: inputColor, fontFamily: 'InstrumentSans_400Regular' }}
        className={`flex-1 ${PROMPT_BAR_INPUT}`}
      />
      {active ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          onPress={onClear}
          className="h-10 w-10 items-center justify-center active:opacity-70"
        >
          <Icon name="x" size={18} color={clearColor} />
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Search"
        accessibilityState={{ disabled: !sendEnabled }}
        disabled={!sendEnabled}
        onPress={onSubmit}
        className={`${PROMPT_BAR_ACTION} bg-brand ${sendEnabled ? 'active:opacity-90' : 'opacity-40'}`}
      >
        <Icon name="arrow-up" size={18} color={sendColor} />
      </Pressable>
    </View>
  );
}

/** The "Hale understood: …" echo. Palette law: ink navy only (never blue), with the
 * interpreted terms weight-differentiated from the label. */
function AiInterpretation({ text }: { text: string }) {
  return (
    <AppText variant="meta" className="text-ink-2" accessibilityLiveRegion="polite">
      Hale understood:{' '}
      <AppText
        variant="meta"
        className="text-ink"
        style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
      >
        {text}
      </AppText>
    </AppText>
  );
}

export default function VillageScreen() {
  const [activeSeason, setActiveSeason] = useState<SeasonKey | null>(null);
  const [pendingSeason, setPendingSeason] = useState<SeasonKey | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [aiPrompt, setAiPrompt] = useState('');
  const [aiView, setAiView] = useState<AiSearchView | null>(null);
  const [aiPending, setAiPending] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  /** The prompt the current AI result is for — drives the send/clear affordance and the
   * AI-mode pull-to-refresh (which re-runs THIS search, not the hidden feed). */
  const [lastSearched, setLastSearched] = useState('');

  const [sheetOpen, setSheetOpen] = useState(false);
  const [area, setArea] = useState<SavedAreaLabel | null>(null);

  const readPath = activeSeason ? searchReadPath(activeSeason) : STANDING_PATH;
  const { status, data, error, refreshing, reload, refresh } =
    useApi<MobileVillageResponse>(readPath, { refetchOnFocus: true });

  // Hold the active-area label from the standing feed. The season/childcare sub-reads
  // omit `area`, so only update when the key is present — the header then stays put
  // during a season search rather than flipping to "Near you".
  useEffect(() => {
    if (data && data.area !== undefined) setArea(data.area);
  }, [data]);

  const clearToFeed = useCallback(() => {
    setActiveSeason(null);
    setPendingSeason(null);
    setSearchError(null);
  }, []);

  const clearAiSearch = useCallback(() => {
    setAiView(null);
    setAiError(null);
    setAiPrompt('');
    setLastSearched('');
  }, []);

  // Stable so RecCard's memo holds — opens the shared Activity route by candidate id.
  const openActivity = useCallback((rec: VillageCandidateView) => router.push(`/activity/${rec.id}`), []);

  const runAiSearch = useCallback(
    async (promptArg?: string) => {
      const prompt = (promptArg ?? aiPrompt).trim();
      if (!prompt || aiPending) return;
      setAiPending(true);
      setAiError(null);
      setLastSearched(prompt);
      // AI search takes over the body — clear any season search underneath it.
      setActiveSeason(null);
      setSearchError(null);
      try {
        const res = await api<MobileVillageAiSearchResponse>('/api/mobile/village/ai-search', {
          method: 'POST',
          body: JSON.stringify({ prompt }),
          // The intent parse (and a possible discovery kick) is an LLM call — far slower
          // than the 15s default, so a working search must not be aborted early.
          timeoutMs: 120_000,
        });
        setAiView(aiSearchViewFrom(res));
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return;
        setAiError(aiSearchErrorMessage(e instanceof ApiError ? e.status : 0));
      } finally {
        setAiPending(false);
      }
    },
    [aiPrompt, aiPending],
  );

  // The active area changed in the switcher — re-query the feed so it reflects the new
  // area. A season search or an AI search is cleared back to the standing feed (their
  // stored runs were for the old area); on the standing feed we force a re-read in place.
  const onAreaChanged = useCallback(() => {
    clearAiSearch();
    if (activeSeason) clearToFeed();
    else refresh();
  }, [activeSeason, clearToFeed, clearAiSearch, refresh]);

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

  // In AI mode, pull-to-refresh re-runs the SHOWN search (not the hidden standing feed —
  // that gesture would spin with no visible effect); on the feed it refetches as usual.
  const inAiMode = aiPending || aiView !== null || aiError !== null;
  const refreshControl = useTintedRefresh(
    inAiMode ? aiPending : refreshing,
    inAiMode ? () => void runAiSearch(lastSearched) : refresh,
  );

  return (
    <Screen scroll className="gap-4" refreshControl={refreshControl}>
      <View className="pt-2">
        <View className="flex-row items-center justify-between">
          <AppText variant="display">Village</AppText>
          <LocationButton label={headerLabel(area)} onPress={() => setSheetOpen(true)} />
        </View>
        <AppText variant="meta" className="mt-0.5 text-ink-3">
          {subtitleCopy(area)}
        </AppText>
      </View>

      <VillageAiSearch
        value={aiPrompt}
        onChange={setAiPrompt}
        onSubmit={runAiSearch}
        pending={aiPending}
        active={aiView !== null || aiError !== null}
        dirty={aiPrompt.trim() !== lastSearched}
        onClear={clearAiSearch}
      />

      {aiPending || aiView !== null || aiError !== null ? (
        // AI-search mode: the interpretation echo + real results replace the feed until
        // cleared (the ✕ in the bar, or an area switch, resets it).
        aiPending ? (
          <Card className="items-center gap-3 py-8">
            <TypingDots />
            <AppText variant="meta" className="text-ink-3" accessibilityLiveRegion="polite">
              Searching your village…
            </AppText>
          </Card>
        ) : aiError ? (
          <Card className="items-center gap-3 py-6">
            <AppText variant="meta" className="text-center" accessibilityLiveRegion="polite">
              {aiError}
            </AppText>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Back to your feed"
              hitSlop={8}
              onPress={clearAiSearch}
              className="rounded-full border border-rule bg-raised px-4 py-2 active:opacity-70"
            >
              <AppText variant="meta" className="text-ink-2">
                Back to your feed
              </AppText>
            </Pressable>
          </Card>
        ) : aiView ? (
          <>
            <AiInterpretation text={aiView.interpretation} />
            {aiView.kind === 'results' ? (
              <View className="gap-3">
                {aiView.results.map((rec) => (
                  <RecCard key={rec.id} rec={rec} onOpen={openActivity} onChanged={refresh} />
                ))}
              </View>
            ) : (
              <Card className="items-center gap-2 py-8">
                <AppText variant="title" accessibilityLiveRegion="polite">
                  {aiView.kind === 'out-looking' ? 'Hale is out looking' : 'No specific matches'}
                </AppText>
                <AppText variant="meta" className="text-center">
                  {aiView.kind === 'out-looking'
                    ? 'Nothing in your village matched yet — Hale kicked off a fresh search. Check back in a moment.'
                    : 'Nothing matched that yet. Try different words, or clear the search to browse your feed.'}
                </AppText>
              </Card>
            )}
          </>
        ) : null
      ) : (
        <>
          <SeasonChips
            activeSeason={activeSeason}
            onSearch={runSearch}
            onClear={clearToFeed}
            disabled={pendingSeason !== null}
          />

          {searchError ? (
            <Card className="items-center gap-3 py-6">
              <AppText variant="meta" className="text-center" accessibilityLiveRegion="polite">
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
            // Key on the active area so switching cities REMOUNTS the body — resetting
            // its filters (a filter set for one city must not persist to another).
            <VillageBody
              key={villageFeedKey(area)}
              data={data}
              searchSeason={activeSeason}
              showFilter={activeSeason === null}
              onRefresh={refresh}
            />
          ) : null}
        </>
      )}

      <FamilyAreaSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onAreaChanged={onAreaChanged}
      />
    </Screen>
  );
}
