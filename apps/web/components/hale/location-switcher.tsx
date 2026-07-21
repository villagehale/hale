'use client';

import { Check, ChevronDown, MapPin, Search, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, useTransition } from 'react';
import { Icon } from '~/components/ui/icon';
import {
  activateAreaAction,
  relocateToCityAction,
  searchCitiesAction,
} from '~/lib/village/areas-action';
import type { CityCandidate } from '~/lib/village/geocode';
import type { AreaSwitcherData } from '~/lib/village/switcher';

/** A saved area and a candidate share {city, province}; this is their identity for
 * de-duping search results against what the family already has. */
function areaKey(city: string, province: string | null): string {
  return `${city.toLowerCase()}|${(province ?? '').toLowerCase()}`;
}

function cityLabel(city: string, province: string | null): string {
  return province ? `${city}, ${province}` : city;
}

/**
 * The top-bar location switcher (design handoff §3.2 / Interactions). The pill reads
 * the family's active coarse area (never a fabricated label — nothing renders without
 * one). The popover types a city → coarse {city, province} candidates (rule #1: no
 * coordinates ever leave the client), or browses saved areas with a check on the
 * active one. Picking a searched city fully relocates (add + activate); picking a
 * saved area activates it; then the whole area-derived surface re-renders.
 *
 * "Use my current location" is intentionally absent on web: there is no browser-geo
 * path that respects rule #1 (no precise coordinates sent anywhere), so it is omitted
 * rather than faked (honesty lane).
 */
export function LocationSwitcher({ data }: { data: AreaSwitcherData }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CityCandidate[]>([]);
  const [pending, startTransition] = useTransition();
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const searching = query.trim().length > 0;
  const savedAreas = data.areas;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Debounced typeahead. A blank query clears results; otherwise the server action
  // returns coarse candidates, which we filter down to cities not already saved.
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      return;
    }
    // Compute the saved-city keys inside the effect so it depends only on the query
    // and the (server-stable) saved list — no new-every-render Set in the dep list.
    const savedKeys = new Set(savedAreas.map((area) => areaKey(area.city, area.province)));
    let cancelled = false;
    const timer = setTimeout(async () => {
      const found = await searchCitiesAction(trimmed);
      if (cancelled) return;
      setResults(found.filter((c) => !savedKeys.has(areaKey(c.city, c.province))));
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, savedAreas]);

  const close = () => {
    setOpen(false);
    setQuery('');
    setResults([]);
  };

  const relocate = (candidate: CityCandidate) => {
    startTransition(async () => {
      const res = await relocateToCityAction({
        city: candidate.city,
        province: candidate.province,
      });
      if (res.status === 'ok') {
        close();
        router.refresh();
      }
    });
  };

  const activate = (areaId: string) => {
    startTransition(async () => {
      const res = await activateAreaAction(areaId);
      if (res.status === 'ok') {
        close();
        router.refresh();
      }
    });
  };

  // Nothing to switch and no active label → render nothing (never a fake pill).
  if (!data.activeLabel && data.areas.length === 0) return null;

  const pillText = data.activeLabel ? data.activeLabel.city : 'Set your area';

  return (
    <div className="loc-root" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen((prev) => !prev)}
        className="location-pill location-pill-button"
        data-open={open ? '' : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={menuId}
      >
        <Icon as={MapPin} size={16} />
        <span data-hale-pii>{pillText}</span>
        <Icon as={ChevronDown} size={15} className="loc-caret" />
      </button>

      {open ? (
        <div
          className="loc-pop"
          id={menuId}
          // biome-ignore lint/a11y/useSemanticElements: a non-modal search+action popover (Escape + outside-click close), not the native <dialog>; role=menu wrongly put SRs in menu-navigation mode over the search field
          role="dialog"
          aria-label="Family area"
          data-pending={pending ? '' : undefined}
        >
          <p className="eyebrow loc-pop-head">Family area</p>
          <div className="loc-search">
            <Icon as={Search} size={16} className="loc-search-icon" />
            <input
              type="text"
              className="loc-search-input"
              placeholder="Search city or area"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search for a city or area"
            />
            {query ? (
              <button
                type="button"
                className="loc-search-clear"
                onClick={() => setQuery('')}
                aria-label="Clear search"
              >
                <Icon as={X} size={15} />
              </button>
            ) : null}
          </div>

          {searching ? (
            results.length > 0 ? (
              <ul className="loc-list">
                {results.map((candidate) => (
                  <li key={areaKey(candidate.city, candidate.province)}>
                    <button
                      type="button"
                      className="loc-item"
                      onClick={() => relocate(candidate)}
                      disabled={pending}
                    >
                      <Icon as={MapPin} size={15} className="loc-item-icon" />
                      <span className="loc-item-label" data-hale-pii>
                        {cityLabel(candidate.city, candidate.province)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="loc-noresult meta">
                No match for &ldquo;{query.trim()}&rdquo;. Try a nearby city or postal code.
              </p>
            )
          ) : (
            <ul className="loc-list">
              {data.areas.map((area) => (
                <li key={area.id}>
                  <button
                    type="button"
                    className="loc-item"
                    onClick={() => activate(area.id)}
                    disabled={pending || area.isActive}
                    aria-current={area.isActive ? 'true' : undefined}
                  >
                    <Icon as={MapPin} size={15} className="loc-item-icon" />
                    <span className="loc-item-label" data-hale-pii>
                      {cityLabel(area.city, area.province)}
                    </span>
                    {area.isActive ? (
                      <Icon as={Check} size={16} className="loc-item-check" />
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
