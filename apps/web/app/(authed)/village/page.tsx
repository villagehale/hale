import { Bell, MapPin } from 'lucide-react';
import Link from 'next/link';
import { Suspense } from 'react';
import { BuildYourVillage } from '~/components/hale/build-your-village';
import { PrivacyNote } from '~/components/hale/privacy-note';
import { VillageBoard } from '~/components/hale/village-board';
import { VillageFeedSkeleton, VillageSearchRun } from '~/components/hale/village-feed-section';
import { VillageSeasonSelector } from '~/components/hale/village-season-selector';
import { Icon } from '~/components/ui/icon';
import { loadPendingApprovals } from '~/lib/dashboard/queries';
import { formatCalendarDate } from '~/lib/format/datetime';
import { villageKindLabel } from '~/lib/format/labels';
import { loadCuratedResources } from '~/lib/village/curated-resources';
import { loadVillageFeed } from '~/lib/village/feed';
import { loadVillage } from '~/lib/village/queries';
import { seasonFromParam } from '~/lib/village/season-selector-ui';

/** A clean, minimal section label (Notion/Linear register) — small, muted, spaced
 * above its content. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="eyebrow mb-3 text-faded-sage">{children}</p>;
}

export default async function VillagePage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string }>;
}) {
  const { season } = await searchParams;
  const activeSeason = seasonFromParam(season);

  // The board reads the feed (a pure DB round-trip) directly so the header can show
  // the family's coarse area chip and the two columns share one load. The standing
  // weekly routine belongs to the standing feed, not a forward-looking season
  // search — so its loadVillage read is skipped on a search view.
  const [feed, resources, pending, { routine }] = await Promise.all([
    loadVillageFeed(),
    loadCuratedResources(),
    loadPendingApprovals(),
    activeSeason ? Promise.resolve({ routine: null }) : loadVillage(),
  ]);
  const hasRoutine = (routine?.items.length ?? 0) > 0;
  const pendingCount = pending.length;

  return (
    <div>
      {/* ── Header — title + tagline, the family's coarse area as a static chip,
       * and a bell into Approvals with an orange dot only when a decision waits. ── */}
      <header className="rise rise-1 mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-[1.75rem] lg:text-[2rem] leading-tight">Village</h1>
          <p className="meta mt-1 text-slate-green">
            Activities, events &amp; resources in your area.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {feed.areaCoarse ? (
            <span
              className="pill inline-flex items-center gap-1.5 text-faded-sage"
              data-hale-pii
            >
              <Icon as={MapPin} size={14} />
              {feed.areaCoarse}
            </span>
          ) : null}
          <Link
            href="/approvals"
            aria-label={pendingCount > 0 ? `approvals — ${pendingCount} waiting` : 'approvals'}
            className="relative inline-flex size-10 items-center justify-center rounded-full text-spruce transition-colors hover:bg-oat"
          >
            <Icon as={Bell} size={20} />
            {pendingCount > 0 ? (
              <span
                aria-hidden
                className="absolute right-1.5 top-1.5 size-2.5 rounded-full bg-apricot ring-2 ring-linen"
              />
            ) : null}
          </Link>
        </div>
      </header>

      {/* ── The board (search + filter pills + activities/resources columns), or a
           season search RUN. The run streams behind Suspense. ─────────────────── */}
      {activeSeason ? (
        <div className="rise rise-2">
          <Suspense fallback={<VillageFeedSkeleton />}>
            <VillageSearchRun season={activeSeason} />
          </Suspense>
        </div>
      ) : (
        <div className="rise rise-2">
          <VillageBoard
            candidates={feed.candidates}
            resources={resources}
            coarseCenter={feed.coarseCenter}
            area={feed.areaCoarse}
          />
        </div>
      )}

      {/* ── Season search — pick a future season, or clear back to your feed. ── */}
      <section className="rise rise-3 mt-16 lg:mt-20">
        <SectionLabel>look ahead to a season</SectionLabel>
        <VillageSeasonSelector active={activeSeason} />
      </section>

      {/* ── Below the board: the calmer, preserved sections. A season search stays
           focused on its results, so these are the standing view only. ─────────── */}
      {activeSeason ? null : (
        <div className="mt-12 space-y-12">
          {routine && hasRoutine ? (
            <section className="rise rise-4">
              <SectionLabel>
                a gentle routine · week of {formatCalendarDate(routine.weekOf)}
              </SectionLabel>
              <div className="panel space-y-5">
                {routine.items.map((item, idx) => {
                  const kindLabel = villageKindLabel(item.kind);
                  return (
                    <div
                      key={`${item.kind}-${idx}`}
                      className="flex items-baseline gap-4 border-t border-rule pt-5 first:border-t-0 first:pt-0"
                    >
                      {kindLabel ? (
                        <span className="eyebrow text-spruce shrink-0">{kindLabel}</span>
                      ) : null}
                      <div data-hale-pii>
                        <p className="text-lg text-spruce leading-relaxed">{item.title}</p>
                        {item.stageNote ? (
                          <p className="meta mt-1 text-slate-green">{item.stageNote}</p>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}

          <section className="rise rise-4">
            <BuildYourVillage nothingToShare={!hasRoutine} />
          </section>
        </div>
      )}

      {/* ── Colophon ────────────────────────────────────────────────────── */}
      <section className="rise rise-7 mt-16 lg:mt-20 space-y-6">
        <div className="panel-oat px-6 py-5 flex flex-wrap items-center gap-x-6 gap-y-2">
          <span className="meta">
            Hale only ever uses your neighbourhood, never your exact address.
          </span>
          <PrivacyNote />
        </div>

        <div className="flex flex-wrap items-baseline justify-between gap-y-3 text-faded-sage">
          <p className="meta">this week&rsquo;s village</p>
          <p className="meta">gathered by Hale</p>
        </div>
      </section>
    </div>
  );
}
