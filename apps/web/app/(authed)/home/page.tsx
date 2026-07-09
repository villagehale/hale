import { Baby, MapPin, MessageCircle, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { Suspense } from 'react';
import { auth } from '~/auth';
import { BookButton } from '~/components/hale/book-button';
import { scopeChildren } from '~/components/hale/child-scope-core';
import { ConciergeAsk } from '~/components/hale/concierge-ask';
import { HomeChildFilter } from '~/components/hale/home-child-filter';
import { LongDate } from '~/components/hale/long-date';
import { QuickLog } from '~/components/hale/quick-log';
import { RecentLogs } from '~/components/hale/recent-logs';
import { HomeVillageFeed, VillageFeedSkeleton } from '~/components/hale/village-feed-section';
import { Card } from '~/components/ui/card';
import { Icon } from '~/components/ui/icon';
import { authConfigured } from '~/lib/auth-config';
import { loadThreadShellForRequest } from '~/lib/coach/thread';
import { type ChildCompanionView, loadCompanion } from '~/lib/companion/queries';
import { loadRecentLogs, type RecentLogView } from '~/lib/companion/recent-logs';
import { loadFamilyBasics, loadFamilyTimezone } from '~/lib/dashboard/queries';
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

/** A clean, minimal section label (Notion/Linear register) — small, muted, spaced
 * above its content. Replaces the editorial label-rail gutters. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="eyebrow mb-3 text-faded-sage">{children}</p>;
}

/** The honest stat strip — three counts (this week's logs, checkups coming up, saved
 * places), each a big number or a calm zero phrase. Counts only, teen-redacted in
 * the loader (rule #1). Mirrors the mobile HomeStatsRow. */
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

/** A compact quick-action link tile for the actions row — icon + label, tinted to
 * its domain (lavender for the AI ask, oat for the utility care links). */
function ActionTile({
  href,
  icon,
  label,
  tint,
}: {
  href: '/coach' | '/companion';
  icon: typeof MessageCircle;
  label: string;
  tint: 'lavender' | 'oat';
}) {
  return (
    <Link
      href={href}
      className={`card card-interactive flex items-center gap-3 ${tint === 'lavender' ? 'bg-lavender' : ''}`}
    >
      <span className="text-apricot-deep">
        <Icon as={icon} size={20} />
      </span>
      <span className="font-display text-[1.05rem] leading-tight">{label}</span>
    </Link>
  );
}

export default async function HomePage() {
  const canAsk = authConfigured();
  const [children, askSeed, stats, name, recentLogs, timeZone, basics] = await Promise.all([
    loadCompanion(),
    loadThreadShellForRequest(),
    loadHomeStats(),
    viewerName(),
    loadRecentLogs(),
    loadFamilyTimezone(),
    loadFamilyBasics(),
  ]);

  const greeting = homeGreeting(name);
  const area = basics.location.city;

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

  const logsByChild = new Map<string, RecentLogView[]>();
  for (const log of recentLogs) {
    if (!log.childId) continue;
    const bucket = logsByChild.get(log.childId) ?? [];
    bucket.push(log);
    logsByChild.set(log.childId, bucket);
  }

  return (
    <div>
      {/* ── Header band — a modest, app-like greeting (Notion/Linear register), with
       * the family's coarse area as a muted location chip on the right. ─────── */}
      <header className="rise rise-1 mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-[1.75rem] lg:text-[2rem] leading-tight">
            {greeting} <span aria-hidden>👋</span>
          </h1>
          <p className="meta mt-1 text-slate-green">here&rsquo;s what&rsquo;s happening today.</p>
        </div>
        {area ? (
          <span className="pill inline-flex items-center gap-1.5 text-faded-sage" data-hale-pii>
            <Icon as={MapPin} size={14} />
            {area}
          </span>
        ) : null}
      </header>

      {/* ── Quick actions — the quick-log handlers (feed / nap / milestone) plus an
       * Ask-Hale link. QuickLog owns its own toggle + inline form; the Ask tile is a
       * plain route link, so no handler is duplicated. ─────────────────────── */}
      <section className="rise rise-2 mb-8 space-y-4">
        <QuickLog kids={children.map((c) => ({ id: c.id, name: c.name, stage: c.stage }))} />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <ActionTile href="/coach" icon={MessageCircle} label="ask Hale" tint="lavender" />
          <ActionTile href="/companion" icon={Baby} label="view companion" tint="oat" />
        </div>
      </section>

      {/* ── Dashboard grid — dense multi-column on desktop, single column on mobile.
       * Every card traces to a real loader; nothing is fabricated. ─────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 lg:gap-6 mb-8">
        {/* This week — the honest stat strip. */}
        <section className="rise rise-3 lg:col-span-1">
          <SectionLabel>this week</SectionLabel>
          <HomeStatsRow stats={stats} />
        </section>

        {/* Up next — each child's soonest health item within the horizon. */}
        <section className="rise rise-3 lg:col-span-1">
          <SectionLabel>up next</SectionLabel>
          <div className="space-y-4">
            {children.some((c) => c.todayHealth) ? (
              children.map((child) =>
                child.todayHealth ? (
                  <Card key={child.id}>
                    <span className="eyebrow text-apricot-deep">
                      {duePhrase(child.todayHealth.dueInWeeks)}
                    </span>
                    <p className="font-display text-[1.15rem] mt-2 leading-snug" data-hale-pii>
                      {child.todayHealth.what}
                    </p>
                    <p className="meta mt-1 text-slate-green" data-hale-pii>
                      for {child.name ?? 'your child'}
                    </p>
                    <div className="mt-3">
                      <BookButton what={child.todayHealth.what} childId={child.id} />
                    </div>
                  </Card>
                ) : null,
              )
            ) : (
              <Card>
                <p className="meta text-slate-green">
                  nothing on the standard schedule right now — keep up periodic visits.
                </p>
              </Card>
            )}
          </div>
        </section>

        {/* Quick care — a small card of real action links. */}
        <section className="rise rise-3 lg:col-span-1">
          <SectionLabel>quick care</SectionLabel>
          <Card>
            <ul className="space-y-3">
              <li>
                <Link href="/companion" className="link inline-flex items-center gap-2">
                  <Icon as={Sparkles} size={16} />
                  log a memory
                </Link>
              </li>
              <li>
                <Link href="/companion" className="link inline-flex items-center gap-2">
                  <Icon as={Baby} size={16} />
                  view companion
                </Link>
              </li>
              <li>
                <Link href="/coach" className="link inline-flex items-center gap-2">
                  <Icon as={MessageCircle} size={16} />
                  ask Hale anything
                </Link>
              </li>
            </ul>
          </Card>
        </section>
      </div>

      {/* ── Per-child summary — each child (name / stage / age) with their around-this-
       * age milestone and recent logs. Teen redaction is applied in loadRecentLogs
       * (rule #1); the filter narrows to one child. ─────────────────────────── */}
      <section className="rise rise-4 mb-8">
        <SectionLabel>your children</SectionLabel>
        <HomeChildFilter
          kids={scopeChildren(children)}
          sections={children.map((child) => {
            const milestone = milestoneInWindow(child);
            const childLogs = logsByChild.get(child.id) ?? [];
            return {
              childId: child.id,
              node: (
                <Card>
                  <div className="flex items-center gap-3 border-b border-rule pb-3 mb-4">
                    <Icon as={Baby} size={20} className="text-apricot-deep" />
                    <div>
                      <h2 className="font-display text-[1.25rem] leading-tight" data-hale-pii>
                        {child.name ?? 'your child'}
                      </h2>
                      <p className="meta text-faded-sage">{child.stage}</p>
                    </div>
                  </div>

                  {milestone ? (
                    <div className="mb-4">
                      <span className="eyebrow text-faded-sage">around this age</span>
                      <p className="text-lg text-spruce leading-relaxed mt-1" data-hale-pii>
                        {milestone.what}
                      </p>
                    </div>
                  ) : null}

                  <span className="eyebrow text-faded-sage">recent logs</span>
                  <div className="mt-2">
                    <RecentLogs logs={childLogs} timeZone={timeZone} />
                  </div>

                  <Link href="/companion" className="link mt-4 inline-block">
                    open companion →
                  </Link>
                </Card>
              ),
            };
          })}
        />
      </section>

      {/* ── From the village — the agent-ranked, trusted feed. Streamed so the
       * rank-recommendations agent never blocks the shell. No photos: the village
       * data has no image field, so the honest text card stays. ─────────────── */}
      <section className="rise rise-5">
        <SectionLabel>from your village</SectionLabel>
        <Suspense fallback={<VillageFeedSkeleton />}>
          <HomeVillageFeed />
        </Suspense>
      </section>
    </div>
  );
}
