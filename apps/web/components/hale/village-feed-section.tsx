import { loadCompanion } from '~/lib/companion/queries';
import { loadVillageFeed } from '~/lib/village/feed';
import { scopeChildren } from './child-scope';
import { FindActivitiesButton } from './find-activities-button';
import { VillageFeed, VillageFeedHeader } from './village-feed';
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
            <FindActivitiesButton />
          </div>
        </div>
      )}
    </>
  );
}

export async function VillageCandidates() {
  const [feed, children] = await Promise.all([loadVillageFeed(), loadCompanion()]);
  if (feed.candidates.length === 0) {
    return (
      <section className="panel-oat px-6 py-12 lg:py-16 text-center">
        <p className="font-display text-[1.5rem] lg:text-[1.875rem] text-spruce">
          a quiet week, for now.
        </p>
        <p className="meta mt-4 text-slate-green">
          no data yet — tell me your area and what your kids love, and I&rsquo;ll gather the
          classes, groups, and drop-ins near you worth a look.
        </p>
        <div className="mt-8">
          <FindActivitiesButton />
        </div>
      </section>
    );
  }
  return (
    <>
      <VillageSearch
        candidates={feed.candidates}
        coarseCenter={feed.coarseCenter}
        area={feed.areaCoarse}
        kids={scopeChildren(children)}
      />
      <FindMoreFooter />
    </>
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
