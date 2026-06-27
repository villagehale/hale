import { Suspense } from 'react';
import { BuildYourVillage } from '~/components/hale/build-your-village';
import { PageCorner } from '~/components/hale/page-corner';
import { VillageCandidates, VillageFeedSkeleton } from '~/components/hale/village-feed-section';
import { loadVillage } from '~/lib/village/queries';

export default async function VillagePage() {
  const { routine } = await loadVillage();
  const hasRoutine = (routine?.items.length ?? 0) > 0;

  return (
    <div>
      <PageCorner section="village · near you" />

      {/* ── Headline ────────────────────────────────────────────────────── */}
      <header className="rise rise-1 mb-16 lg:mb-24">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">your village</span>
            <p className="meta mt-2">ranked for your family by Hale</p>
          </div>
          <div className="lg:col-span-9">
            <h1 className="font-display">
              what your <span className="text-apricot-deep">village</span> recommends near you.
            </h1>
          </div>
        </div>
      </header>

      {/* ── Build your village (the growth engine — always visible) ──────── */}
      <div className="rise rise-2 mb-16 lg:mb-20">
        <BuildYourVillage nothingToShare={!hasRoutine} />
      </div>

      {/* ── This week's routine ─────────────────────────────────────────── */}
      {routine && hasRoutine ? (
        <section className="rise rise-2 mb-16 lg:mb-20 panel">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-8">
            <div className="lg:col-span-3">
              <span className="eyebrow">a gentle routine</span>
              <p className="meta mt-2">week of {routine.weekOf}</p>
            </div>
            <div className="lg:col-span-9 space-y-5">
              {routine.items.map((item, idx) => (
                <div
                  key={`${item.kind}-${idx}`}
                  className="flex items-baseline gap-4 border-t border-rule pt-5 first:border-t-0 first:pt-0"
                >
                  <span className="eyebrow text-spruce shrink-0">{item.kind}</span>
                  <div data-hale-pii>
                    <p className="text-lg text-spruce leading-relaxed">{item.title}</p>
                    {item.stageNote ? (
                      <p className="meta mt-1 text-slate-green">{item.stageNote}</p>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {/* ── Candidates — streamed (the agent ranker must not block the page) ─ */}
      <div className="rise rise-3">
        <Suspense fallback={<VillageFeedSkeleton />}>
          <VillageCandidates />
        </Suspense>
      </div>

      {/* ── Colophon ────────────────────────────────────────────────────── */}
      <section className="rise rise-7 mt-16 lg:mt-24 space-y-10">
        <div className="panel-oat px-6 py-5 flex flex-wrap items-center gap-x-6 gap-y-2">
          {[
            'only your coarse area is ever used · never a precise location',
            "your family's data stays in canada · pipeda",
          ].map((note) => (
            <span key={note} className="meta">
              {note}
            </span>
          ))}
        </div>

        <div className="flex flex-wrap items-baseline justify-between gap-y-3 text-faded-sage">
          <p className="meta">this week's village</p>
          <p className="meta">gathered by Hale</p>
        </div>
      </section>
    </div>
  );
}
