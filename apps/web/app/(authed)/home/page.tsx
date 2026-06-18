import Link from 'next/link';
import { Baby, CalendarPlus, Moon, Sparkles, Utensils } from 'lucide-react';
import { AskBox } from '~/components/hale/ask-box';
import { PageCorner } from '~/components/hale/page-corner';
import { Card } from '~/components/ui/card';
import { Icon } from '~/components/ui/icon';
import { authConfigured } from '~/lib/auth-config';
import { type ChildCompanionView, loadCompanion } from '~/lib/companion/queries';
import { loadVillage } from '~/lib/village/queries';

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

const QUICK_LOG = [
  { label: 'log a feed', icon: Utensils },
  { label: 'log a nap', icon: Moon },
  { label: 'note a milestone', icon: Sparkles },
] as const;

export default async function HomePage() {
  const canAsk = authConfigured();
  const [children, village] = await Promise.all([loadCompanion(), loadVillage()]);
  const topActivities = village.candidates.slice(0, 2);

  if (children.length === 0) {
    return (
      <div>
        <PageCorner folio="home" section="home · today" />

        <header className="rise rise-1 mb-12 lg:mb-16">
          <h1 className="font-display">
            welcome to <span className="text-apricot-deep">Hale</span>.
          </h1>
        </header>

        <section className="rise rise-2 mb-12">
          <AskBox canAsk={canAsk} />
        </section>

        <section className="rise rise-3 panel-oat px-6 py-12 lg:py-16 text-center space-y-4">
          <p className="font-display text-[1.5rem] lg:text-[1.875rem] text-spruce">
            tell Hale about your kid.
          </p>
          <p className="meta text-slate-green max-w-xl mx-auto">
            add your child&rsquo;s birthday and your area, and this page fills with what&rsquo;s
            next for them — the upcoming checkups, the milestones around now, and the good
            things near you this week.
          </p>
          <div className="pt-2">
            <Link href="/onboarding" className="btn-primary">
              set up your family →
            </Link>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div>
      <PageCorner folio="home" section="home · today" />

      {/* ── Ask Hale — the hero ─────────────────────────────────────────── */}
      <section className="rise rise-1 mb-16 lg:mb-20">
        <AskBox canAsk={canAsk} />
      </section>

      {/* ── Today, per child ────────────────────────────────────────────── */}
      <section className="space-y-12 lg:space-y-16">
        {children.map((child, idx) => {
          const milestone = milestoneInWindow(child);
          const nextHealth = child.nextHealth[0] ?? null;
          const delay = `rise-${Math.min(idx + 2, 7)}`;
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
                  <Card href="/companion">
                    <span className="eyebrow text-apricot-deep">{duePhrase(nextHealth.dueInWeeks)}</span>
                    <p className="font-display text-[1.25rem] mt-2 leading-snug">{nextHealth.what}</p>
                    <p className="meta mt-3 text-slate-green">{nextHealth.note}</p>
                    <span className="link mt-4 inline-block">book →</span>
                  </Card>
                ) : null}

                {milestone ? (
                  <Card href="/companion">
                    <span className="eyebrow">around this age</span>
                    <p className="font-display text-[1.25rem] mt-2 leading-snug">{milestone.what}</p>
                    <p className="meta mt-3 text-slate-green">
                      most kids, around this stage — never a verdict.
                    </p>
                    <span className="link mt-4 inline-block">see {child.name ?? 'your child'} →</span>
                  </Card>
                ) : null}
              </div>
            </article>
          );
        })}
      </section>

      {/* ── This week, near you ─────────────────────────────────────────── */}
      {topActivities.length > 0 ? (
        <section className="rise rise-6 mt-16 lg:mt-20">
          <div className="flex items-center gap-3 border-b border-rule pb-4 mb-6">
            <Icon as={Sparkles} size={20} className="text-apricot-deep" />
            <h2 className="font-display text-[1.5rem] lg:text-[1.875rem] leading-tight">
              near you this week
            </h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {topActivities.map((activity) => (
              <Card key={activity.id} href="/village">
                <span className="eyebrow text-spruce">{activity.kind}</span>
                <p className="font-display text-[1.25rem] mt-2 leading-snug">{activity.title}</p>
                <p className="meta mt-3 text-slate-green">{activity.summary}</p>
                <span className="link mt-4 inline-block">see options →</span>
              </Card>
            ))}
          </div>
        </section>
      ) : null}

      {/* ── Quick-log ───────────────────────────────────────────────────── */}
      <section className="rise rise-7 mt-16 lg:mt-20 pt-10 border-t border-rule">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <span className="eyebrow text-spruce mr-2">quick log</span>
          {QUICK_LOG.map((item) => (
            <Link key={item.label} href="/companion" className="btn-secondary">
              <Icon as={item.icon} size={18} />
              {item.label}
            </Link>
          ))}
          <span className="meta ml-auto flex items-center gap-2">
            <Icon as={CalendarPlus} size={16} />
            kept in {children[0]?.name ?? 'your child'}&rsquo;s companion
          </span>
        </div>
      </section>
    </div>
  );
}
