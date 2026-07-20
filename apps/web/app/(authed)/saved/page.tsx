import { VillageFeed } from '~/components/hale/village-feed';
import { loadSavedVillageCandidates } from '~/lib/village/queries';

export default async function SavedPage() {
  const candidates = await loadSavedVillageCandidates();

  return (
    <div>
      {/* Title + back-to-Family breadcrumb live in the shell top bar (§3.2). */}
      <div className="rise rise-2">
        {candidates.length > 0 ? (
          <VillageFeed candidates={candidates} />
        ) : (
          <section className="panel-oat px-6 py-12 lg:py-16 text-center">
            <p className="font-display text-[1.5rem] lg:text-[1.875rem] text-spruce">
              nothing saved yet
            </p>
            <p className="meta mt-4 text-slate-green max-w-xl mx-auto">
              Tap the bookmark on a village pick to keep it here.
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
