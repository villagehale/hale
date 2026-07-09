import { VillageFeed } from '~/components/hale/village-feed';
import { loadSavedVillageCandidates } from '~/lib/village/queries';

export default async function SavedPage() {
  const candidates = await loadSavedVillageCandidates();

  return (
    <div>
      {/* ── Headline — the modest, app-like header the live pages share. ── */}
      <header className="rise rise-1 mb-8">
        <h1 className="font-display text-[1.75rem] lg:text-[2rem] leading-tight">saved</h1>
        <p className="meta mt-1 text-slate-green">
          Activities you saved for later — private to you, never enrolled or sent for approval.
        </p>
      </header>

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
