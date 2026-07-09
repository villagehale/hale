import Link from 'next/link';
import { loadCompanion } from '~/lib/companion/queries';
import { loadVillageFeed } from '~/lib/village/feed';
import { loadSavedVillageCandidates, loadVillage } from '~/lib/village/queries';
import type { Season } from '~/lib/village/visibility';
import { scopeChildren } from './child-scope-core';
import { FindActivitiesButton } from './find-activities-button';
import { VillageFeed, VillageFeedHeader } from './village-feed';
import { VillageRail } from './village-rail';
import { VillageSearch } from './village-search';

/**
 * loadVillageFeed is now a pure DB read (the ~25s ranker is materialized in the
 * background, never in this request path). These async sections keep the await
 * behind a <Suspense> boundary anyway — the page shell streams instantly and the
 * feed fills in with its own skeleton on the quick DB round-trip.
 */

export async function HomeVillageFeed() {
  const feed = await loadVillageFeed();
  return (
    <>
      <VillageFeedHeader area={feed.areaCoarse} />
      {feed.candidates.length > 0 ? (
        <>
          <VillageFeed candidates={feed.candidates} area={feed.areaCoarse} />
          <FindMoreFooter />
        </>
      ) : (
        <div className="panel-oat px-6 py-12 lg:py-16 text-center space-y-4">
          <p className="font-display text-[1.5rem] lg:text-[1.875rem] text-spruce">
            your village is quiet, for now.
          </p>
          <p className="meta text-slate-green max-w-xl mx-auto">
            tell Hale your area and what your kids love, and it&rsquo;ll gather the classes, groups,
            and drop-ins near you worth a look — then rank them for your family.
          </p>
          <div className="pt-2">
            <FindActivitiesButton label="find this week's activities" />
          </div>
        </div>
      )}
    </>
  );
}

/**
 * The village BOARD — the /village primary surface as a responsive 3-column board:
 * the search + cadence controls and the agent-ranked near-you list with the map
 * persistently beside it (VillageSearch layout="board"), plus a server-rendered
 * right rail (Upcoming / Saved / From Hale). On mobile it stacks to one column and
 * the map returns to a list/map toggle so it never crowds the list.
 *
 * Every panel traces to a real loader; nothing is fabricated. Teen redaction (rule
 * #1) is already applied upstream in the mapper, so the board never re-implements it.
 */
export async function VillageCandidates() {
  const [feed, children, saved] = await Promise.all([
    loadVillageFeed(),
    loadCompanion(),
    loadSavedVillageCandidates(),
  ]);
  if (feed.candidates.length === 0) {
    return (
      <section className="panel-oat px-6 py-12 lg:py-16 text-center">
        <p className="font-display text-[1.5rem] lg:text-[1.875rem] text-spruce">
          a quiet week, for now.
        </p>
        <p className="meta mt-4 text-slate-green">
          tell Hale your area and what your kids love, and it&rsquo;ll gather the classes, groups,
          and drop-ins near you worth a look.
        </p>
        <div className="mt-8">
          <FindActivitiesButton label="find this week's activities" />
        </div>
      </section>
    );
  }
  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-10 lg:gap-x-8 lg:items-start">
        <div className="lg:col-span-9 min-w-0">
          <VillageSearch
            candidates={feed.candidates}
            coarseCenter={feed.coarseCenter}
            area={feed.areaCoarse}
            kids={scopeChildren(children)}
            layout="board"
          />
        </div>
        <div className="lg:col-span-3">
          <VillageRail candidates={feed.candidates} saved={saved} />
        </div>
      </div>
      <FindMoreFooter />
    </>
  );
}

/**
 * A season-scoped search RUN — what `?season=` renders instead of the standing
 * feed. Reads that season's search candidates (loadVillage skips the calendar-
 * season gate for a search read), fronted by a banner that names the season and
 * clears back to the standing feed. Zero candidates is an honest empty state, not
 * a blank surface (rule #8). Renders the SAME teen-redacted views loadVillage
 * returns (rule #1) — no re-ranking, no new location signal.
 */
export async function VillageSearchRun({ season }: { season: Season }) {
  const { candidates } = await loadVillage({ searchSeason: season });
  return (
    <>
      <SeasonBanner season={season} />
      {candidates.length === 0 ? (
        <section className="panel-oat px-6 py-12 lg:py-16 text-center">
          <p className="font-display text-[1.5rem] lg:text-[1.875rem] text-spruce">
            no {season} activities found near you yet.
          </p>
          <p className="meta mt-4 text-slate-green">
            Hale looked ahead to {season} but came up quiet — try another season, or come back to
            your weekly feed.
          </p>
        </section>
      ) : (
        <VillageFeed candidates={candidates} />
      )}
    </>
  );
}

/** The "you are viewing a search run" banner: names the season and offers an
 * instant clear back to the standing weekly feed (a plain link — no discovery
 * cost, unlike a season chip). */
function SeasonBanner({ season }: { season: Season }) {
  return (
    <div className="panel-oat px-6 py-4 mb-8 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
      <span className="meta text-spruce">
        showing: <span className="text-apricot-deep">{season}</span> activities
      </span>
      <Link href="/village" className="link">
        back to your feed
      </Link>
    </div>
  );
}

/**
 * The quiet re-search at the foot of a populated feed — the same re-runnable
 * discovery as the empty state, styled as a secondary action so it gathers more
 * without competing with the ranked picks above it.
 */
function FindMoreFooter() {
  return (
    <div className="mt-16 lg:mt-20 pt-10 border-t border-rule flex flex-col items-center gap-3 text-center">
      <p className="meta text-slate-green">seen these already?</p>
      <FindActivitiesButton variant="secondary" label="find more near you" />
    </div>
  );
}

export function VillageFeedSkeleton() {
  return (
    <div className="space-y-5" aria-hidden>
      <div className="h-7 w-64 rounded bg-oat animate-pulse" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="panel bg-raised h-40 animate-pulse" />
      ))}
    </div>
  );
}
