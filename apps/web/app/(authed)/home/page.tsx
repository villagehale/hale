import { Files, Route, Ruler, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Route as NextRoute } from 'next';
import Link from 'next/link';
import { AskBar } from '~/components/hale/ask-bar';
import { HaleTip } from '~/components/hale/hale-tip';
import { HomeChildPanels, type HomeChildSnapshot } from '~/components/hale/home-child-panels';
import { Mascot } from '~/components/hale/mascot';
import { QuickLog } from '~/components/hale/quick-log';
import { Icon } from '~/components/ui/icon';
import { type ChildCompanionView, loadCompanion } from '~/lib/companion/queries';
import { formatCalendarDate } from '~/lib/format/datetime';
import { loadHomeStats } from '~/lib/home/aggregates';
import { homeStatCells } from '~/lib/home/greeting';
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
  const [children, stats, feed] = await Promise.all([
    loadCompanion(),
    loadHomeStats(),
    loadVillageFeed(),
  ]);

  // The greeting hero + the location/bell now live in the shell top bar (design
  // handoff §3.2), so this page carries no header of its own.
  const topPick = feed.candidates[0] ?? null;

  if (children.length === 0) {
    return (
      <div>
        <section className="rise rise-3 panel-oat px-6 py-12 lg:py-16 text-center space-y-4">
          <Mascot pose="wave" size={112} className="mx-auto" />
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
      {/* ── Quick actions — the quick-log handlers (feed / nap / milestone) as
       * bordered action cards. The greeting hero lives in the shell top bar. ─── */}
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

      {/* ── The three columns: today's snapshot / up next + village / quick links.
       * Each grid item is one column stack; collapses 3 → 2 → 1 at lg / md / sm. ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 items-start gap-x-6 gap-y-8">
        <HomeChildPanels
          kids={snapshots}
          statCells={homeStatCells(stats)}
          villageSlot={<VillagePickCard topPick={topPick} />}
        />

        <div className="rise rise-5 flex flex-col gap-8">
          <div>
            <p className="eyebrow mb-3 text-faded-sage">quick links</p>
            {/* 2×2 tile grid (design handoff §4.2) — each a warm tile into a real
             * surface. */}
            <div className="grid grid-cols-2 gap-3">
              {QUICK_ACTIONS.map((action) => (
                <Link key={action.label} href={action.href} className="quick-link-tile">
                  <Icon as={action.icon} size={20} className="text-slate-green" />
                  <span className="font-medium leading-snug">{action.label}</span>
                </Link>
              ))}
            </div>
          </div>

          <HaleTip />
        </div>
      </div>
    </div>
  );
}
