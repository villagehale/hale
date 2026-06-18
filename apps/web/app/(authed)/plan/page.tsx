import { PageCorner } from '~/components/hale/page-corner';
import { Folio } from '~/components/hale/folio';
import { ShareWeekButton } from '~/components/hale/share-week-button';
import { type ChildCompanionView, loadCompanion } from '~/lib/companion/queries';
import { loadVillage } from '~/lib/village/queries';

function duePhrase(dueInWeeks: number): string {
  if (dueInWeeks <= 0) return 'this week';
  if (dueInWeeks === 1) return 'next week';
  if (dueInWeeks < 8) return `in ${dueInWeeks} weeks`;
  const months = Math.round(dueInWeeks / 4.345);
  return `in ~${months} ${months === 1 ? 'month' : 'months'}`;
}

interface PlanHealthItem {
  childName: string;
  what: string;
  when: string;
}

/** The soonest upcoming health item per child — the week's "coming up" list. */
function comingUp(children: ChildCompanionView[]): PlanHealthItem[] {
  return children
    .map((child) => {
      const next = child.nextHealth[0];
      if (!next) return null;
      return {
        childName: child.name ?? 'your child',
        what: next.what,
        when: duePhrase(next.dueInWeeks),
      };
    })
    .filter((item): item is PlanHealthItem => item !== null);
}

export default async function PlanPage() {
  const [village, children] = await Promise.all([loadVillage(), loadCompanion()]);
  const { routine } = village;
  const upcoming = comingUp(children);
  const hasPlan = (routine?.items.length ?? 0) > 0 || upcoming.length > 0;

  return (
    <div>
      <PageCorner folio="plan" section="plan · your week" />

      {/* ── Headline ────────────────────────────────────────────────────── */}
      <header className="rise rise-1 mb-16 lg:mb-24">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">your week</span>
            <p className="meta mt-2">what&rsquo;s coming for your kids</p>
          </div>
          <div className="lg:col-span-9">
            <h1 className="font-display">
              {hasPlan ? (
                <>
                  here&rsquo;s your <span className="text-apricot-deep">week ahead</span>.
                </>
              ) : (
                <>
                  a quiet <span className="text-apricot-deep">week ahead</span>.
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

      {/* ── Coming up for your kids ─────────────────────────────────────── */}
      {upcoming.length > 0 ? (
        <section className="rise rise-3 mb-16">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 border-t border-rule pt-10">
            <div className="lg:col-span-3">
              <span className="eyebrow">coming up</span>
              <p className="meta mt-2">checkups · immunizations</p>
            </div>
            <div className="lg:col-span-9 space-y-4">
              {upcoming.map((item, idx) => (
                <div
                  key={`${item.childName}-${item.what}`}
                  className="flex items-baseline gap-4 border-t border-rule pt-4 first:border-t-0 first:pt-0"
                >
                  <Folio index={idx + 1} />
                  <div>
                    <p className="text-lg text-spruce leading-relaxed">
                      {item.what} · {item.childName}
                    </p>
                    <p className="meta mt-1 text-slate-green">{item.when}</p>
                  </div>
                </div>
              ))}
              <p className="meta pt-2 text-slate-green">
                timing is the standard Canadian schedule — confirm with your provider or local
                public health.
              </p>
            </div>
          </div>
        </section>
      ) : null}

      {/* ── Empty state ─────────────────────────────────────────────────── */}
      {!hasPlan ? (
        <section className="rise rise-3 panel-oat px-6 py-12 lg:py-16 text-center">
          <p className="font-display text-[1.5rem] lg:text-[1.875rem] text-spruce">
            nothing scheduled yet this week.
          </p>
          <p className="meta mt-4 text-slate-green">
            once your kids&rsquo; birthdays and your area are on file, this page gathers the week
            ahead — the routine for your family and what&rsquo;s coming up for each child.
          </p>
        </section>
      ) : null}

      {/* ── Colophon ────────────────────────────────────────────────────── */}
      <section className="rise rise-7 mt-16 lg:mt-24 space-y-10">
        <div className="panel-oat px-6 py-5 flex flex-wrap items-center gap-x-6 gap-y-2">
          {[
            'always confirm health and milestones with your provider',
            "your family's data stays in canada · pipeda",
          ].map((note) => (
            <span key={note} className="meta">
              {note}
            </span>
          ))}
        </div>

        <div className="flex flex-wrap items-baseline justify-between gap-y-3 text-faded-sage">
          <p className="meta">your week</p>
          <p className="meta">gathered by Hale</p>
        </div>
      </section>
    </div>
  );
}
