import { DEFAULT_SAFETY_POLICY } from '@hale/types';
import { PageCorner } from '~/components/hale/page-corner';
import { ThemeToggle } from '~/components/hale/theme-toggle';
import { loadFamilyHeader, loadFamilyMembers } from '~/lib/dashboard/queries';

const USD = new Intl.NumberFormat('en-CA', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

export default async function SettingsPage() {
  const [members, header] = await Promise.all([loadFamilyMembers(), loadFamilyHeader()]);
  const { spendingCaps } = DEFAULT_SAFETY_POLICY;
  const caps = [
    { label: 'per action', value: USD.format(spendingCaps.perActionMaxUsd) },
    { label: 'per day', value: USD.format(spendingCaps.perDayMaxUsd) },
    { label: 'per month', value: USD.format(spendingCaps.perMonthMaxUsd) },
  ];

  return (
    <div>
      <PageCorner folio="08" section="settings · tune the trust ladder" />

      <header className="rise rise-1 mb-16 lg:mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">settings</span>
            <p className="meta mt-2">household preferences · trust · caps</p>
          </div>
          <div className="lg:col-span-9">
            <h1 className="font-display">
              tune the <span className="text-apricot-deep">trust ladder.</span>
            </h1>
          </div>
        </div>
      </header>

      {/* ── Account / family ───────────────────────────────────────────── */}
      <section className="rise rise-2 mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 border-y border-rule py-10">
          <div className="lg:col-span-3">
            <span className="eyebrow text-spruce">your family</span>
            <p className="meta mt-2">your household · one almanac · every stage</p>
          </div>
          <div className="lg:col-span-9 grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-8">
            <div>
              <p className="meta">primary parent</p>
              {members.primary ? (
                <>
                  <p className="font-display text-[1.5rem] mt-1">
                    {members.primary.name ?? members.primary.email}
                  </p>
                  <p className="meta mt-1">{members.primary.email}</p>
                </>
              ) : (
                <p className="font-display text-[1.5rem] mt-1">not set up yet</p>
              )}
            </div>
            <div>
              <p className="meta">co-parent</p>
              {members.coParent ? (
                <>
                  <p className="font-display text-[1.5rem] mt-1">
                    {members.coParent.name ?? members.coParent.email}
                  </p>
                  <p className="meta mt-1">{members.coParent.email}</p>
                </>
              ) : (
                <>
                  <p className="font-display text-[1.5rem] mt-1">invite pending</p>
                  <p className="meta mt-1">— send by qr or email</p>
                  <button type="button" className="btn-ghost mt-3">
                    send invite
                  </button>
                </>
              )}
            </div>
            {header.children.length === 0 ? (
              <div>
                <p className="meta">children</p>
                <p className="font-display text-[1.5rem] mt-1">none added yet</p>
                <p className="meta mt-1">— add a child to tailor every stage</p>
              </div>
            ) : (
              header.children.map((child) => (
                <div key={child.id}>
                  <p className="meta">child</p>
                  <p className="font-display text-[1.5rem] mt-1">{child.name}</p>
                  <p className="meta mt-1">{child.stageLabel}</p>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      {/* ── Appearance ─────────────────────────────────────────────────── */}
      <section className="rise rise-3 mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 border-b border-rule pb-10">
          <div className="lg:col-span-3">
            <span className="eyebrow text-spruce">appearance</span>
            <p className="meta mt-2">light · dark · match your device</p>
          </div>
          <div className="lg:col-span-9 flex flex-wrap items-center gap-x-6 gap-y-4">
            <p className="text-spruce leading-relaxed max-w-md">
              Choose a theme, or let Hale follow your device. Dark mode is the brand&rsquo;s own
              Prussian night.
            </p>
            <ThemeToggle />
          </div>
        </div>
      </section>

      {/* ── Trust ladder ───────────────────────────────────────────────── */}
      <section className="rise rise-3 mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12">
          <div className="lg:col-span-3 lg:sticky lg:top-12 lg:self-start">
            <span className="eyebrow text-spruce">trust ladder</span>
            <h2 className="mt-5 font-display">
              what i can do <span className="text-apricot-deep">on my own.</span>
            </h2>
            <p className="mt-4 text-slate-green leading-relaxed">
              Every action class earns its own place on the ladder. New families begin at L1 — I
              always ask — for the first seven days.
            </p>
            <p className="mt-4 meta">
              each class climbs on its own; you can freeze or reset any of them.
            </p>
          </div>

          <div className="lg:col-span-9 space-y-6 text-spruce leading-relaxed">
            <p>
              <span className="font-display text-[1.25rem]">L1 · ask me.</span> I surface what I
              notice and act on nothing without your tap.
            </p>
            <p>
              <span className="font-display text-[1.25rem]">L2 · draft.</span> I prepare the reply,
              order, or form and you approve it.
            </p>
            <p>
              <span className="font-display text-[1.25rem]">L3 · auto on routine.</span> After a
              streak of approvals, I handle the routine cases on my own.
            </p>
            <p>
              <span className="font-display text-[1.25rem]">L4 · full.</span> Full autonomy within
              your spending caps and category rules below.
            </p>
            <p className="meta">
              Your per-class levels appear here as Hale earns them — nothing is autonomous until you
              grant it.
            </p>
          </div>
        </div>
      </section>

      {/* ── Caps + policies ────────────────────────────────────────────── */}
      <section className="rise rise-5 mb-20 pt-10 border-t border-rule">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow text-spruce">spending</span>
            <h2 className="mt-5 font-display">caps & categories</h2>
            <p className="mt-4 text-slate-green leading-relaxed">
              The numerical limits and category-level rules that overrule the trust ladder. Edits
              take effect immediately.
            </p>
          </div>
          <div className="lg:col-span-9 space-y-10">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-rule">
              {caps.map((cap) => (
                <div key={cap.label} className="bg-linen p-6">
                  <span className="eyebrow">{cap.label}</span>
                  <p className="font-display text-[2.5rem] mt-1 tabular leading-none">
                    {cap.value}
                  </p>
                  <button type="button" className="btn-ghost mt-3">
                    change
                  </button>
                </div>
              ))}
            </div>

            <div>
              <p className="meta mb-3">
                categories that always require approval, regardless of streak
              </p>
              <div className="flex flex-wrap gap-x-3 gap-y-2">
                {spendingCaps.categoriesRequiringApproval.map((c) => (
                  <span key={c} className="pill">
                    {c}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Kill switch ────────────────────────────────────────────────── */}
      <section className="rise rise-7 pt-10 border-t border-rule">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 panel-apricot-tint">
          <div className="lg:col-span-3">
            <span className="eyebrow text-apricot-deep">pause</span>
            <p className="meta mt-2">a single tap</p>
          </div>
          <div className="lg:col-span-9 flex flex-wrap items-center gap-x-8 gap-y-4">
            <p className="text-lg text-spruce leading-snug max-w-md">
              Need me to step back for a while? One tap pauses everything for twenty-four hours.
              I'll still log signals but I won't draft or act.
            </p>
            <button type="button" className="btn-primary">
              pause for 24h →
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
