import { FindActivitiesButton } from '~/components/hale/find-activities-button';
import { PageCorner } from '~/components/hale/page-corner';
import { ShareWeekButton } from '~/components/hale/share-week-button';
import { VillageSearch } from '~/components/hale/village-search';
import { loadVillage } from '~/lib/village/queries';

export default async function VillagePage() {
  const { candidates, routine } = await loadVillage();

  return (
    <div>
      <PageCorner folio="09" section="village · this week" />

      {/* ── Headline ────────────────────────────────────────────────────── */}
      <header className="rise rise-1 mb-16 lg:mb-24">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">your village</span>
            <p className="meta mt-2">near you · for this week</p>
          </div>
          <div className="lg:col-span-9">
            <h1 className="font-display">
              {candidates.length === 0 ? (
                <>
                  nothing <span className="text-apricot-deep">to gather</span> yet this week.
                </>
              ) : (
                <>
                  {candidates.length} {candidates.length === 1 ? 'thing' : 'things'}{' '}
                  <span className="text-apricot-deep">near you</span> this week.
                </>
              )}
            </h1>
          </div>
        </div>
      </header>

      {/* ── This week's routine ─────────────────────────────────────────── */}
      {routine && routine.items.length > 0 ? (
        <section className="rise rise-2 mb-16 lg:mb-20 panel">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-8">
            <div className="lg:col-span-3">
              <span className="eyebrow">a gentle routine</span>
              <p className="meta mt-2">week of {routine.weekOf}</p>
              <div className="mt-5">
                <ShareWeekButton />
              </div>
            </div>
            <div className="lg:col-span-9 space-y-5">
              {routine.items.map((item, idx) => (
                <div
                  key={`${item.kind}-${idx}`}
                  className="flex items-baseline gap-4 border-t border-rule pt-5 first:border-t-0 first:pt-0"
                >
                  <span className="eyebrow text-spruce shrink-0">{item.kind}</span>
                  <div>
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

      {/* ── Candidates ──────────────────────────────────────────────────── */}
      {candidates.length === 0 ? (
        <section className="rise rise-3 panel-oat px-6 py-12 lg:py-16 text-center">
          <p className="font-display text-[1.5rem] lg:text-[1.875rem] text-spruce">
            a quiet week, for now.
          </p>
          <p className="meta mt-4 text-slate-green">
            no data yet — tell me your area and what your kids love, and I'll gather the classes,
            groups, and drop-ins near you worth a look.
          </p>
          <div className="mt-8">
            <FindActivitiesButton />
          </div>
        </section>
      ) : (
        <VillageSearch candidates={candidates} />
      )}

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
