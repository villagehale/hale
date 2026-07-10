import { Bell, ChevronRight, Files, MapPin, Route, Ruler, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Route as NextRoute } from 'next';
import Link from 'next/link';
import { auth } from '~/auth';
import { AskBar } from '~/components/hale/ask-bar';
import { HomeChildPanels, type HomeChildSnapshot } from '~/components/hale/home-child-panels';
import { LongDate } from '~/components/hale/long-date';
import { QuickLog } from '~/components/hale/quick-log';
import { Icon } from '~/components/ui/icon';
import { authConfigured } from '~/lib/auth-config';
import { type ChildCompanionView, loadCompanion } from '~/lib/companion/queries';
import { loadFamilyBasics, loadPendingApprovals } from '~/lib/dashboard/queries';
import { formatCalendarDate } from '~/lib/format/datetime';
import { loadHomeStats } from '~/lib/home/aggregates';
import { homeGreeting, homeStatCells } from '~/lib/home/greeting';
import { loadVillageFeed } from '~/lib/village/feed';
import type { VillageCandidateView } from '~/lib/village/mappers';

const STAGE_LABEL: Record<ChildCompanionView['stage'], string> = {
  newborn: 'newborn',
  toddler: 'toddler',
  child: 'school-age',
  teenager: 'teenager',
};

/** Human cadence labels — the village store keeps raw tokens; the UI never shows
 * them raw (rule #1). Mirrors the /village CADENCE_PILL labels. */
const CADENCE_LABEL: Record<string, string> = {
  seasonal: 'seasonal',
  'one-time': 'one-time',
  ongoing: 'year-round',
};

function duePhrase(dueInWeeks: number): string {
  if (dueInWeeks <= 0) return 'due now';
  if (dueInWeeks === 1) return 'due in 1 week';
  if (dueInWeeks < 8) return `due in ${dueInWeeks} weeks`;
  const months = Math.round(dueInWeeks / 4.345);
  return `due in ~${months} ${months === 1 ? 'month' : 'months'}`;
}

/** The "when" line for the top village pick: a dated event reads as its calendar
 * day, an undated activity as its (human) cadence. Null when neither is known — the
 * card then shows the title alone, never a fabricated date/distance (rule #1). */
function villageWhen(candidate: VillageCandidateView): string | null {
  if (candidate.eventDate) return formatCalendarDate(candidate.eventDate);
  if (candidate.cadence) return CADENCE_LABEL[candidate.cadence] ?? candidate.cadence;
  return null;
}

/** The top ranked village pick, or an honest "quiet for now" when the feed is
 * empty. Title + when (cadence / calendar day) only — never a distance (village
 * candidates carry none) and never a fabricated date (rule #1). */
function VillagePickCard({ topPick }: { topPick: VillageCandidateView | null }) {
  return (
    <div>
      <p className="eyebrow mb-3 text-faded-sage">from your village</p>
      <div className="card">
        {topPick ? (
          <>
            <p className="font-display text-[1.05rem] leading-snug text-spruce" data-hale-pii>
              {topPick.title}
            </p>
            {villageWhen(topPick) ? (
              <p className="meta mt-1 text-slate-green">{villageWhen(topPick)}</p>
            ) : null}
            <Link href="/village" className="link mt-3 inline-block">
              see your village &rarr;
            </Link>
          </>
        ) : (
          <p className="text-spruce leading-relaxed">
            your village is quiet for now —{' '}
            <Link href="/village" className="link">
              find activities near you
            </Link>
            .
          </p>
        )}
      </div>
    </div>
  );
}

/** The warm front door: "good evening, Alex." — the time-of-day phrase warmed with
 * the signed-in viewer's first name. In preview (auth off) there is no session, so
 * the greeting degrades to the bare phrase. Mirrors the mobile Home hero. */
async function viewerName(): Promise<string | null> {
  if (!authConfigured()) return null;
  const session = await auth();
  return session?.user?.name ?? null;
}

interface QuickActionRow {
  icon: LucideIcon;
  label: string;
  href: NextRoute;
}

const QUICK_ACTIONS: QuickActionRow[] = [
  { icon: Sparkles, label: 'add a memory', href: '/companion' },
  { icon: Ruler, label: 'track growth', href: '/companion' },
  { icon: Route, label: 'view routines', href: '/village' },
  { icon: Files, label: 'all documents', href: '/companion' },
];

