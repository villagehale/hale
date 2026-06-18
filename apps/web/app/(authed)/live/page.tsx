import { Folio } from '~/components/hale/folio';
import { PageCorner } from '~/components/hale/page-corner';
import { ToneLabel } from '~/components/hale/tone';
import { loadLiveSignals } from '~/lib/dashboard/queries';

export default async function LivePage() {
  const stream = await loadLiveSignals();
  const sources = new Set(stream.map((e) => e.source)).size;
  const lastSignal = stream[0]?.at ?? null;

  return (
    <div>
      <PageCorner folio="02" section="live · listening" />

      <header className="rise rise-1 mb-16 lg:mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">live signals</span>
            <p className="meta mt-2">arriving in chronological order</p>
          </div>
          <div className="lg:col-span-9">
            <h1 className="font-display">
              what i am <span className="text-apricot-deep">noticing</span>,
              <br />
              right now.
            </h1>
          </div>
        </div>
      </header>

      {/* ── Heartbeat ───────────────────────────────────────────────────── */}
      <section className="rise rise-2 mb-12 lg:mb-16">
        <div className="flex flex-wrap items-baseline justify-between gap-y-3 border-y border-rule py-5">
          <div className="flex items-center gap-3">
            <span
              className="block h-2 w-2 rounded-full bg-sage animate-pulse"
              aria-hidden
              style={{ background: 'var(--color-sage)' }}
            />
            <span className="eyebrow text-spruce">listening</span>
            <span className="meta">
              {sources} {sources === 1 ? 'source' : 'sources'} active
            </span>
          </div>
          {lastSignal ? (
            <span className="meta tabular">last signal · {lastSignal}</span>
          ) : (
            <span className="meta tabular">no signals yet</span>
          )}
        </div>
      </section>

      {/* ── Stream ──────────────────────────────────────────────────────── */}
      {stream.length === 0 ? (
        <section className="rise rise-3 panel-oat px-6 py-12 lg:py-16 text-center">
          <p className="font-display text-[1.5rem] lg:text-[1.875rem] text-spruce">
            nothing yet — i'm listening.
          </p>
          <p className="meta mt-4 text-slate-green">
            no signals so far. connect a data source and everything I notice will arrive here, in
            order, with exactly what I did about it.
          </p>
        </section>
      ) : (
        <section>
          {stream.map((e, idx) => {
            const delay = `rise-${Math.min(idx + 3, 7)}`;
            return (
              <article
                key={e.id}
                className={`rise ${delay} py-8 lg:py-10 border-t border-rule first:border-t-0`}
              >
                <div className="grid grid-cols-1 md:grid-cols-12 gap-y-3 md:gap-x-8">
                  <div className="md:col-span-2">
                    <Folio index={idx + 1} />
                    <p className="meta tabular mt-2">{e.at}</p>
                  </div>
                  <div className="md:col-span-3">
                    <span className="eyebrow">source</span>
                    <p className="meta text-spruce mt-1">{e.source}</p>
                  </div>
                  <div className="md:col-span-7">
                    <ToneLabel tone={e.tone} />
                    <p className="mt-3 text-lg text-spruce leading-relaxed">{e.summary}</p>
                    <p className="mt-3 meta italic">— {e.decision}</p>
                  </div>
                </div>
              </article>
            );
          })}
        </section>
      )}

      {/* ── Privacy note ───────────────────────────────────────────────── */}
      <section className="rise rise-7 mt-16 lg:mt-24 pt-10 border-t border-rule">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-4 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">privacy</span>
            <p className="meta mt-2">a standing promise</p>
          </div>
          <div className="lg:col-span-9 text-slate-green text-lg leading-relaxed">
            Every signal above stays in Hale's Canadian database. Nothing has been sent to a third
            party except where you connected one. Your child's name, date of birth, and medical
            details are encrypted at rest with keys you can rotate. You can export or delete
            everything you see here in one tap from the{' '}
            <span className="font-display italic">trail</span>.
          </div>
        </div>
      </section>
    </div>
  );
}
