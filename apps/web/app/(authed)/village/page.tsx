import { Suspense } from 'react';
import { BuildYourVillage } from '~/components/hale/build-your-village';
import { PrivacyNote } from '~/components/hale/privacy-note';
import { VillageAiSearch } from '~/components/hale/village-ai-search';
import { VillageBoard } from '~/components/hale/village-board';
import { VillageFeedSkeleton, VillageSearchRun } from '~/components/hale/village-feed-section';
import { VillageSeasonSelector } from '~/components/hale/village-season-selector';
import { loadCuratedResources } from '~/lib/village/curated-resources';
import { loadVillageFeed } from '~/lib/village/feed';
import { loadSavedVillageCandidates } from '~/lib/village/queries';
import { seasonFromParam } from '~/lib/village/season-selector-ui';

// The Village AI search Server Action (searchVillageAction) runs under this segment
// and kicks a FRESH discovery run in after() — a bounded Anthropic call that takes far
// longer than the platform's ~10s default. Raise the segment budget to match the
// discovery crons (maxDuration 300) so the after() work isn't killed mid-run and the
// promised candidates actually land (mirrors api/mobile/village/search/route.ts).
export const maxDuration = 300;

export default async function VillagePage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string }>;
}) {
  const { season } = await searchParams;
  const activeSeason = seasonFromParam(season);

  // The board reads the feed (a pure DB round-trip) directly so its columns share
  // one load, plus the family's saved candidates for the right rail (skipped on a
  // search view: a season run is a focused result set). The page title + the
  // coarse-area location pill now live in the shell top bar (design handoff §3.2),
  // so this page carries no header of its own.
  const [feed, resources, saved] = await Promise.all([
    loadVillageFeed(),
    loadCuratedResources(),
    activeSeason ? Promise.resolve([]) : loadSavedVillageCandidates(),
  ]);

  return (
    // village-wide opts this surface up to a roomier column than the 58rem editorial
    // cap so the §4.5 map board keeps a real centre-column map (see globals.css).
    <div className="village-wide">
      {/* ── The board (search + filter pills + activities/resources columns), or a
           season search RUN. The run streams behind Suspense. ─────────────────── */}
      {activeSeason ? (
        <div className="rise rise-2 space-y-6">
          <VillageSeasonSelector active={activeSeason} />
          <Suspense fallback={<VillageFeedSkeleton />}>
            <VillageSearchRun season={activeSeason} />
          </Suspense>
        </div>
      ) : (
        <div className="rise rise-2">
          {/* The natural-language search (AI-search lane) owns the search bar and, when
              a search is active, replaces the board with its real results; the board
              (its literal-filter box hidden) is the idle view. It resets on a region
              switch via areaKey. The board is ALSO keyed on the active coarse area so a
              switch remounts it — clearing any stale filter / selected activity carried
              from the previous area. Both key on feed.areaCoarse, in lockstep.

              W4 — the season chips are the search's own filter row, mounted directly
              under the bar, not a separate "look ahead to a season" section further
              down the page. ONE search is the entry to this surface; everything else on
              it is a filter beneath that. */}
          <VillageAiSearch
            areaKey={feed.areaCoarse ?? ''}
            area={feed.areaCoarse}
            filters={<VillageSeasonSelector active={activeSeason} />}
          >
            <VillageBoard
              key={feed.areaCoarse ?? 'no-area'}
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

      {/* ── Below the board: the calmer, preserved sections. A season search stays
           focused on its results, so these are the standing view only. ─────────── */}
      {activeSeason ? null : (
        <div className="mt-12 space-y-12">
          <section className="rise rise-4">
            <BuildYourVillage />
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

        <div className="flex flex-wrap items-baseline justify-between gap-y-3 text-ink-3">
          <p className="meta">this week&rsquo;s village</p>
          <p className="meta">gathered by Hale</p>
        </div>
      </section>
    </div>
  );
}
