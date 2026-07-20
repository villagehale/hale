import Link from 'next/link';
import { ExportDataButton } from '~/components/hale/export-data-button';
import { TrailTimeline } from '~/components/hale/trail-timeline';
import { loadTrail } from '~/lib/dashboard/queries';

export default async function TrailPage() {
  const entries = await loadTrail();
  const byHale = entries.filter((entry) => entry.actor === 'hale').length;
  const byParent = entries.length - byHale;

  const stats = [
    { label: 'actions recorded', value: String(entries.length) },
    { label: 'by Hale', value: String(byHale) },
    { label: 'by a parent', value: String(byParent) },
  ];

  return (
    <div>
      {/* Title + back-to-Family breadcrumb live in the shell top bar (§3.2). */}
      {/* ── Tally — a compact, dense stat strip ────────────────────────────── */}
      <section className="rise rise-2 mb-8">
        <div className="grid grid-cols-3 divide-x divide-rule overflow-hidden rounded-2xl border border-rule bg-oat">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="flex min-h-[5.5rem] flex-col justify-center gap-0.5 px-4 py-4 lg:px-5"
            >
              <p className="font-display text-[1.6rem] lg:text-[1.9rem] leading-none text-spruce tabular">
                {stat.value}
              </p>
              <p className="meta text-faded-sage leading-snug">{stat.label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Filters + timeline ─────────────────────────────────────────── */}
      {entries.length === 0 ? (
        <section className="rise rise-4 panel-oat px-6 py-12 lg:py-16 text-center space-y-4">
          <p className="font-display text-[1.5rem] lg:text-[1.875rem] text-spruce">
            nothing on the record yet.
          </p>
          <p className="meta text-slate-green max-w-xl mx-auto">
            connect a calendar or inbox and every action, by Hale or by you, lands here in an
            unbroken, exportable line.
          </p>
          <div className="pt-2">
            <Link href="/settings" className="btn-primary">
              connect a source →
            </Link>
          </div>
        </section>
      ) : (
        <TrailTimeline entries={entries} />
      )}

      <section className="rise rise-7 mt-10 pt-8 border-t border-rule flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
        <p className="meta text-faded-sage">end of trail</p>
        <ExportDataButton />
      </section>
    </div>
  );
}
