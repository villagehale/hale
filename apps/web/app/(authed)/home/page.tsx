import { Baby } from 'lucide-react';
import Link from 'next/link';
import { Suspense } from 'react';
import { auth } from '~/auth';
import { BookButton } from '~/components/hale/book-button';
import { scopeChildren } from '~/components/hale/child-scope-core';
import { ConciergeAsk } from '~/components/hale/concierge-ask';
import { HomeChildFilter } from '~/components/hale/home-child-filter';
import { LongDate } from '~/components/hale/long-date';
import { QuickLog } from '~/components/hale/quick-log';
import { HomeVillageFeed, VillageFeedSkeleton } from '~/components/hale/village-feed-section';
import { Card } from '~/components/ui/card';
import { Icon } from '~/components/ui/icon';
import { authConfigured } from '~/lib/auth-config';
import { loadThreadShellForRequest } from '~/lib/coach/thread';
import { type ChildCompanionView, loadCompanion } from '~/lib/companion/queries';
import { loadHomeStats } from '~/lib/home/aggregates';
import { homeGreeting, homeStatCells } from '~/lib/home/greeting';

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

/** The warm front door: "good evening, Alex." — the time-of-day phrase warmed with
 * the signed-in viewer's first name. In preview (auth off) there is no session, so
 * the greeting degrades to the bare phrase. Mirrors the mobile Home hero. */
async function viewerName(): Promise<string | null> {
  if (!authConfigured()) return null;
  const session = await auth();
  return session?.user?.name ?? null;
}

/** The honest stat row — three counts (this week's logs, checkups coming up, saved
 * places), each a big number or a calm zero phrase. Counts only, teen-redacted in
 * the loader (rule #1). Mirrors the mobile HomeStatsRow. */
/** A clean, minimal section label (Notion/Linear register) — small, muted, spaced
 * above its content. Replaces the editorial label-rail gutters. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="eyebrow mb-3 text-faded-sage">{children}</p>;
}

function HomeStatsRow({ stats }: { stats: Awaited<ReturnType<typeof loadHomeStats>> }) {
  return (
    <div className="grid grid-cols-3 divide-x divide-rule overflow-hidden rounded-2xl border border-rule bg-oat">
      {homeStatCells(stats).map((cell) => (
        <div key={cell.label} className="flex min-h-[5.5rem] flex-col justify-center gap-0.5 px-4 py-4 lg:px-5">
          {cell.count === null ? (
            <p className="meta text-faded-sage leading-snug">{cell.label}</p>
          ) : (
            <>
              <p className="font-display text-[1.6rem] lg:text-[1.9rem] leading-none text-spruce tabular">
                {cell.count}
              </p>
              <p className="meta text-faded-sage leading-snug">{cell.label}</p>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

export default async function HomePage() {
  const canAsk = authConfigured();
  const [children, askSeed, stats, name] = await Promise.all([
    loadCompanion(),
    loadThreadShellForRequest(),
    loadHomeStats(),
    viewerName(),
  ]);

  const greeting = homeGreeting(name);

  if (children.length === 0) {
    return (
      <div>
        <div className="page-corner">
          <span className="ml-auto">
            <LongDate />
          </span>
        </div>

        <header className="rise rise-1 mb-10 lg:mb-14">
          <h1 className="font-display">{greeting}.</h1>
          <p className="meta mt-3 text-slate-green">here&rsquo;s what&rsquo;s happening today.</p>
        </header>

        <section className="rise rise-3 panel-oat px-6 py-12 lg:py-16 text-center space-y-4">
          <p className="font-display text-[1.5rem] lg:text-[1.875rem] text-spruce">
            tell Hale about your kid.
          </p>
          <p className="meta text-slate-green max-w-xl mx-auto">
            add your child&rsquo;s birthday and your area, and this page fills with your village —
            the genuinely good local things families like yours recommend near you, ranked for your
            family.
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

      {/* ── Greeting — a modest, app-like header (Notion/Linear register), not a
       * magazine hero. A small muted line carries the day. ─────── */}
      <header className="rise rise-1 mb-8">
        <h1 className="font-display text-[1.75rem] lg:text-[2rem] leading-tight">{greeting}.</h1>
        <p className="meta mt-1 text-slate-green">here&rsquo;s what&rsquo;s happening today.</p>
      </header>

      {/* ── Quick log + the honest stat strip — a compact, dense band. ─── */}
      <section className="rise rise-2 mb-8 space-y-4">
        <QuickLog kids={children.map((c) => ({ id: c.id, name: c.name, stage: c.stage }))} />
        <HomeStatsRow stats={stats} />
      </section>

      {/* ── From the village — the agent-ranked, trusted feed ─────────────── */}
      {/* Streamed: the rank-recommendations agent must not block the shell. */}
      <section className="rise rise-4 mb-8">
        <SectionLabel>from your village</SectionLabel>
        <Suspense fallback={<VillageFeedSkeleton />}>
          <HomeVillageFeed />
        </Suspense>
      </section>

      {/* ── Today, per child (the quiet Companion — distinct from the village) ─ */}
      <section>
        <HomeChildFilter
          kids={scopeChildren(children)}
          sections={children.map((child, idx) => {
            const milestone = milestoneInWindow(child);
            const nextHealth = child.todayHealth;
            const whatsNow = child.whatsNow[0] ?? null;
            const delay = `rise-${Math.min(idx + 5, 7)}`;
            return {
              childId: child.id,
              node: (
                <article className={`rise ${delay}`}>
                  <div className="flex items-center gap-3 border-b border-rule pb-4 mb-6">
                    <Icon as={Baby} size={20} className="text-apricot-deep" />
                    <h2 className="font-display text-[1.5rem] lg:text-[1.875rem] leading-tight">
                      today for <span data-hale-pii>{child.name ?? 'your child'}</span>
                    </h2>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                    {nextHealth ? (
                      <Card>
                        <span className="eyebrow text-apricot-deep">
                          {duePhrase(nextHealth.dueInWeeks)}
                        </span>
                        <p className="font-display text-[1.25rem] mt-2 leading-snug" data-hale-pii>
                          {nextHealth.what}
                        </p>
                        <p className="meta mt-3 text-slate-green" data-hale-pii>
                          {nextHealth.note}
                        </p>
                        <div className="mt-4">
                          <BookButton what={nextHealth.what} childId={child.id} />
                        </div>
                      </Card>
                    ) : whatsNow ? (
                      <Card href="/companion">
                        <span className="eyebrow">what matters now</span>
                        <p className="font-display text-[1.25rem] mt-2 leading-snug" data-hale-pii>
                          {whatsNow}
                        </p>
                        <span className="link mt-4 inline-block">
                          see <span data-hale-pii>{child.name ?? 'your child'}</span> →
                        </span>
                      </Card>
                    ) : null}

                    {milestone ? (
                      <Card href="/companion">
                        <span className="eyebrow">around this age</span>
                        <p className="font-display text-[1.25rem] mt-2 leading-snug" data-hale-pii>
                          {milestone.what}
                        </p>
                        <p className="meta mt-3 text-slate-green">
                          most kids, around this stage — never a verdict.
                        </p>
                        <span className="link mt-4 inline-block">
                          see <span data-hale-pii>{child.name ?? 'your child'}</span> →
                        </span>
                      </Card>
                    ) : null}
                  </div>
                </article>
              ),
            };
          })}
        />
      </section>
    </div>
  );
}
