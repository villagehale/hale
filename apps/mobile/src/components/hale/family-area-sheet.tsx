import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, TextInput, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { useMeadowColor } from '@/constants/meadow';
import { ApiError, api } from '@/lib/api-client';
import type {
  CityCandidate,
  MobileVillageAreaSearchResponse,
  MobileVillageAreasResponse,
  SavedArea,
} from '@/lib/api-types';
import { resolveCoarseLocation } from '@/lib/current-location';
import {
  areaSubtitle,
  candidateSubtitle,
  filterSearchResults,
  regionMode,
  sameArea,
  shouldSearch,
} from '@/lib/village-region';

const AREAS_PATH = '/api/mobile/village/areas';
const AREAS_SEARCH_PATH = '/api/mobile/village/areas/search';
/** Wait this long after the last keystroke before hitting the search endpoint, so
 * typing "markham" fires one request, not seven. */
const SEARCH_DEBOUNCE_MS = 250;

const EMPTY_AREAS: SavedArea[] = [];

/** An honest note for a failed area write. A 409 is the saved-areas cap (retrying
 * won't help — there is no in-app remove yet), so it gets its own line rather than a
 * misleading "try again". */
function selectionErrorNote(e: unknown): string {
  if (e instanceof ApiError && e.status === 409) {
    return "You've saved the most areas Hale keeps.";
  }
  return "Couldn't update your area — try again.";
}

type ListState =
  | { status: 'loading' }
  | { status: 'ready'; areas: SavedArea[]; activeAreaId: string | null }
  | { status: 'error' };

/** A single list row — a pin, a name over an optional sub-line, and an optional
 * trailing check (the active saved area). Shared by "Your areas" and "Search
 * results" so both rows read identically. */
function AreaRow({
  name,
  sub,
  active,
  last,
  disabled,
  accessibilityLabel,
  onPress,
}: {
  name: string;
  sub: string | null;
  active?: boolean;
  last: boolean;
  disabled: boolean;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  const pin = useMeadowColor('ink3');
  const check = useMeadowColor('success');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: active, disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`flex-row items-center gap-2.5 px-4 py-3.5 ${last ? '' : 'border-b border-hairline'} ${
        active ? 'bg-canvas' : ''
      } active:opacity-70`}
    >
      <Icon name="map-pin" size={15} color={pin} />
      <View className="flex-1">
        <AppText className="text-[14px] text-ink" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
          {name}
        </AppText>
        {sub ? (
          <AppText variant="meta" className="text-caption">
            {sub}
          </AppText>
        ) : null}
      </View>
      {active ? <Icon name="check" size={15} color={check} /> : null}
    </Pressable>
  );
}

/**
 * The "Family area" bottom sheet (handoff Feature 2). Composes the shared Sheet
 * shell. Browsing (empty query) lists the family's saved coarse areas — the active
 * one carries a check — plus "Use my current location"; typing switches to a
 * debounced city search (saved areas excluded, capped). Selecting any area writes
 * through the SAME add/setActive endpoints, then re-reads the list and asks the
 * Village screen to re-query its feed (onAreaChanged). Coarse only — the server
 * never sees coordinates (rule #1); "Use my current location" resolves on-device
 * (see resolveCoarseLocation).
 */
