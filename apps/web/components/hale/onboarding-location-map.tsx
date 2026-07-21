'use client';

import { useEffect, useRef, useState } from 'react';
import { resolveCityCentroid } from '~/lib/onboarding/city-centroid';
import { type MapsLibraries, loadMapsLibrary } from '~/lib/onboarding/load-places';
import { VillageIllustration } from './village-illustration';

/**
 * The interactive, city-level Google Map behind onboarding step 4 (design handoff
 * §4.1 Ob4). It replaces the static village illustration in that slot, recentring on
 * the city the parent searches — a warm, alive backdrop while the search input stays
 * the primary control.
 *
 * Loaded lazily (StepLocation dynamic-imports this component with ssr:false), so the
 * Maps JS never enters the initial bundle; it boots only when step 4 mounts, through
 * the SAME shared loader as the village map + address autocomplete (loadMapsLibrary).
 *
 * Privacy (rule #1), non-negotiable: only the coarse city text the parent types is
 * sent to the server (resolveCityCentroid → a `locality` Places search), and the
 * centroid that comes back is used ONLY to centre the map — never stored. No browser
 * geolocation, no reverse geocoding, and the zoom is capped so a parent can nudge the
 * map but never reach an address. The persisted location stays coarse {country, city}.
 *
 * Honest degradation: a missing key (previews/forks) or a failed script both surface
 * as loadMapsLibrary() → null, and the slot shows the original illustration exactly
 * as before — never a broken grey box.
 */

interface MapInstance {
  setCenter: (p: { lat: number; lng: number }) => void;
  panTo: (p: { lat: number; lng: number }) => void;
  setZoom: (z: number) => void;
}

interface MapMarker {
  setMap: (m: unknown) => void;
}

/** City-level, never address-level (rule #1): the map rests at ~11 and is capped so a
 * parent can nudge it but never zoom to a house. */
const CITY_ZOOM = 11;
const MIN_ZOOM = 8;
const MAX_ZOOM = 12;
const RESOLVE_DEBOUNCE_MS = 500;

/** A calm default centre before a city resolves — Toronto, which the field
 * placeholder already names. Purely decorative; not the parent's real location. */
const DEFAULT_CENTER = { lat: 43.6532, lng: -79.3832 };

// Mirrors the village map's Hale palette (components/hale/village-map.tsx) so the two
// maps read as one product. Duplicated rather than shared to keep this change fully
// additive; the palette is decorative and changes rarely.
const HALE_MAP_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#f4efe6' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#3a4a5c' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#faf7f1' }] },
  { featureType: 'poi', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.business', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#fdfbf6' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#e9e1d2' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#eeddc5' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#d7e0cd' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#bcd0cf' }] },
  {
    featureType: 'administrative',
    elementType: 'geometry.stroke',
    stylers: [{ color: '#cbb89a' }],
  },
];

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function OnboardingLocationMap({ apiKey, area }: { apiKey: string | null; area: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapInstance | null>(null);
  const markerRef = useRef<MapMarker | null>(null);
  const libRef = useRef<MapsLibraries | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>(
    apiKey ? 'loading' : 'unavailable',
  );

  // Build the map exactly once when this lazily-imported component mounts. A missing
  // key or a failed script both surface as loadMapsLibrary() → null, unifying every
  // degraded path onto the illustration fallback below.
  useEffect(() => {
    if (!apiKey) {
      setStatus('unavailable');
      return;
    }
    let cancelled = false;
    (async () => {
      const lib = await loadMapsLibrary();
      const container = containerRef.current;
      if (cancelled || !lib || !container) {
        if (!cancelled) setStatus('unavailable');
        return;
      }
      libRef.current = lib;
      mapRef.current = new lib.Map(container, {
        center: DEFAULT_CENTER,
        zoom: CITY_ZOOM,
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
        disableDefaultUI: true,
        zoomControl: true,
        clickableIcons: false,
        keyboardShortcuts: false,
        streetViewControl: false,
        mapTypeControl: false,
        fullscreenControl: false,
        styles: HALE_MAP_STYLE,
      }) as unknown as MapInstance;
      setStatus('ready');
    })();
    return () => {
      cancelled = true;
    };
  }, [apiKey]);

  // Recentre on the SEARCHED city (debounced). Only the coarse city text is sent to
  // the server action; the centroid it returns is used here and never stored. Under
  // prefers-reduced-motion the centre is jump-set rather than animated (brief a11y).
  useEffect(() => {
    if (status !== 'ready') return;
    const query = area.trim();
    if (query.length < 2) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const centroid = await resolveCityCentroid(query);
      const map = mapRef.current;
      const lib = libRef.current;
      if (cancelled || !centroid || !map || !lib) return;
      const point = { lat: centroid.lat, lng: centroid.lng };
      if (prefersReducedMotion()) {
        map.setCenter(point);
      } else {
        map.panTo(point);
      }
      map.setZoom(CITY_ZOOM);
      markerRef.current?.setMap(null);
      markerRef.current = new lib.Marker({ map, position: point, title: centroid.city });
    }, RESOLVE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [area, status]);

  if (!apiKey) {
    return <VillageIllustration />;
  }

  return (
    <>
      <div
        ref={containerRef}
        className="absolute inset-0"
        role="img"
        aria-label="Map of your selected area"
      />
      {status === 'ready' ? (
        // Warm brand cast over the raster map (Google deprecated inline map styles for
        // Map-ID maps; a multiply overlay tints toward the Hale linen palette).
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{ background: '#f1eadb', mixBlendMode: 'multiply', opacity: 0.45 }}
        />
      ) : (
        <div className="absolute inset-0">
          <VillageIllustration />
        </div>
      )}
    </>
  );
}
