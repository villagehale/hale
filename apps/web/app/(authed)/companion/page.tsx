import Link from 'next/link';
import { CompanionTabs } from '~/components/hale/companion-tabs';
import { PrivacyNote } from '~/components/hale/privacy-note';
import { QuickLog } from '~/components/hale/quick-log';
import { UpgradePrompt } from '~/components/hale/upgrade-prompt';
import { MEASUREMENT_EPISODE } from '~/lib/companion/log-types';
import { loadLogsPage } from '~/lib/companion/logs-page';
import { loadCompanion } from '~/lib/companion/queries';
import { loadRecentLogs } from '~/lib/companion/recent-logs';
import { loadFamilyBasics, loadFamilyTimezone } from '~/lib/dashboard/queries';
import { loadViewerProfile } from '~/lib/family';
import { loadVillage } from '~/lib/village/queries';

/** A clean, minimal section label (Notion/Linear register) — small, muted, spaced
 * above its content. Replaces the editorial label-rail gutters. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="eyebrow mb-3 text-faded-sage">{children}</p>;
}

export default async function CompanionPage() {
  const [children, recentLogs, basics, timeZone, village, growthPage, profile] = await Promise.all([
    loadCompanion(),
    loadRecentLogs(),
    loadFamilyBasics(),
    loadFamilyTimezone(),
    loadVillage(),
    loadLogsPage({ episodeType: MEASUREMENT_EPISODE }),
    loadViewerProfile(),
  ]);
  const units = profile?.units ?? 'metric';

  return (
    <div>
      {children.length === 0 ? (
        <>
          {/* Empty state keeps a modest headline; a populated page goes straight to
           * the child header inside CompanionTabs (mockup panel 2). */}
          <header className="rise rise-1 mb-8">
            <SectionLabel>your companion</SectionLabel>
            <h1 className="font-display text-[1.75rem] lg:text-[2rem] leading-tight">
              growing up, <span className="text-apricot-deep">held</span> at every age.
            </h1>
          </header>
          <section className="rise rise-3 panel-oat px-6 py-12 lg:py-16 text-center space-y-4">
            <p className="font-display text-[1.5rem] lg:text-[1.875rem] text-spruce">
              no children added yet.
            </p>
            <p className="meta text-slate-green max-w-xl mx-auto">
              once a child’s birthday is on file, this page gathers their stage, the next routine
              checkups and immunizations, and the milestones worth watching for — all confirmed with
              your own provider.
            </p>
            <div className="pt-2">
              <Link href="/family" className="btn-primary">
                add a child →
              </Link>
            </div>
          </section>
        </>
      ) : (
        <CompanionTabs
          kids={children}
          routine={village.routine}
          growthLogs={growthPage.logs}
          recentLogs={recentLogs}
          units={units}
          timeZone={timeZone}
        />
      )}

      {/* ── Booking — Hale can take this off your hands ─────────────────── */}
      {children.length > 0 ? (
        <div className="rise rise-7 mt-8">
          <UpgradePrompt planTier={basics.planTier} entitlement="portal_automation">
            Tired of booking these yourself? On Family, Hale can book a clinic appointment for you —
            you just confirm.
          </UpgradePrompt>
        </div>
      ) : null}

      {/* ── Quick log — the write path (feeds · naps · milestones · growth) ── */}
      {children.length > 0 ? (
        <section className="rise rise-7 mt-8">
          <div className="flex items-baseline justify-between gap-4 mb-3">
            <span className="eyebrow text-faded-sage">quick log</span>
            <Link href="/companion/logs" className="link">
              see all logs →
            </Link>
          </div>
          <QuickLog kids={children.map((c) => ({ id: c.id, name: c.name, stage: c.stage }))} />
        </section>
      ) : null}

      {/* ── Colophon ────────────────────────────────────────────────────── */}
      <section className="rise rise-7 mt-8 space-y-6">
        <div className="panel-oat px-6 py-5 flex flex-wrap items-center gap-x-6 gap-y-2">
          {[
            'supportive guidance, never a diagnosis',
            'always confirm health and milestones with your provider',
          ].map((note) => (
            <span key={note} className="meta">
              {note}
            </span>
          ))}
          <PrivacyNote />
        </div>

        <div className="flex flex-wrap items-baseline justify-between gap-y-3 text-faded-sage">
          <p className="meta">your companion</p>
          <p className="meta">tended by Hale</p>
        </div>
      </section>
    </div>
  );
}