export function FamilyAreaSheet({
  visible,
  onClose,
  onAreaChanged,
}: {
  visible: boolean;
  onClose: () => void;
  /** Re-query the Village feed + header after the active area changes. */
  onAreaChanged: () => void;
}) {
  const [query, setQuery] = useState('');
  const [listState, setListState] = useState<ListState>({ status: 'loading' });
  /** null = no search run yet (query below the min length); [] = searched, no match. */
  const [results, setResults] = useState<CityCandidate[] | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const searchIcon = useMeadowColor('ink3');
  const placeholderColor = useMeadowColor('ink3');
  const inputColor = useMeadowColor('ink');
  const spinner = useMeadowColor('ink3');
  const brandIcon = useMeadowColor('brand');

  const loadList = useCallback(async () => {
    setListState({ status: 'loading' });
    try {
      const res = await api<MobileVillageAreasResponse>(AREAS_PATH);
      setListState({ status: 'ready', areas: res.areas, activeAreaId: res.activeAreaId });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setListState({ status: 'error' });
    }
  }, []);

  // Re-read the list (and reset transient state) each time the sheet opens.
  useEffect(() => {
    if (!visible) return;
    setQuery('');
    setResults(null);
    setNote(null);
    loadList();
  }, [visible, loadList]);

  const savedAreas = listState.status === 'ready' ? listState.areas : EMPTY_AREAS;

  // Debounced city search. Below the min length there is no run (results stays null);
  // at or above it, one request fires after the pause and the saved areas are excluded
  // from the candidates.
  useEffect(() => {
    if (!shouldSearch(query)) {
      setResults(null);
      setSearchBusy(false);
      return;
    }
    const q = query.trim();
    let live = true;
    setSearchBusy(true);
    const handle = setTimeout(async () => {
      try {
        const res = await api<MobileVillageAreaSearchResponse>(
          `${AREAS_SEARCH_PATH}?q=${encodeURIComponent(q)}`,
        );
        if (live) setResults(filterSearchResults(res.cities, savedAreas));
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return;
        // A search miss/transport error reads as "no match", never a swallowed crash.
        if (live) setResults([]);
      } finally {
        if (live) setSearchBusy(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(handle);
    };
  }, [query, savedAreas]);

  const refreshAfterSelect = useCallback(async () => {
    setQuery('');
    setResults(null);
    await loadList();
    onAreaChanged();
  }, [loadList, onAreaChanged]);

  // add a coarse area then make it active (add saves INACTIVE, so activation is a
  // second call — unless the area already exists and is already the active one).
  const addAndActivate = useCallback(
    async (city: string, province: string | null) => {
      const afterAdd = await api<MobileVillageAreasResponse>(AREAS_PATH, {
        method: 'POST',
        body: JSON.stringify({ action: 'add', city, province: province ?? undefined }),
      });
      const match = afterAdd.areas.find((a) => sameArea(a, city, province));
      if (match && afterAdd.activeAreaId !== match.id) {
        await api(AREAS_PATH, {
          method: 'POST',
          body: JSON.stringify({ action: 'setActive', areaId: match.id }),
        });
      }
    },
    [],
  );

  const applySelection = useCallback(
    async (mutate: () => Promise<void>) => {
      if (busy) return;
      setBusy(true);
      setNote(null);
      try {
        await mutate();
        await refreshAfterSelect();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return;
        setNote(selectionErrorNote(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, refreshAfterSelect],
  );

  const selectSaved = useCallback(
    (area: SavedArea) =>
      applySelection(async () => {
        if (area.isActive) return;
        await api(AREAS_PATH, {
          method: 'POST',
          body: JSON.stringify({ action: 'setActive', areaId: area.id }),
        });
      }),
    [applySelection],
  );

  const selectResult = useCallback(
    (candidate: CityCandidate) =>
      applySelection(() => addAndActivate(candidate.city, candidate.province)),
    [applySelection, addAndActivate],
  );

  const useCurrent = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const resolved = await resolveCoarseLocation();
      if (resolved.status === 'denied') {
        setNote('Location permission is off — search for your city instead.');
        return;
      }
      if (resolved.status === 'unavailable') {
        setNote("We couldn't find your area — search for your city instead.");
        return;
      }
      await addAndActivate(resolved.place.city, resolved.place.province);
      await refreshAfterSelect();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setNote(selectionErrorNote(e));
    } finally {
      setBusy(false);
    }
  }, [busy, addAndActivate, refreshAfterSelect]);

  const mode = regionMode(query);

  return (
    <Sheet visible={visible} onClose={onClose} title="Family area">
      <AppText variant="body" className="mb-3 text-ink-3">
        Village activities, care and resources follow this area.
      </AppText>

      <View className="mb-3.5 flex-row items-center gap-2 rounded-[13px] border border-rule bg-chip-gray px-3.5 py-3">
        <Icon name="search" size={15} color={searchIcon} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Move to a new city or area…"
          placeholderTextColor={placeholderColor}
          autoCorrect={false}
          autoCapitalize="words"
          accessibilityLabel="Search for a city or area"
          style={{ color: inputColor, fontFamily: 'InstrumentSans_400Regular' }}
          className="flex-1 text-[14px]"
        />
      </View>

      {mode === 'searching' ? (
        <SearchResults
          query={query.trim()}
          results={results}
          searchBusy={searchBusy}
          busy={busy}
          spinner={spinner}
          onSelect={selectResult}
        />
      ) : (
        <YourAreas
          listState={listState}
          busy={busy}
          brandIcon={brandIcon}
          onSelect={selectSaved}
          onRetry={loadList}
          onUseCurrent={useCurrent}
        />
      )}

      {note ? (
        <AppText variant="meta" className="mt-3 text-ink-3" accessibilityLiveRegion="polite">
          {note}
        </AppText>
      ) : null}
    </Sheet>
  );
}

function SearchResults({
  query,
  results,
  searchBusy,
  busy,
  spinner,
  onSelect,
}: {
  query: string;
  results: CityCandidate[] | null;
  searchBusy: boolean;
  busy: boolean;
  spinner: string;
  onSelect: (candidate: CityCandidate) => void;
}) {
  return (
    <>
      <AppText variant="eyebrow" className="mb-2">
        Search results
      </AppText>
      {!shouldSearch(query) ? (
        <AppText variant="meta" className="text-ink-3">
          Type at least 2 letters to search.
        </AppText>
      ) : results === null || searchBusy ? (
        <View className="flex-row items-center gap-2 py-1">
          <ActivityIndicator size="small" color={spinner} />
          <AppText variant="meta" className="text-ink-3">
            Searching…
          </AppText>
        </View>
      ) : results.length === 0 ? (
        <AppText variant="meta" className="text-ink-3">
          No match for “{query}”. Try a nearby city.
        </AppText>
      ) : (
        <View className="overflow-hidden rounded-[16px] border border-rule">
          {results.map((candidate, i) => (
            <AreaRow
              key={`${candidate.city}|${candidate.province ?? ''}`}
              name={candidate.city}
              sub={candidateSubtitle(candidate)}
              last={i === results.length - 1}
              disabled={busy}
              accessibilityLabel={`Move to ${candidate.city}${
                candidate.province ? `, ${candidate.province}` : ''
              }`}
              onPress={() => onSelect(candidate)}
            />
          ))}
        </View>
      )}
    </>
  );
}

function YourAreas({
  listState,
  busy,
  brandIcon,
  onSelect,
  onRetry,
  onUseCurrent,
}: {
  listState: ListState;
  busy: boolean;
  brandIcon: string;
  onSelect: (area: SavedArea) => void;
  onRetry: () => void;
  onUseCurrent: () => void;
}) {
  return (
    <>
      {listState.status === 'loading' ? (
        <AppText variant="meta" className="text-ink-3">
          Loading your areas…
        </AppText>
      ) : listState.status === 'error' ? (
        <View className="gap-2">
          <AppText variant="meta" className="text-ink-3">
            Couldn't load your areas.
          </AppText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry loading your areas"
            hitSlop={8}
            onPress={onRetry}
            className="self-start rounded-full border border-rule bg-raised px-4 py-2 active:opacity-70"
          >
            <AppText variant="meta" className="text-ink-2">
              Try again
            </AppText>
          </Pressable>
        </View>
      ) : listState.areas.length > 0 ? (
        <>
          <AppText variant="eyebrow" className="mb-2">
            Your areas
          </AppText>
          <View className="overflow-hidden rounded-[16px] border border-rule">
            {listState.areas.map((area, i) => (
              <AreaRow
                key={area.id}
                name={area.city}
                sub={areaSubtitle(area)}
                active={area.id === listState.activeAreaId}
                last={i === listState.areas.length - 1}
                disabled={busy}
                accessibilityLabel={`${
                  area.id === listState.activeAreaId ? 'Active area' : 'Switch to'
                } ${area.city}`}
                onPress={() => onSelect(area)}
              />
            ))}
          </View>
        </>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Use my current location"
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        onPress={onUseCurrent}
        className={`mt-3 min-h-12 flex-row items-center justify-center gap-2 rounded-[14px] border border-rule bg-card ${
          busy ? 'opacity-50' : 'active:opacity-80'
        }`}
      >
        <Icon name="crosshair" size={15} color={brandIcon} />
        <AppText variant="meta" className="text-brand" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
          Use my current location
        </AppText>
      </Pressable>
    </>
  );
}
