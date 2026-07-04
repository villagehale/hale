'use client';

import { useId, useMemo, useState } from 'react';
import { List, Map as MapIcon, Search } from 'lucide-react';
import { ActivityCard } from '~/components/hale/activity-card';
import { ChildScope, type ScopeChild } from '~/components/hale/child-scope';
import { VillageMap } from '~/components/hale/village-map';
import { Icon } from '~/components/ui/icon';
import type { LatLng } from '~/lib/village/map-model';
import {
  type CadenceFilter,
  type VillageCandidateView,
  filterCandidatesByCadence,
  filterCandidatesByScope,
} from '~/lib/village/mappers';

/**
 * Client-side search/filter over the already-loaded village candidates, with a
 * list↔map toggle. Default view is the agent-ranked LIST; the map is a spatial
 * companion over the SAME ranked feed (it never re-ranks). Filtering happens over
 * the rows already sent to the page (no new request, no precise location — rule
 * #1), so it's safe and fast. Accepting a candidate still goes through the real
 * accept pipeline via AcceptButton.
 *
 * The map (rule #1) plots only PUBLIC venue coords and centers on the coarse area,
 * never the precise home; coordless and teen-redacted candidates stay list-only.
 */
type View = 'list' | 'map';

export function VillageSearch({
  candidates,
  coarseCenter,
  area = null,
  kids = [],
}: {
  candidates: VillageCandidateView[];
  coarseCenter: LatLng | null;
  area?: string | null;
  kids?: ScopeChild[];
}) {
  const inputId = useId();
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<string | null>(null);
  const [cadence, setCadence] = useState<CadenceFilter>('all');
  const [view, setView] = useState<View>('list');

  const filtered = useMemo(() => {
    const byCadence = filterCandidatesByCadence(candidates, cadence);
    const scoped = filterCandidatesByScope(byCadence, scope);
    const q = query.trim().toLowerCase();
    if (!q) return scoped;
    return scoped.filter((c) => `${c.title} ${c.kind} ${c.summary}`.toLowerCase().includes(q));
  }, [candidates, query, scope, cadence]);

  return (
    <div>
      {kids.length > 1 ? (
        <div className="mb-6">
          <ChildScope
            variant="filter"
            legend="show activities for"
            kids={kids}
            value={scope}
            onChange={setScope}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-end justify-between gap-4 mb-10 lg:mb-12">
        <div className="field-group max-w-xl flex-1 min-w-[12rem]">
          <label htmlFor={inputId} className="field-label">
            search this week
          </label>
          <div className="relative">
            <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-faded-sage">
              <Icon as={Search} size={18} />
            </span>
            <input
              id={inputId}
              type="search"
              className="field field-search"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder="classes, drop-ins, a kind of thing…"
              autoComplete="off"
            />
          </div>
        </div>

        <fieldset
          className="shrink-0 inline-flex rounded-[var(--r-full)] border border-rule-strong p-1"
          aria-label="view activities as a list or a map"
        >
          {(
            [
              { value: 'list', label: 'list', icon: List },
              { value: 'map', label: 'map', icon: MapIcon },
            ] as const
          ).map((option) => {
            const active = view === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                onClick={() => setView(option.value)}
                className={`inline-flex min-h-[44px] items-center gap-2 rounded-[var(--r-full)] px-4 cursor-pointer transition-colors ${
                  active ? 'bg-spruce text-on-spruce' : 'text-slate-green'
                }`}
                style={{ touchAction: 'manipulation' }}
              >
                <Icon as={option.icon} size={18} className="shrink-0" />
                {option.label}
              </button>
            );
          })}
        </fieldset>
      </div>

      <CadenceFilterChips value={cadence} onChange={setCadence} />

      {view === 'map' ? (
        <VillageMap candidates={filtered} coarseCenter={coarseCenter} area={area} />
      ) : null}

      <div className={view === 'map' ? 'hidden' : undefined}>
        {filtered.length === 0 ? (
        <output className="meta italic text-slate-green block">
          {query.trim()
            ? `nothing matches “${query.trim()}” this week.`
            : 'nothing for this child this week — try whole family.'}
        </output>
      ) : (
        <section>
          {filtered.map((candidate, idx) => (
            <ActivityCard
              key={candidate.id}
              candidate={candidate}
              variant="row"
              area={area}
              className={`rise rise-${Math.min(idx + 3, 7)}`}
            />
          ))}
        </section>
      )}
      </div>
    </div>
  );
}

/** The four cadence selections, in feed order: everything, then the time-boxed
 * shapes (one-time, seasonal) before the standing option (year-round, the human
 * label for the stored `ongoing`). A stored token never renders raw (rule #1). */
const CADENCE_OPTIONS: ReadonlyArray<{ value: CadenceFilter; label: string }> = [
  { value: 'all', label: 'all' },
  { value: 'one-time', label: 'one-time' },
  { value: 'seasonal', label: 'seasonal' },
  { value: 'year-round', label: 'year-round' },
];

/** Client-side cadence narrowing over the already-visibility-filtered feed — a
 * display selector, no request and no new signal (rule #1). Matches the view
 * toggle's segmented-control treatment (44px targets, active spruce fill). */
function CadenceFilterChips({
  value,
  onChange,
}: {
  value: CadenceFilter;
  onChange: (next: CadenceFilter) => void;
}) {
  return (
    <fieldset
      className="mb-10 lg:mb-12 flex flex-wrap gap-1 rounded-[var(--r-full)] border border-rule-strong p-1"
      aria-label="filter activities by cadence"
    >
      {CADENCE_OPTIONS.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`inline-flex min-h-[44px] items-center rounded-[var(--r-full)] px-4 cursor-pointer transition-colors ${
              active ? 'bg-spruce text-on-spruce' : 'text-slate-green'
            }`}
            style={{ touchAction: 'manipulation' }}
          >
            {option.label}
          </button>
        );
      })}
    </fieldset>
  );
}
