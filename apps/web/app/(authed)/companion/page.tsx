import Link from 'next/link';
import { BookButton } from '~/components/hale/book-button';
import { PageCorner } from '~/components/hale/page-corner';
import { Folio } from '~/components/hale/folio';
import { QuickLog } from '~/components/hale/quick-log';
import { RecentLogs } from '~/components/hale/recent-logs';
import { type ChildCompanionView, loadCompanion } from '~/lib/companion/queries';
import { loadRecentLogs } from '~/lib/companion/recent-logs';

const STAGE_LABEL: Record<ChildCompanionView['stage'], string> = {
  newborn: 'newborn',
  toddler: 'toddler',
  child: 'school-age',
  teenager: 'teenager',
};

const TIMING_LABEL: Record<ChildCompanionView['milestones'][number]['timing'], string> = {
  upcoming: 'coming up',
  in_window: 'around now',
  watch: 'worth asking',
};

function agePhrase(ageMonths: number): string {
  if (ageMonths < 24) return `${ageMonths} ${ageMonths === 1 ? 'month' : 'months'}`;
  const years = Math.floor(ageMonths / 12);
  return `${years} ${years === 1 ? 'year' : 'years'}`;
}

function duePhrase(dueInWeeks: number): string {
  if (dueInWeeks <= 0) return 'due now';
  if (dueInWeeks === 1) return 'in 1 week';
  if (dueInWeeks < 8) return `in ${dueInWeeks} weeks`;
  const months = Math.round(dueInWeeks / 4.345);
  return `in ~${months} ${months === 1 ? 'month' : 'months'}`;
}

