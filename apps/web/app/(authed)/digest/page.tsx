import Link from 'next/link';
import { PageCorner } from '~/components/haru/page-corner';
import { Folio } from '~/components/haru/folio';
import { ToneLabel } from '~/components/haru/tone';
import { loadDigest } from '~/lib/dashboard/queries';

export default async function DigestPage() {
  const { tally, entries } = await loadDigest();
  const total = tally.handled + tally.awaiting + tally.needsYou;

  const stats = [
    { label: 'i handled', value: String(tally.handled), detail: 'on your behalf' },
    { label: 'awaiting you', value: String(tally.awaiting), detail: 'tap to decide' },
    { label: 'needs you', value: String(tally.needsYou), detail: 'i cannot act' },
    { label: 'today · total', value: String(total), detail: 'on the table' },
  ];

  return (
    <div>
      <PageCorner folio="i" section="digest · today" />

      {/* ── Headline ────────────────────────────────────────────────────── */}
      <header className="rise rise-1 mb-16 lg:mb-24">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">today's letter</span>
            <p className="meta mt-2">for the family · before breakfast</p>
          </div>
          <div className="lg:col-span-9">
            <h1 className="font-display">
              {total === 0 ? (
                <>nothing <span className="text-apricot-deep">on the table</span> yet this morning.</>
              ) : (
                <>
                  {total} {total === 1 ? 'thing' : 'things'}{' '}
                  <span className="text-apricot-deep">on the table</span> this morning.
                </>
              )}
            </h1>
          </div>
        </div>
      </header>

      {/* ── Tally ───────────────────────────────────────────────────────── */}
      <section className="rise rise-2 mb-16 lg:mb-24">
        <div className="grid grid-cols-2 md:grid-cols-4 border-y border-rule">
          {stats.map((stat, idx) => (
            <div
              key={stat.label}
              className={`py-7 px-5 ${idx > 0 ? 'md:border-l border-rule' : ''} ${idx > 1 ? 'border-t md:border-t-0' : ''} ${idx % 2 === 1 ? 'border-l' : ''}`}
            >
              <span className="eyebrow">{stat.label}</span>
              <p className="font-display text-[2.5rem] lg:text-[3rem] mt-1 tabular leading-none">
                {stat.value}
              </p>
              <p className="meta mt-3">{stat.detail}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Entries ─────────────────────────────────────────────────────── */}
      {entries.length === 0 ? (
        <section className="rise rise-3 panel-oat px-6 py-12 lg:py-16 text-center">
          <p className="font-display text-[1.5rem] lg:text-[1.875rem] text-spruce">
            a quiet morning.
          </p>
          <p className="meta mt-4 text-slate-green">
            no data yet — connect a data source and tomorrow's letter will gather
            what I handled, what's awaiting you, and what only you can do.
          </p>
        </section>
      ) : (
        <section>
          {entries.map((entry, idx) => {
            const delay = `rise-${Math.min(idx + 3, 7)}`;
            return (
              <article
                key={entry.id}
                className={`rise ${delay} py-12 lg:py-14 border-t border-rule first:border-t-0`}
              >
                <div className="grid grid-cols-1 md:grid-cols-12 gap-y-6 md:gap-x-8">
                  <div className="md:col-span-2">
                    <Folio index={idx + 1} />
                    <p className="mt-3 eyebrow text-spruce">{entry.category}</p>
                  </div>

                  <div className="md:col-span-7">
                    <ToneLabel tone={entry.tone} />
                    <p className="mt-4 text-lg lg:text-[1.15rem] leading-relaxed text-spruce">
                      {entry.body}
                    </p>
                  </div>
                </div>
              </article>
            );
          })}
        </section>
      )}

      {/* ── Tomorrow + colophon ─────────────────────────────────────────── */}
      <section className="rise rise-7 mt-16 lg:mt-24 space-y-10">
        <div className="border-t border-rule pt-10 grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">tomorrow</span>
            <p className="meta mt-2">on the horizon</p>
          </div>
          <div className="lg:col-span-9">
            <p className="text-lg text-spruce leading-relaxed">
              I keep tomorrow's small obligations in view — appointments, renewals,
              forms — and surface anything you need to sign by morning. Nothing
              medical ever moves without you.
            </p>
            <div className="mt-6">
              <Link href="/live" className="btn-ghost">watch live →</Link>
            </div>
          </div>
        </div>

        <div className="panel-oat px-6 py-5 flex flex-wrap items-center gap-x-6 gap-y-2">
          {[
            'no autonomous medical actions ever',
            'pipeda · canadian data residency',
          ].map((note) => (
            <span key={note} className="meta">{note}</span>
          ))}
        </div>

        <div className="flex flex-wrap items-baseline justify-between gap-y-3 text-faded-sage">
          <p className="meta">today's digest</p>
          <p className="meta">tended by haru</p>
        </div>
      </section>
    </div>
  );
}
