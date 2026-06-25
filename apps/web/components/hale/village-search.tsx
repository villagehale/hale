'use client';

import { useId, useMemo, useState } from 'react';
import { List, Lock, Map as MapIcon, Search } from 'lucide-react';
import { AcceptButton } from '~/components/hale/accept-button';
import { EndorseButton } from '~/components/hale/endorse-button';
import { Folio } from '~/components/hale/folio';
import { ShareButton } from '~/components/hale/share-button';
import { VillageMap } from '~/components/hale/village-map';
import { Icon } from '~/components/ui/icon';
import type { LatLng } from '~/lib/village/map-model';
import type { VillageCandidateView } from '~/lib/village/mappers';

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
}: {
  candidates: VillageCandidateView[];
  coarseCenter: LatLng | null;
}) {
  const inputId = useId();
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>('list');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((c) => `${c.title} ${c.kind} ${c.summary}`.toLowerCase().includes(q));
  }, [candidates, query]);

  return (
    <div>
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

      {view === 'map' ? (
        <VillageMap candidates={filtered} coarseCenter={coarseCenter} />
      ) : null}

      <div className={view === 'map' ? 'hidden' : undefined}>
        {filtered.length === 0 ? (
        <output className="meta italic text-slate-green block">
          nothing matches “{query.trim()}” this week.
        </output>
      ) : (
        <section>
          {filtered.map((candidate, idx) => {
            const delay = `rise-${Math.min(idx + 3, 7)}`;
            return (
              <article
                key={candidate.id}
                className={`rise ${delay} py-12 lg:py-14 border-t border-rule first:border-t-0`}
              >
                <div className="grid grid-cols-1 md:grid-cols-12 gap-y-6 md:gap-x-8">
                  <div className="md:col-span-2">
                    <Folio index={idx + 1} />
                    <p className="mt-3 eyebrow text-spruce">{candidate.kind}</p>
                  </div>

                  {candidate.teenAttributed ? (
                    <div className="md:col-span-7">
                      <p className="flex items-center gap-2 text-spruce leading-relaxed">
                        <Icon as={Lock} size={18} className="shrink-0 text-slate-green" />
                        {candidate.title}
                      </p>
                    </div>
                  ) : (
                    <div className="md:col-span-7 space-y-5">
                      <h2 className="font-display text-[1.75rem] lg:text-[2.25rem] leading-tight">
                        {candidate.title}
                      </h2>
                      <p className="text-lg text-spruce leading-relaxed">{candidate.summary}</p>

                      {candidate.coverageNote ? (
                        <p className="meta text-slate-green">{candidate.coverageNote}</p>
                      ) : null}

                      <div className="flex flex-wrap items-center gap-x-6 gap-y-4 pt-2">
                        <AcceptButton href={candidate.acceptHref} />
                        <EndorseButton
                          endpoint={candidate.endorseHref}
                          initiallyEndorsed={candidate.endorsedByFamily}
                          initialCount={candidate.endorsementCount}
                        />
                        <ShareButton
                          endpoint={candidate.shareHref}
                          label="share this pick"
                          shareTitle={candidate.title}
                          variant="ghost"
                        />
                        {candidate.sourceUrl ? (
                          <a
                            href={candidate.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="btn-ghost"
                          >
                            see the listing →
                          </a>
                        ) : null}
                      </div>
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </section>
      )}
      </div>
    </div>
  );
}