export default async function CompanionPage() {
  const [children, recentLogs] = await Promise.all([loadCompanion(), loadRecentLogs()]);

  return (
    <div>
      <PageCorner folio="10" section="companion · 0–18" />

      {/* ── Headline ────────────────────────────────────────────────────── */}
      <header className="rise rise-1 mb-16 lg:mb-24">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">your companion</span>
            <p className="meta mt-2">where each child is · what’s next</p>
          </div>
          <div className="lg:col-span-9">
            <h1 className="font-display">
              {children.length === 0 ? (
                <>
                  growing up, <span className="text-apricot-deep">held</span> at every age.
                </>
              ) : (
                <>
                  {children.length} {children.length === 1 ? 'child' : 'children'},{' '}
                  <span className="text-apricot-deep">growing</span> at their own pace.
                </>
              )}
            </h1>
          </div>
        </div>
      </header>

      {children.length === 0 ? (
        <section className="rise rise-3 panel-oat px-6 py-12 lg:py-16 text-center">
          <p className="font-display text-[1.5rem] lg:text-[1.875rem] text-spruce">
            no children added yet.
          </p>
          <p className="meta mt-4 text-slate-green">
            once a child’s birthday is on file, this page gathers their stage, the next routine
            checkups and immunizations, and the milestones worth watching for — all confirmed with
            your own provider.
          </p>
        </section>
      ) : (
        <section className="space-y-16 lg:space-y-24">
          {children.map((child, idx) => {
            const delay = `rise-${Math.min(idx + 2, 7)}`;
            return (
              <article key={child.id} className={`rise ${delay}`}>
                {/* Child header */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-4 lg:gap-x-12 border-b border-rule pb-6">
                  <div className="lg:col-span-3">
                    <Folio index={idx + 1} />
                    <span className="stamp mt-3 inline-block">{STAGE_LABEL[child.stage]}</span>
                  </div>
                  <div className="lg:col-span-9">
                    <h2 className="font-display text-[1.75rem] lg:text-[2.25rem] leading-tight">
                      {child.name ?? 'your child'}
                    </h2>
                    <p className="meta mt-2 text-slate-green">{agePhrase(child.ageMonths)} old</p>
                  </div>
                </div>

                {/* Next health items */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-4 lg:gap-x-12 pt-8">
                  <div className="lg:col-span-3">
                    <span className="eyebrow">next health items</span>
                    <p className="meta mt-2 text-slate-green">routine checkups · immunizations</p>
                  </div>
                  <div className="lg:col-span-9">
                    {child.nextHealth.length === 0 ? (
                      <p className="text-lg text-spruce leading-relaxed">
                        no routine items left on the standard schedule — keep up periodic visits
                        with your provider.
                      </p>
                    ) : (
                      <ul className="space-y-4">
                        {child.nextHealth.slice(0, 3).map((item) => (
                          <li
                            key={`${item.ageMonths}-${item.kind}`}
                            className="border-t border-rule pt-4 first:border-t-0 first:pt-0"
                          >
                            <div className="flex items-baseline gap-4">
                              <span className="shrink-0 w-28">
                                {item.dueInWeeks <= 0 ? (
                                  <span className="stamp">{duePhrase(item.dueInWeeks)}</span>
                                ) : (
                                  <span className="eyebrow text-spruce">
                                    {duePhrase(item.dueInWeeks)}
                                  </span>
                                )}
                              </span>
                              <span className="text-lg text-spruce leading-relaxed">
                                {item.what}
                              </span>
                            </div>
                            <div className="mt-2">
                              <BookButton what={item.what} childId={child.id} />
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="meta mt-4 text-slate-green">
                      timing is the standard Canadian schedule — confirm with your provider or local
                      public health.
                    </p>
                  </div>
                </div>

                {/* Milestones */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-4 lg:gap-x-12 pt-10">
                  <div className="lg:col-span-3">
                    <span className="eyebrow">milestones</span>
                    <p className="meta mt-2 text-slate-green">most kids, around this stage</p>
                  </div>
                  <div className="lg:col-span-9">
                    <ul className="space-y-4">
                      {child.milestones.map((milestone) => (
                        <li
                          key={milestone.what}
                          className="flex items-baseline gap-4 border-t border-rule pt-4 first:border-t-0 first:pt-0"
                        >
                          <span className="shrink-0 w-28">
                            {milestone.timing === 'in_window' ? (
                              <span className="stamp">{TIMING_LABEL[milestone.timing]}</span>
                            ) : (
                              <span className="eyebrow text-spruce">
                                {TIMING_LABEL[milestone.timing]}
                              </span>
                            )}
                          </span>
                          <span className="text-lg text-spruce leading-relaxed">
                            {milestone.what}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <p className="meta mt-4 text-slate-green">
                      every child grows at their own pace — if something’s not happening yet, it’s
                      worth asking your provider, never a verdict.
                    </p>
                  </div>
                </div>

                {/* What matters now / what's next */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-4 lg:gap-x-12 pt-10">
                  <div className="lg:col-span-3">
                    <span className="eyebrow">what matters now</span>
                  </div>
                  <div className="lg:col-span-9 space-y-5">
                    <ul className="space-y-3">
                      {child.whatsNow.map((point) => (
                        <li key={point} className="text-lg text-spruce leading-relaxed">
                          {point}
                        </li>
                      ))}
                    </ul>
                    <div className="panel-oat px-6 py-5">
                      <span className="eyebrow">what’s next</span>
                      <p className="meta mt-2 text-spruce">{child.whatsNext}</p>
                    </div>
                    <div className="pt-2">
                      <Link href={`/coach?child=${child.id}`} className="btn-ghost">
                        ask Hale about {child.name ?? 'your child'} →
                      </Link>
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </section>
      )}

      {/* ── Recent logs + quick log ─────────────────────────────────────── */}
      {children.length > 0 ? (
        <section className="rise rise-7 mt-16 lg:mt-24">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 border-t border-rule pt-10">
            <div className="lg:col-span-3">
              <span className="eyebrow">recent logs</span>
              <p className="meta mt-2 text-slate-green">feeds · naps · milestones</p>
            </div>
            <div className="lg:col-span-9 space-y-8">
              <RecentLogs logs={recentLogs} />
              <QuickLog kids={children.map((c) => ({ id: c.id, name: c.name, stage: c.stage }))} />
            </div>
          </div>
        </section>
      ) : null}

      {/* ── Colophon ────────────────────────────────────────────────────── */}
      <section className="rise rise-7 mt-16 lg:mt-24 space-y-10">
        <div className="panel-oat px-6 py-5 flex flex-wrap items-center gap-x-6 gap-y-2">
          {[
            'supportive guidance, never a diagnosis',
            'always confirm health and milestones with your provider',
            "your family's data stays in canada · pipeda",
          ].map((note) => (
            <span key={note} className="meta">
              {note}
            </span>
          ))}
        </div>

        <div className="flex flex-wrap items-baseline justify-between gap-y-3 text-faded-sage">
          <p className="meta">your companion</p>
          <p className="meta">tended by Hale</p>
        </div>
      </section>
    </div>
  );
}
