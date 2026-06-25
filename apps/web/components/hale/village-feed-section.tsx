import { loadVillageFeed } from '~/lib/village/feed';
import { FindActivitiesButton } from './find-activities-button';
import { VillageFeed, VillageFeedHeader } from './village-feed';
import { VillageSearch } from './village-search';

/**
 * The agent-ranked feed is the slowest thing on home/village: loadVillageFeed
 * runs the rank-recommendations agent (an LLM call on a cache miss). Awaiting it
 * at the top of the page blocks the WHOLE render, so navigation stalls on the
 * model. These async sections isolate that await behind a <Suspense> boundary —
 * the page shell streams instantly and the feed fills in with its own skeleton.
 */

export async function HomeVillageFeed() {
  const feed = await loadVillageFeed();
  return (
    <>
      <VillageFeedHeader area={feed.areaCoarse} />
      {feed.candidates.length > 0 ? (
        <VillageFeed candidates={feed.candidates} />
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
  const feed = await loadVillageFeed();
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
  return <VillageSearch candidates={feed.candidates} coarseCenter={feed.coarseCenter} />;
}

export function VillageFeedSkeleton() {
  return (
    <div className="space-y-5" aria-hidden>
      <div className="h-7 w-64 rounded bg-oat animate-pulse" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="panel bg-raised h-40 rounded-xl animate-pulse" />
        ))}
      </div>
    </div>
  );
}
