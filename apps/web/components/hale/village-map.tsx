'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { MapPin } from 'lucide-react';
import { Icon } from '~/components/ui/icon';
import { loadMapsLibrary } from '~/lib/onboarding/load-places';
import { type LatLng, buildVillageMapModel } from '~/lib/village/map-model';
import type { VillageCandidateView } from '~/lib/village/mappers';
import { AcceptButton } from './accept-button';
import { EndorseButton } from './endorse-button';
import { RegisterLink } from './register-link';
import { ShareButton } from './share-button';

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

export function VillageMap({
  candidates,
  coarseCenter,
  area = null,
}: {
  candidates: VillageCandidateView[];
  coarseCenter: LatLng | null;
  area?: string | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapInstance | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const panelId = useId();

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
          if (!cancelled) setSelectedId(marker.id);
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
        <div ref={containerRef} className="absolute inset-0" aria-label="map of nearby activities" />
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

      {selected && !selected.teenAttributed ? (
        <section id={panelId} className="panel bg-raised flex flex-col gap-4">
          <div className="flex items-baseline justify-between gap-4">
            <p className="eyebrow text-spruce">{selected.kind}</p>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setSelectedId(null)}
              aria-label="close activity"
            >
              close
            </button>
          </div>
          <h3 className="font-display text-[1.5rem] lg:text-[1.875rem] leading-tight text-spruce">
            {selected.title}
          </h3>
          {selected.venueName ? (
            <p className="meta text-slate-green">{selected.venueName}</p>
          ) : null}
          {selected.summary ? (
            <p className="text-lg text-spruce leading-relaxed">{selected.summary}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-4 pt-1">
            <AcceptButton href={selected.acceptHref} />
            <EndorseButton
              endpoint={selected.endorseHref}
              initiallyEndorsed={selected.endorsedByFamily}
              initialCount={selected.endorsementCount}
            />
            <ShareButton
              endpoint={selected.shareHref}
              label="share this pick"
              shareTitle={selected.title}
              variant="ghost"
            />
            <RegisterLink sourceUrl={selected.sourceUrl} title={selected.title} area={area} />
          </div>
        </section>
      ) : null}
    </div>
  );
}
