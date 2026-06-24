'use client';

import { useEffect, useRef, useState } from 'react';
import type { LocationInput } from '~/lib/family/location-input';
import { loadPlacesAutocomplete, PLACES_REGION_CODES } from '~/lib/onboarding/load-places';
import { type PlaceAddressComponent, parsePlaceAddress } from '~/lib/onboarding/parse-place';

/**
 * Home-address capture, backed by Google Places Autocomplete (New) restricted to
 * US/CA/AU/NZ/UK. Selecting a suggestion autofills the structured parts
 * (country / province / city / postal code). The full address is sensitive
 * (rule #1): we store ONLY those coarse parts — never the street line — and
 * discovery uses the derived coarse area (normalizeLocation). We never log the
 * address or the API key.
 *
 * Degrades gracefully: if the API key is missing or the script fails to load, the
 * autocomplete box is hidden and the parent fills the same structured fields by
 * hand. The structured fields stay editable either way, so a parent can correct an
 * autofilled value.
 */
export function HomeAddress({
  value,
  onChange,
}: {
  value: LocationInput;
  onChange: (next: LocationInput) => void;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [status, setStatus] = useState<'loading' | 'ready' | 'manual'>('loading');

  useEffect(() => {
    let cancelled = false;
    let element: HTMLElement | null = null;
    let listener: ((event: Event) => void) | null = null;

    loadPlacesAutocomplete().then((Ctor) => {
      if (cancelled) {
        return;
      }
      const mount = mountRef.current;
      if (!Ctor || !mount) {
        setStatus('manual');
        return;
      }
      element = new Ctor({ includedRegionCodes: PLACES_REGION_CODES });
      element.setAttribute('aria-label', 'search your home address');
      listener = (event: Event) => {
        const place = (event as { placePrediction?: { toPlace?: () => PlaceLike } })
          .placePrediction?.toPlace?.();
        if (place) {
          void applyPlace(place, onChangeRef.current);
        }
      };
      element.addEventListener('gmp-select', listener);
      mount.appendChild(element);
      setStatus('ready');
    });

    return () => {
      cancelled = true;
      if (element && listener) {
        element.removeEventListener('gmp-select', listener);
      }
      element?.remove();
    };
  }, []);

  function setField(patch: Partial<LocationInput>) {
    onChange({ ...value, ...patch });
  }

  return (
    <div className="space-y-5">
      {status !== 'manual' ? (
        <div>
          <span className="eyebrow" id="home-address-search-label">
            home address
          </span>
          <div ref={mountRef} className="hale-places mt-2" aria-busy={status === 'loading'} />
          <p className="meta mt-2">
            start typing and pick your address — I&rsquo;ll fill in the rest. I store only the
            coarse area for finding local things; the full address is kept private for booking.
          </p>
        </div>
      ) : null}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
        <div>
          <label htmlFor="home-country" className="eyebrow">
            country
          </label>
          <input
            id="home-country"
            type="text"
            className="field mt-2"
            value={value.country ?? ''}
            onChange={(e) => setField({ country: e.currentTarget.value })}
            placeholder="Canada"
            autoComplete="country-name"
          />
        </div>
        <div>
          <label htmlFor="home-province" className="eyebrow">
            province / state
          </label>
          <input
            id="home-province"
            type="text"
            className="field mt-2"
            value={value.province ?? ''}
            onChange={(e) => setField({ province: e.currentTarget.value })}
            placeholder="Ontario"
            autoComplete="address-level1"
          />
        </div>
        <div>
          <label htmlFor="home-city" className="eyebrow">
            city
          </label>
          <input
            id="home-city"
            type="text"
            className="field mt-2"
            value={value.city ?? ''}
            onChange={(e) => setField({ city: e.currentTarget.value })}
            placeholder="Toronto"
            autoComplete="address-level2"
          />
        </div>
        <div>
          <label htmlFor="home-postal" className="eyebrow">
            postal code
          </label>
          <input
            id="home-postal"
            type="text"
            className="field mt-2"
            value={value.postalCode ?? ''}
            onChange={(e) => setField({ postalCode: e.currentTarget.value })}
            placeholder="M5V 2T6"
            autoComplete="postal-code"
          />
        </div>
      </div>
    </div>
  );
}

interface PlaceLike {
  fetchFields: (options: { fields: string[] }) => Promise<unknown>;
  addressComponents?: PlaceAddressComponent[] | null;
}

/**
 * Fetch the address components for the selected place and report the parsed,
 * coarse fields up. Failures (network, quota) are swallowed: the manual fields
 * remain, so selection never blocks the parent. No address is ever logged (rule #1).
 */
async function applyPlace(place: PlaceLike, onChange: (next: LocationInput) => void): Promise<void> {
  try {
    await place.fetchFields({ fields: ['addressComponents'] });
  } catch {
    return;
  }
  const components = place.addressComponents;
  if (!components) {
    return;
  }
  onChange(parsePlaceAddress(components));
}
