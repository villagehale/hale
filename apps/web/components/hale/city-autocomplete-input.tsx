'use client';

import { MapPin } from 'lucide-react';
import { type KeyboardEvent, type MouseEvent, useEffect, useId, useRef, useState } from 'react';
import { autocompleteCityAction, resolveCityAction } from '~/lib/onboarding/city-search';
import type { CityCentroid, CityPrediction } from '~/lib/village/geocode';

/**
 * The onboarding step-4 city search: a Google-Maps-style fuzzy typeahead built as an
 * ARIA combobox (design handoff §4.1 Ob4 + brief). Debounced Places Autocomplete
 * predictions drop down under the input; ArrowUp/Down move the active option and
 * Enter selects it (aria-activedescendant, so focus never leaves the input — it stays
 * the primary control). Selecting resolves the city's centroid (Place Details) on the
 * SAME session token, so autocomplete + details bill as one session, and hands the
 * coarse {city, province, centroid} up for the map + the persisted area.
 *
 * Privacy (rule #1): only the coarse city text leaves the client; the centroid is used
 * to centre a city-level map and is never persisted. Honest states: a provider miss →
 * "no match", the paid-provider cap → "searching too fast" (never a silent dead box).
 */

const DEBOUNCE_MS = 280;
const MIN_CHARS = 2;

function cityLabel(city: string, province: string | null): string {
  return province ? `${city}, ${province}` : city;
}

export function CityAutocompleteInput({
  value,
  inputId,
  onValueChange,
  onSelect,
}: {
  value: string;
  inputId: string;
  onValueChange: (value: string) => void;
  onSelect: (centroid: CityCentroid) => void;
}) {
  const [predictions, setPredictions] = useState<CityPrediction[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [limited, setLimited] = useState(false);
  const [noMatch, setNoMatch] = useState(false);
  const listId = useId();
  // One session token per search session (start of typing → selection); reset after a
  // selection so the next search opens a fresh billed session.
  const sessionRef = useRef<string | null>(null);
  // Skip the fetch the controlled-value change would trigger right after a selection.
  const skipNextFetch = useRef(false);

  function sessionToken(): string {
    if (!sessionRef.current) sessionRef.current = crypto.randomUUID();
    return sessionRef.current;
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: value is the intended trigger
  useEffect(() => {
    if (skipNextFetch.current) {
      skipNextFetch.current = false;
      return;
    }
    const query = value.trim();
    if (query.length < MIN_CHARS) {
      setPredictions([]);
      setOpen(false);
      setNoMatch(false);
      setLimited(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      const result = await autocompleteCityAction(query, sessionToken());
      if (cancelled) return;
      if (result.status === 'rate_limited') {
        setLimited(true);
        setPredictions([]);
        setOpen(true);
        return;
      }
      setLimited(false);
      setPredictions(result.predictions);
      setNoMatch(result.predictions.length === 0);
      setActiveIndex(result.predictions.length > 0 ? 0 : -1);
      setOpen(true);
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value]);

  async function choose(prediction: CityPrediction): Promise<void> {
    skipNextFetch.current = true;
    onValueChange(cityLabel(prediction.city, prediction.province));
    setOpen(false);
    setPredictions([]);
    setActiveIndex(-1);
    setNoMatch(false);
    const result = await resolveCityAction(prediction.placeId, sessionToken());
    sessionRef.current = null;
    if (result.status === 'rate_limited') {
      setLimited(true);
      return;
    }
    if (result.centroid) {
      onSelect(result.centroid);
    }
  }

  const showList = open && !limited && predictions.length > 0;

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (!showList) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((i) => (i + 1) % predictions.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((i) => (i - 1 + predictions.length) % predictions.length);
    } else if (event.key === 'Enter' && activeIndex >= 0) {
      const active = predictions[activeIndex];
      if (active) {
        event.preventDefault();
        void choose(active);
      }
    }
  }

  const activeId = showList && activeIndex >= 0 ? `${listId}-opt-${activeIndex}` : undefined;

  return (
    <div className="ob-combobox">
      <input
        id={inputId}
        type="text"
        role="combobox"
        className="field"
        value={value}
        onChange={(event) => onValueChange(event.currentTarget.value)}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
        placeholder="Toronto, or a postal prefix like M5V"
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={showList ? listId : undefined}
        aria-activedescendant={activeId}
      />
      {showList ? (
        // WAI-ARIA combobox: focus stays on the input via aria-activedescendant, so the
        // listbox + its options are intentionally NOT focusable and DO carry the
        // interactive roles the pattern requires (no native listbox element exists).
        // biome-ignore lint/a11y: WAI-ARIA combobox listbox — activedescendant-driven, roles required, no native element
        <ul className="ob-combobox-list" id={listId} role="listbox" aria-label="City suggestions">
          {predictions.map((prediction, index) => (
            <CityOption
              key={prediction.placeId}
              optionId={`${listId}-opt-${index}`}
              active={index === activeIndex}
              prediction={prediction}
              onChoose={choose}
            />
          ))}
        </ul>
      ) : null}
      {open && limited ? (
        <p className="meta ob-combobox-note" aria-live="polite">
          Searching too fast — one sec, then try again.
        </p>
      ) : null}
      {open && !limited && noMatch ? (
        <p className="meta ob-combobox-note">No match — try a nearby city or a postal prefix.</p>
      ) : null}
    </div>
  );
}

/** One listbox option. Extracted so the combobox-pattern a11y suppression sits at a
 * single, unambiguous return (the listbox/option roles are required by the pattern;
 * focus stays on the input via aria-activedescendant, so options are not tab stops). */
function CityOption({
  optionId,
  active,
  prediction,
  onChoose,
}: {
  optionId: string;
  active: boolean;
  prediction: CityPrediction;
  onChoose: (prediction: CityPrediction) => void;
}) {
  const cls = active ? 'ob-combobox-option ob-combobox-option-active' : 'ob-combobox-option';
  // mousedown (not click) so the selection lands before the input's blur closes the list.
  const select = (event: MouseEvent<HTMLLIElement>): void => {
    event.preventDefault();
    onChoose(prediction);
  };
  return (
    // biome-ignore lint/a11y: WAI-ARIA combobox option — activedescendant-driven, role required, no native element
    <li id={optionId} role="option" aria-selected={active} className={cls} onMouseDown={select}>
      <MapPin size={14} strokeWidth={2} aria-hidden="true" className="shrink-0 text-faded-sage" />
      <span>{prediction.description}</span>
    </li>
  );
}
