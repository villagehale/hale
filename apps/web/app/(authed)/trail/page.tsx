import { PageCorner } from '~/components/hale/page-corner';
import { TrailTimeline } from '~/components/hale/trail-timeline';
import { loadTrail } from '~/lib/dashboard/queries';

export default async function TrailPage() {
  const entries = await loadTrail();
  const byHale = entries.filter((entry) => entry.actor === 'hale').length;
  const byParent = entries.length - byHale;

  const stats = [
    { label: 'recorded', value: String(entries.length), detail: 'actions' },
    { label: 'by Hale', value: String(byHale), detail: 'autonomous' },
    { label: 'by a parent', value: String(byParent), detail: 'decisions' },
    { label: 'reverted', value: '0', detail: 'this view' },
  ];

  return (
    <div>
      <PageCorner folio="history" section="the record" />

      <header className="rise rise-1 mb-16 lg:mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">history</span>
            <p className="meta mt-2">everything done, by whom, when</p>
          </div>
          <div className="lg:col-span-9">
            <h1 className="font-display">
              the full <span className="text-apricot-deep">record</span>
              <br />
              for your family.
            </h1>
          </div>
        </div>
      </header>

      {/* ── Tally ──────────────────────────────────────────────────────── */}
      <section className="rise rise-2 mb-12 lg:mb-16">
        <div className="grid grid-cols-2 md:grid-cols-4 border-y border-rule">
          {stats.map((stat, idx) => (
            <div
              key={stat.label}
              className={`py-7 px-5 ${idx > 0 ? 'md:border-l border-rule' : ''} ${idx > 1 ? 'border-t md:border-t-0' : ''} ${idx % 2 === 1 ? 'border-l' : ''}`}
            >
              <span className="eyebrow">{stat.label}</span>
              <p className="font-display text-[2.5rem] mt-1 tabular leading-none">
                {stat.value}
              </p>
              <p className="meta mt-3">{stat.detail}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Filters + timeline ─────────────────────────────────────────── */}
      {entries.length === 0 ? (
        <section className="rise rise-4 panel-oat px-6 py-12 lg:py-16 text-center">
          <p className="font-display text-[1.5rem] lg:text-[1.875rem] text-spruce">
            nothing on the record yet.
          </p>
          <p className="meta mt-4 text-slate-green">
            no data yet — connect a data source and every action, by Hale or by
            you, lands here in an unbroken, exportable line.
          </p>
        </section>
      ) : (
        <TrailTimeline entries={entries} />
      )}

      <section className="rise rise-7 mt-16 lg:mt-20 pt-10 border-t border-rule flex flex-wrap items-baseline justify-between gap-y-3 text-faded-sage">
        <p className="meta">end of trail</p>
        <p className="meta">earlier entries available on request</p>
      </section>
    </div>
  );
}
