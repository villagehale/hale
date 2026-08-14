import { stageDisplayLabel } from '@hale/types';
import Link from 'next/link';
import { HomeChildPanels, type HomeChildSnapshot } from '~/components/hale/home-child-panels';
import { Mascot } from '~/components/hale/mascot';
import { QuickLog } from '~/components/hale/quick-log';
import { loadCompanion } from '~/lib/companion/queries';
import { formatCalendarDate } from '~/lib/format/datetime';
import { loadHomeStats } from '~/lib/home/aggregates';
import { type HomeChildDays, loadHomeChildDays } from '~/lib/home/child-days';
import { homeStatCells } from '~/lib/home/greeting';
import { loadVillageFeed } from '~/lib/village/feed';
import type { VillageCandidateView } from '~/lib/village/mappers';
import { endorsementLabel } from '~/lib/village/social-proof';

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

/** The top ranked village pick (Row-1 col 4, design handoff §4.2), or an honest
 * "quiet for now" when the feed is empty. Title + when (cadence / calendar day) +
 * the REAL aggregate endorsement count ("loved by N families near you", 2+ only —
 * never a fabricated "12 families going", rule #1) + a link to the full village. */
function VillagePickCard({ topPick }: { topPick: VillageCandidateView | null }) {
  const proof = topPick ? endorsementLabel(topPick.endorsementCount) : null;
  return (
    <div className="rise rise-6 home-col">
      <p className="eyebrow text-faded-sage">from your village</p>
      <div className="card home-card-fill">
        {topPick ? (
          <>
            <p
              className="font-display text-[1.05rem] leading-snug text-spruce break-words"
              data-hale-pii
            >
              {topPick.title}
            </p>
            {villageWhen(topPick) ? (
              <p className="meta mt-1 text-slate-green">{villageWhen(topPick)}</p>
            ) : null}
            {proof ? <p className="meta mt-2 text-faded-sage">{proof}</p> : null}
            <Link href="/village" className="link mt-3 inline-block">
              view all activities &rarr;
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

export default async function HomePage() {
  const [children, stats, feed, days] = await Promise.all([
    loadCompanion(),
    loadHomeStats(),
    loadVillageFeed(),
    loadHomeChildDays(),
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
            {/* The add-child editor lives at /family/members. /onboarding for an
                already-provisioned family renders the terminal "already set up" card —
                a dead loop back to this same empty Home (WEB-08). */}
            <Link href="/family/members" className="btn-primary">
              add your child →
            </Link>
          </div>
        </section>
      </div>
    );
  }

  const snapshots: HomeChildSnapshot[] = children.map((child) => ({
    id: child.id,
    name: child.name ?? 'your child',
    stageLabel: stageDisplayLabel(child.stage, child.ageMonths),
    upNext: child.todayHealth
      ? { what: child.todayHealth.what, duePhrase: duePhrase(child.todayHealth.dueInWeeks) }
      : null,
  }));

  const daysByChild: Record<string, HomeChildDays> = Object.fromEntries(
    days.map((d) => [d.childId, d]),
  );

  return (
    // Opt the dashboard up to the 72rem canvas (§4.2) — the same stage-wide lift
    // Village uses (.village-wide in globals.css), so the row-of-4 quick-links +
    // village cards get real width instead of the 58rem editorial column.
    <div className="village-wide">
      {/* ── Quick actions — the quick-log handlers (feed / nap / diaper / milestone)
       * as bordered action cards. The greeting hero lives in the shell top bar. ─── */}
      <section className="rise rise-2 mb-4">
        <QuickLog
          kids={children.map((c) => ({ id: c.id, name: c.name, stage: c.stage }))}
          variant="cards"
        />
      </section>

      {/* ── Rows 1 + 2 (design handoff §4.2). HomeChildPanels owns the single
       * active-child selection so the snapshot, "up next" and Row 2 all follow the
       * same child; the family-wide village card is passed in as a Row-1 slot. Both
       * grids collapse sensibly below 1024px. ── */}
      <HomeChildPanels
        kids={snapshots}
        statCells={homeStatCells(stats)}
        daysByChild={daysByChild}
        villagePick={<VillagePickCard topPick={topPick} />}
      />
    </div>
  );
}
