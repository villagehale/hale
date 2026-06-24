import Link from 'next/link';
import { Baby, CalendarPlus } from 'lucide-react';
import { BookButton } from '~/components/hale/book-button';
import { ConciergeAsk } from '~/components/hale/concierge-ask';
import { FindActivitiesButton } from '~/components/hale/find-activities-button';
import { LongDate } from '~/components/hale/long-date';
import { QuickLog } from '~/components/hale/quick-log';
import { VillageFeed, VillageFeedHeader } from '~/components/hale/village-feed';
import { Card } from '~/components/ui/card';
import { Icon } from '~/components/ui/icon';
import { authConfigured } from '~/lib/auth-config';
import { loadThreadShellForRequest } from '~/lib/coach/thread';
import { type ChildCompanionView, loadCompanion } from '~/lib/companion/queries';
import { loadVillageFeed } from '~/lib/village/feed';

function duePhrase(dueInWeeks: number): string {
  if (dueInWeeks <= 0) return 'due now';
  if (dueInWeeks === 1) return 'due in 1 week';
  if (dueInWeeks < 8) return `due in ${dueInWeeks} weeks`;
  const months = Math.round(dueInWeeks / 4.345);
  return `due in ~${months} ${months === 1 ? 'month' : 'months'}`;
}

/** The single milestone worth nudging now: prefer one inside its window. */
function milestoneInWindow(child: ChildCompanionView) {
  return child.milestones.find((m) => m.timing === 'in_window') ?? child.milestones[0] ?? null;
}

export default async function HomePage() {
  const canAsk = authConfigured();
  const [children, feed, askSeed] = await Promise.all([
    loadCompanion(),
    loadVillageFeed(),
    loadThreadShellForRequest(),
  ]);

  if (children.length === 0) {
    return (
      <div>
        <div className="page-corner">
          <span className="ml-auto">
            <LongDate />
          </span>
        </div>

        <header className="rise rise-1 mb-12 lg:mb-16">
          <h1 className="font-display">
            welcome to <span className="text-apricot-deep">Hale</span>.
          </h1>
        </header>

        <section className="rise rise-3 panel-oat px-6 py-12 lg:py-16 text-center space-y-4">
          <p className="font-display text-[1.5rem] lg:text-[1.875rem] text-spruce">
            tell Hale about your kid.
          </p>
          <p className="meta text-slate-green max-w-xl mx-auto">
            add your child&rsquo;s birthday and your area, and this page fills with your
            village — the genuinely good local things families like yours recommend near you,
            ranked for your family.
          </p>
          <div className="pt-2">
            <Link href="/onboarding" className="btn-primary">
              set up your family →
            </Link>
          </div>
        </section>

        <section className="rise rise-4 mt-12">
          <ConciergeAsk canAsk={canAsk} seed={askSeed} />
        </section>
      </div>
    );
  }

  return (
    <div>
      <div className="page-corner">
        <span className="ml-auto">
          <LongDate />
        </span>
      </div>

      {/* ── The village — the agent-ranked, trusted feed (the hero) ──────── */}
      <section className="rise rise-1 mb-16 lg:mb-20">
        <VillageFeedHeader area={feed.areaCoarse} />
        {feed.candidates.length > 0 ? (
          <VillageFeed candidates={feed.candidates} />
        ) : (
          <div className="panel-oat px-6 py-12 lg:py-16 text-center space-y-4">
            <p className="font-display text-[1.5rem] lg:text-[1.875rem] text-spruce">
              your village is quiet, for now.
            </p>
            <p className="meta text-slate-green max-w-xl mx-auto">
              tell Hale your area and what your kids love, and it&rsquo;ll gather the classes,
              groups, and drop-ins near you worth a look — then rank them for your family.
            </p>
            <div className="pt-2">
              <FindActivitiesButton />
            </div>
          </div>
        )}
      </section>

      {/* ── Ask Hale — the concierge (present, not the hero) ─────────────── */}
      <section className="rise rise-2 mb-16 lg:mb-20">
        <ConciergeAsk canAsk={canAsk} seed={askSeed} />
      </section>

      {/* ── Today, per child (the quiet Companion — distinct from the village) ─ */}
      <section className="space-y-12 lg:space-y-16">
        {children.map((child, idx) => {
          const milestone = milestoneInWindow(child);
          const nextHealth = child.nextHealth[0] ?? null;
          const whatsNow = child.whatsNow[0] ?? null;
          const delay = `rise-${Math.min(idx + 3, 7)}`;
          return (
            <article key={child.id} className={`rise ${delay}`}>
              <div className="flex items-center gap-3 border-b border-rule pb-4 mb-6">
                <Icon as={Baby} size={20} className="text-apricot-deep" />
                <h2 className="font-display text-[1.5rem] lg:text-[1.875rem] leading-tight">
                  today for {child.name ?? 'your child'}
                </h2>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                {nextHealth ? (
                  <Card>
                    <span className="eyebrow text-apricot-deep">
                      {duePhrase(nextHealth.dueInWeeks)}
                    </span>
                    <p className="font-display text-[1.25rem] mt-2 leading-snug">
                      {nextHealth.what}
                    </p>
                    <p className="meta mt-3 text-slate-green">{nextHealth.note}</p>
                    <div className="mt-4">
                      <BookButton what={nextHealth.what} childId={child.id} />
                    </div>
                  </Card>
                ) : whatsNow ? (
                  <Card href="/companion">
                    <span className="eyebrow">what matters now</span>
                    <p className="font-display text-[1.25rem] mt-2 leading-snug">{whatsNow}</p>
                    <span className="link mt-4 inline-block">
                      see {child.name ?? 'your child'} →
                    </span>
                  </Card>
                ) : null}

                {milestone ? (
                  <Card href="/companion">
                    <span className="eyebrow">around this age</span>
                    <p className="font-display text-[1.25rem] mt-2 leading-snug">
                      {milestone.what}
                    </p>
                    <p className="meta mt-3 text-slate-green">
                      most kids, around this stage — never a verdict.
                    </p>
                    <span className="link mt-4 inline-block">
                      see {child.name ?? 'your child'} →
                    </span>
                  </Card>
                ) : null}
              </div>
            </article>
          );
        })}
      </section>

      {/* ── Quick-log ───────────────────────────────────────────────────── */}
      <section className="rise rise-7 mt-16 lg:mt-20 pt-10 border-t border-rule space-y-4">
        <QuickLog kids={children.map((c) => ({ id: c.id, name: c.name, stage: c.stage }))} />
        <span className="meta flex items-center gap-2 text-slate-green">
          <Icon as={CalendarPlus} size={16} />
          kept in {children[0]?.name ?? 'your child'}&rsquo;s companion
        </span>
      </section>
    </div>
  );
}
