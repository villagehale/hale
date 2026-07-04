import Link from 'next/link';
import { CompanionTabs } from '~/components/hale/companion-tabs';
import { PageCorner } from '~/components/hale/page-corner';
import { PrivacyNote } from '~/components/hale/privacy-note';
import { QuickLog } from '~/components/hale/quick-log';
import { RecentLogs } from '~/components/hale/recent-logs';
import { UpgradePrompt } from '~/components/hale/upgrade-prompt';
import { loadCompanion } from '~/lib/companion/queries';
import { loadRecentLogs } from '~/lib/companion/recent-logs';
import { loadFamilyBasics, loadFamilyTimezone } from '~/lib/dashboard/queries';

export default async function CompanionPage() {
  const [children, recentLogs, basics, timeZone] = await Promise.all([
    loadCompanion(),
    loadRecentLogs(),
    loadFamilyBasics(),
    loadFamilyTimezone(),
  ]);

  return (
    <div>
      <PageCorner section="companion · 0–18" />

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
      ) : (
        <CompanionTabs kids={children} />
      )}

      {/* ── Booking — Hale can take this off your hands ─────────────────── */}
      {children.length > 0 ? (
        <div className="rise rise-7 mt-12 lg:mt-16">
          <UpgradePrompt planTier={basics.planTier} entitlement="portal_automation">
            Tired of booking these yourself? On Family, Hale can book a clinic appointment for you —
            you just confirm.
          </UpgradePrompt>
        </div>
      ) : null}

      {/* ── Recent logs + quick log ─────────────────────────────────────── */}
      {children.length > 0 ? (
        <section className="rise rise-7 mt-16 lg:mt-24">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 border-t border-rule pt-10">
            <div className="lg:col-span-3">
              <span className="eyebrow">recent logs</span>
              <p className="meta mt-2 text-slate-green">feeds · naps · milestones</p>
              <Link href="/companion/logs" className="link mt-4 inline-block">
                see all logs →
              </Link>
            </div>
            <div className="lg:col-span-9 space-y-8">
              <RecentLogs logs={recentLogs} timeZone={timeZone} />
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