export default async function HomePage() {
  const [children, stats, name, basics, feed, pending] = await Promise.all([
    loadCompanion(),
    loadHomeStats(),
    viewerName(),
    loadFamilyBasics(),
    loadVillageFeed(),
    loadPendingApprovals(),
  ]);

  const greeting = homeGreeting(name);
  const area = basics.location.city;
  const pendingCount = pending.length;
  const topPick = feed.candidates[0] ?? null;

  if (children.length === 0) {
    return (
      <div>
        <div className="page-corner">
          <span className="ml-auto">
            <LongDate />
          </span>
        </div>

        <header className="rise rise-1 mb-10 lg:mb-14">
          <h1 className="font-display">
            {greeting} <span aria-hidden>👋</span>
          </h1>
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
          <AskBar />
        </section>
      </div>
    );
  }

  const snapshots: HomeChildSnapshot[] = children.map((child) => ({
    id: child.id,
    name: child.name ?? 'your child',
    stageLabel: STAGE_LABEL[child.stage],
    upNext: child.todayHealth
      ? { what: child.todayHealth.what, duePhrase: duePhrase(child.todayHealth.dueInWeeks) }
      : null,
  }));

  return (
    <div>
      {/* ── Header — greeting + the family's coarse area as a static location chip,
       * and a bell into Approvals with an orange dot only when a decision waits. ── */}
      <header className="rise rise-1 mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-[1.75rem] lg:text-[2rem] leading-tight">
            {greeting} <span aria-hidden>👋</span>
          </h1>
          <p className="meta mt-1 text-slate-green">here&rsquo;s what&rsquo;s happening today.</p>
        </div>
        <div className="flex items-center gap-2">
          {area ? (
            <span className="pill inline-flex items-center gap-1.5 text-faded-sage" data-hale-pii>
              <Icon as={MapPin} size={14} />
              {area}
            </span>
          ) : null}
          <Link
            href="/approvals"
            aria-label={
              pendingCount > 0
                ? `approvals — ${pendingCount} waiting`
                : 'approvals'
            }
            className="relative inline-flex size-10 items-center justify-center rounded-full text-spruce transition-colors hover:bg-oat"
          >
            <Icon as={Bell} size={20} />
            {pendingCount > 0 ? (
              <span
                aria-hidden
                className="absolute right-1.5 top-1.5 size-2.5 rounded-full bg-apricot ring-2 ring-linen"
              />
            ) : null}
          </Link>
        </div>
      </header>

      {/* ── Quick actions — the quick-log handlers (feed / nap / milestone) as three
       * bordered action cards. ─────────────────────────────────────────────── */}
      <section className="rise rise-2 mb-4">
        <QuickLog
          kids={children.map((c) => ({ id: c.id, name: c.name, stage: c.stage }))}
          variant="cards"
        />
      </section>

      {/* ── Ask Hale — the compact single-line entry into the full conversation. ── */}
      <section className="rise rise-2 mb-6">
        <AskBar />
      </section>

      {/* ── The three columns: today's snapshot / up next + village / quick actions.
       * Each grid item is one column stack; collapses 3 → 2 → 1 at lg / md / sm. ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 items-start gap-x-6 gap-y-8">
        <HomeChildPanels
          kids={snapshots}
          statCells={homeStatCells(stats)}
          villageSlot={<VillagePickCard topPick={topPick} />}
        />

        <div className="rise rise-5">
          <p className="eyebrow mb-3 text-faded-sage">quick actions</p>
          <nav className="card overflow-hidden px-0 py-0">
            {QUICK_ACTIONS.map((action) => (
              <Link
                key={action.label}
                href={action.href}
                className="flex items-center gap-3 border-b border-rule px-[clamp(1.25rem,2vw,1.75rem)] py-3.5 text-spruce transition-colors last:border-b-0 hover:bg-linen"
              >
                <Icon as={action.icon} size={18} className="text-slate-green" />
                <span className="flex-1 font-medium">{action.label}</span>
                <Icon as={ChevronRight} size={18} className="text-faded-sage" />
              </Link>
            ))}
          </nav>
        </div>
      </div>
    </div>
  );
}
