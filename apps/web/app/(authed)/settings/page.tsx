import { FamilyParent } from '~/components/hale/family-parent';
import { PrivacyNote } from '~/components/hale/privacy-note';
import { FamilyPlan } from '~/components/hale/family-plan';
import { Connectors } from '~/components/hale/connectors';
import { ThemeToggle } from '~/components/hale/theme-toggle';
import { ExportDataButton } from '~/components/hale/export-data-button';
import { SharedLinks } from '~/components/hale/shared-links';
import { DeleteAccountButton } from '~/components/hale/delete-account-button';
import { loadFamilyBasics, loadFamilyMembers } from '~/lib/dashboard/queries';
import { loadFamilyConnectors } from '~/lib/integrations/load';

/** A clean, minimal section label (Notion/Linear register) — small, muted, spaced
 * above its content. Replaces the editorial label-rail gutters. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="eyebrow mb-3 text-faded-sage">{children}</p>;
}

/**
 * Settings: account + app configuration, sectioned — Profile, Plan & Billing,
 * Connectors, Notifications, Appearance, Privacy & data. This is the account, not
 * the family (the children, co-parent, and household live on /family — IA split
 * #9). Appearance carries the app's single theme control (no duplicate in the
 * sidebar or header).
 */
export default async function SettingsPage() {
  const [members, basics, connections] = await Promise.all([
    loadFamilyMembers(),
    loadFamilyBasics(),
    loadFamilyConnectors(),
  ]);

  return (
    <div>
      <header className="rise rise-1 mb-8">
        <h1 className="font-display text-[1.75rem] lg:text-[2rem] leading-tight">
          your <span className="text-apricot-deep">Settings.</span>
        </h1>
        <p className="meta mt-1 text-slate-green">your profile · plan · connections · appearance</p>
      </header>

      {/* ── Profile ────────────────────────────────────────────────────── */}
      {members.primary ? (
        <section className="rise rise-2 mb-8">
          <SectionLabel>profile</SectionLabel>
          <FamilyParent name={members.primary.name} email={members.primary.email} />
        </section>
      ) : null}

      {/* ── Plan & Billing ─────────────────────────────────────────────── */}
      <section className="rise rise-3 mb-8">
        <SectionLabel>plan &amp; billing</SectionLabel>
        <FamilyPlan planTier={basics.planTier} />
      </section>

      {/* ── Connectors ─────────────────────────────────────────────────── */}
      <section className="rise rise-4 mb-8">
        <SectionLabel>connectors</SectionLabel>
        <Connectors connections={connections} />
      </section>

      {/* ── Notifications ──────────────────────────────────────────────── */}
      <section className="rise rise-5 mb-8">
        <SectionLabel>notifications</SectionLabel>
        <p className="text-spruce leading-relaxed max-w-md">
          For now Hale only surfaces what needs your eye inside the app, on the approvals queue.
          Email and push preferences are coming soon.
        </p>
      </section>

      {/* ── Appearance ─────────────────────────────────────────────────── */}
      <section className="rise rise-6 mb-8">
        <SectionLabel>appearance</SectionLabel>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
          <p className="text-spruce leading-relaxed max-w-md">
            Choose a theme, or let Hale follow your device. Dark mode is the brand&rsquo;s own
            Prussian night.
          </p>
          <ThemeToggle />
        </div>
      </section>

      {/* ── Privacy & data ─────────────────────────────────────────────── */}
      <section className="rise rise-7">
        <SectionLabel>privacy &amp; data</SectionLabel>
        <div className="flex flex-col gap-y-8">
          <div className="panel-oat px-6 py-5 flex flex-wrap items-center gap-x-6 gap-y-2">
            {[
              'teen content is private from parents by default',
              'nothing is shared with a third party unless you connect one',
            ].map((note) => (
              <span key={note} className="meta">
                {note}
              </span>
            ))}
            <PrivacyNote />
          </div>

          <div className="flex flex-col gap-y-3">
            <span className="eyebrow text-spruce">your data</span>
            <p className="text-spruce leading-relaxed max-w-md">
              Download a structured copy of everything Hale holds about your family — your history,
              your children, and your settings. Teen content follows the same privacy rules you
              already see.
            </p>
            <ExportDataButton />
          </div>

          <div className="flex flex-col gap-y-3 border-t border-rule pt-8">
            <span className="eyebrow text-spruce">links you have shared</span>
            <p className="text-spruce leading-relaxed max-w-md">
              Public links you&rsquo;ve created for a week plan or a local pick. Revoke one any time
              — the page it points to goes quiet immediately.
            </p>
            <SharedLinks />
          </div>

          <div className="flex flex-col gap-y-3 border-t border-rule pt-8">
            <span className="eyebrow text-berry">delete account</span>
            <DeleteAccountButton />
          </div>
        </div>
      </section>
    </div>
  );
}
