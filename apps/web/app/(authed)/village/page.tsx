import { Suspense } from 'react';
import { BuildYourVillage } from '~/components/hale/build-your-village';
import { PrivacyNote } from '~/components/hale/privacy-note';
import { VillageAiSearch } from '~/components/hale/village-ai-search';
import { VillageBoard } from '~/components/hale/village-board';
import { VillageFeedSkeleton, VillageSearchRun } from '~/components/hale/village-feed-section';
import { VillageSeasonSelector } from '~/components/hale/village-season-selector';
import { formatCalendarDate } from '~/lib/format/datetime';
import { villageKindLabel } from '~/lib/format/labels';
import { loadCuratedResources } from '~/lib/village/curated-resources';
import { loadVillageFeed } from '~/lib/village/feed';
import { loadSavedVillageCandidates, loadVillage } from '~/lib/village/queries';
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

  // The board reads the feed (a pure DB round-trip) directly so its columns share
  // one load, plus the family's saved candidates for the right rail. The standing
  // weekly routine belongs to the standing feed, not a forward-looking season search
  // — so its loadVillage read is skipped on a search view (and Saved is too: a season
  // run is a focused result set). The page title + the coarse-area location pill now
  // live in the shell top bar (design handoff §3.2), so this page carries no header
  // of its own.
  const [feed, resources, saved, { routine }] = await Promise.all([
    loadVillageFeed(),
    loadCuratedResources(),
    activeSeason ? Promise.resolve([]) : loadSavedVillageCandidates(),
    activeSeason ? Promise.resolve({ routine: null }) : loadVillage(),
  ]);
  const hasRoutine = (routine?.items.length ?? 0) > 0;

  return (
    // village-wide opts this surface up to a roomier column than the 58rem editorial
    // cap so the §4.5 map board keeps a real centre-column map (see globals.css).
    <div className="village-wide">
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
          {/* The natural-language search owns the search bar and, when a search is
              active, replaces the board with its real results; the board (its own
              literal-filter box hidden) is what it shows when idle. Keyed on the
              active area so a search resets on a region switch. */}
          <VillageAiSearch areaKey={feed.areaCoarse ?? ''} area={feed.areaCoarse}>
            <VillageBoard
              candidates={feed.candidates}
              resources={resources}
              coarseCenter={feed.coarseCenter}
              area={feed.areaCoarse}
              saved={saved}
              ranked={feed.ranked}
              showInlineSearch={false}
            />
          </VillageAiSearch>
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
