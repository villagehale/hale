'use client';

import { MapPin } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '~/components/ui/icon';
import { loadMapsLibrary } from '~/lib/onboarding/load-places';
import { type LatLng, buildVillageMapModel } from '~/lib/village/map-model';
import type { VillageCandidateView } from '~/lib/village/mappers';
import { ActivityCard } from './activity-card';

/**
 * The spatial companion to the agent-ranked village feed. Renders ONE Google Maps
 * marker per candidate carrying PUBLIC venue coords (a YMCA, a library), in the
 * SAME ranked order as the list. Privacy (rule #1): the map centers on the
 * COARSE-area centroid (FSA / city), never the precise home; when markers exist it
 * fits their bounds (public venues only). Coordless and teen-redacted candidates
 * stay in the list (buildVillageMapModel excludes them) — the map never surfaces
 * more than the list does.
 *
 * Reuses the shared Maps JS loader (loadMapsLibrary) — same key, same async
 * bootstrap as onboarding address autocomplete. If the key/script is unavailable
 * the map degrades to a calm note and the list remains the source of truth.
 *
 * Mobile-first: a fixed-aspect map that sizes cleanly at 375px (no overflow);
 * tapping a marker opens the activity panel with the existing card actions.
 */

interface MapInstance {
  setCenter: (p: LatLng) => void;
  setZoom: (z: number) => void;
  fitBounds: (b: unknown) => void;
}

const FALLBACK_ZOOM = 12;

// The map recolored to the Hale palette — warm linen base, sage parks/water,
// Prussian-blue labels — so it reads as part of the product, not raw Google. The
// classic `styles` array only applies on a raster map (no Map ID); this map
// renders classic markers without a Map ID, so adding one would silently disable
// this styling.
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
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#ded0b0' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#d7e0cd' }] },
  { featureType: 'poi.park', elementType: 'labels.text.fill', stylers: [{ color: '#5b6b54' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#bcd0cf' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#4a6b6b' }] },
  {
    featureType: 'administrative',
    elementType: 'geometry.stroke',
    stylers: [{ color: '#cbb89a' }],
  },
];

export function VillageMap({
  candidates,
  coarseCenter,
  area = null,
  onSelect,
}: {
  candidates: VillageCandidateView[];
  coarseCenter: LatLng | null;
  area?: string | null;
  /** When provided, a marker click reports the candidate id to the parent and the
   * map renders NO panel of its own — the parent owns the shared detail drill-in
   * (the 3-column board). When absent the map keeps its standalone pop-up. */
  onSelect?: (id: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapInstance | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Keep the latest onSelect reachable from the marker handler without re-running
  // the map-init effect (which would recreate the map on every parent render).
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const model = useMemo(
    () => buildVillageMapModel(candidates, coarseCenter),
    [candidates, coarseCenter],
  );
  const selected = candidates.find((c) => c.id === selectedId) ?? null;

  useEffect(() => {
    let cancelled = false;
    const markers: Array<{ setMap: (m: unknown) => void }> = [];

    (async () => {
      const lib = await loadMapsLibrary();
      const container = containerRef.current;
      if (cancelled || !lib || !container) {
        if (!cancelled) setStatus('unavailable');
        return;
      }

      const map = new lib.Map(container, {
        center: model.center ?? model.markers[0]?.position ?? { lat: 0, lng: 0 },
        zoom: FALLBACK_ZOOM,
        disableDefaultUI: true,
        zoomControl: true,
        clickableIcons: false,
        styles: HALE_MAP_STYLE,
      }) as unknown as MapInstance;
      mapRef.current = map;

      const bounds = new lib.LatLngBounds();
      for (const marker of model.markers) {
        const pin = new lib.Marker({
          map,
          position: marker.position,
          title: marker.title,
        });
        pin.addListener('click', () => {
          if (cancelled) return;
          const report = onSelectRef.current;
          if (report) report(marker.id);
          else setSelectedId(marker.id);
        });
        markers.push(pin);
        bounds.extend(marker.position);
      }

      // Fit to the PUBLIC venue markers when present; otherwise rest on the
      // coarse-area centroid. Never the precise home (rule #1).
      if (model.markers.length > 0) {
        map.fitBounds(bounds);
      } else if (model.center) {
        map.setCenter(model.center);
        map.setZoom(FALLBACK_ZOOM);
      }

      setStatus('ready');
    })();

    return () => {
      cancelled = true;
      for (const m of markers) {
        m.setMap(null);
      }
    };
  }, [model]);

  return (
    <div className="space-y-5">
      <div className="relative w-full aspect-[4/3] sm:aspect-[16/9] overflow-hidden rounded-[var(--r-xl)] border border-rule">
        <div
          ref={containerRef}
          className="absolute inset-0"
          aria-label="map of nearby activities"
        />
        {/* Warm brand cast over the map. Google deprecated inline map styles, so a
         * multiply overlay tints the raster map toward the Hale linen palette
         * without needing a cloud Map ID. pointer-events-none keeps pins clickable. */}
        {status === 'ready' ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{ background: '#f1eadb', mixBlendMode: 'multiply', opacity: 0.5 }}
          />
        ) : null}
        {status !== 'ready' ? (
          <div className="absolute inset-0 flex items-center justify-center panel-oat text-center px-6">
            <p className="meta text-slate-green">
              {status === 'loading'
                ? 'loading the map…'
                : 'the map isn’t available right now — your activities are in the list.'}
            </p>
          </div>
        ) : null}
      </div>

      <p className="meta text-slate-green flex items-center gap-2">
        <Icon as={MapPin} size={16} className="shrink-0 text-faded-sage" />
        {model.markers.length > 0
          ? `${model.markers.length} on the map · centered on your area, never your home`
          : 'no map pins yet — your activities are in the list'}
        {model.listOnlyCount > 0 ? ` · ${model.listOnlyCount} more in the list` : ''}
      </p>

      {!onSelect && selected && !selected.teenAttributed ? (
        <ActivityCard
          candidate={selected}
          variant="panel"
          area={area}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </div>
  );
}
