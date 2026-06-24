'use client';

import { useId, useMemo, useState } from 'react';
import { Lock, Search } from 'lucide-react';
import { AcceptButton } from '~/components/hale/accept-button';
import { EndorseButton } from '~/components/hale/endorse-button';
import { Folio } from '~/components/hale/folio';
import { ShareButton } from '~/components/hale/share-button';
import { Icon } from '~/components/ui/icon';
import type { VillageCandidateView } from '~/lib/village/mappers';

/**
 * Client-side search/filter over the already-loaded village candidates. Instant
 * and accessible: a labelled search input narrows the list by title / kind /
 * summary as the parent types. Filtering happens over the rows already sent to
 * the page (no new request, no precise location involved — rule #1), so it's
 * safe and fast for the MVP. Accepting a candidate still goes through the real
 * accept pipeline via AcceptButton.
 */
export function VillageSearch({ candidates }: { candidates: VillageCandidateView[] }) {
  const inputId = useId();
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((c) => `${c.title} ${c.kind} ${c.summary}`.toLowerCase().includes(q));
  }, [candidates, query]);

  return (
    <div>
      <div className="field-group mb-10 lg:mb-12 max-w-xl">
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
            className="field pl-11"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="classes, drop-ins, a kind of thing…"
            autoComplete="off"
          />
        </div>
      </div>

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
  );
}
