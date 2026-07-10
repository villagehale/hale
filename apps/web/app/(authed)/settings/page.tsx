import { AccountProfileCard } from '~/components/hale/account-profile-card';
import { Connectors } from '~/components/hale/connectors';
import { DeleteAccountButton } from '~/components/hale/delete-account-button';
import { ExportDataButton } from '~/components/hale/export-data-button';
import { FamilyPlan } from '~/components/hale/family-plan';
import { PrivacyNote } from '~/components/hale/privacy-note';
import { SharedLinks } from '~/components/hale/shared-links';
import { ThemeToggle } from '~/components/hale/theme-toggle';
import { loadFamilyBasics } from '~/lib/dashboard/queries';
import { loadViewerProfile } from '~/lib/family';
import { loadFamilyConnectors } from '~/lib/integrations/load';

/** The account sub-nav: every entry points at a section that really renders below
 * (no Security / Preferences — those have no backing store, so listing them would
 * dead-end or fabricate; rule #1). The first is the anchor a jump lands on. */
const SECTIONS = [
  { id: 'profile', label: 'Profile' },
  { id: 'connected-apps', label: 'Connected apps' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'privacy', label: 'Privacy & data' },
  { id: 'billing', label: 'Billing' },
] as const;

/** A section heading with a scroll offset so an anchor jump isn't hidden under the
 * top of the viewport. */
function SectionHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="eyebrow mb-4 text-faded-sage scroll-mt-6">
      {children}
    </h2>
  );
}

/**
 * Account: the signed-in parent's own account + app configuration, sectioned to
 * match the founder mockup (panel 6) — Profile, Connected apps, Notifications,
 * Appearance, Privacy & data, Billing. Two columns on desktop: a sticky sub-nav
 * beside the content. The family itself (children, co-parent, household) lives on
 * /family — this is the account. The mockup's Phone, Preferences (units /
 * temperature / week-start), and Security sections are OMITTED: the `users` row has
 * no column to back them, and this product never fabricates data (rule #1).
 */
export default async function SettingsPage() {
  const [profile, basics, connections] = await Promise.all([
    loadViewerProfile(),
    loadFamilyBasics(),
    loadFamilyConnectors(),
  ]);

  return (
    <div>
      <header className="rise rise-1 mb-8">
        <h1 className="font-display text-[1.75rem] lg:text-[2rem] leading-tight">
          your <span className="text-apricot-deep">Account.</span>
        </h1>
        <p className="meta mt-1 text-slate-green">Manage your personal account and preferences.</p>
      </header>

      <div className="rise rise-2 grid grid-cols-1 gap-8 lg:grid-cols-[13rem_1fr] lg:gap-12">
        <nav
          aria-label="Account sections"
          className="lg:sticky lg:top-6 lg:self-start -mx-1 flex gap-1 overflow-x-auto px-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0"
        >
          {SECTIONS.map((section, idx) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              aria-current={idx === 0 ? 'true' : undefined}
              className="shrink-0 rounded-[var(--r-md)] px-3 py-2 text-sm font-semibold whitespace-nowrap text-slate-green transition-colors hover:bg-linen hover:text-spruce aria-[current]:bg-alt-surface aria-[current]:text-spruce focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--color-apricot-deep)]"
            >
              {section.label}
            </a>
          ))}
        </nav>

        <div className="flex min-w-0 flex-col gap-y-12">
          {/* ── Profile ──────────────────────────────────────────────────── */}
          <section>
            <SectionHeading id="profile">profile information</SectionHeading>
            {profile ? (
              <AccountProfileCard profile={profile} />
            ) : (
              <p className="text-spruce leading-relaxed max-w-md">
                Sign in to see and edit your account details.
              </p>
            )}
          </section>

          {/* ── Connected apps ───────────────────────────────────────────── */}
          <section>
            <SectionHeading id="connected-apps">connected apps</SectionHeading>
            <Connectors connections={connections} />
          </section>

          {/* ── Notifications ────────────────────────────────────────────── */}
          <section>
            <SectionHeading id="notifications">notifications</SectionHeading>
            <p className="text-spruce leading-relaxed max-w-md">
              For now Hale only surfaces what needs your eye inside the app, on the approvals queue.
              Email and push preferences are coming soon.
            </p>
          </section>

          {/* ── Appearance ───────────────────────────────────────────────── */}
          <section>
            <SectionHeading id="appearance">appearance</SectionHeading>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
              <p className="text-spruce leading-relaxed max-w-md">
                Choose a theme, or let Hale follow your device. Dark mode is the brand&rsquo;s own
                Prussian night.
              </p>
              <ThemeToggle />
            </div>
          </section>

          {/* ── Privacy & data ───────────────────────────────────────────── */}
          <section>
            <SectionHeading id="privacy">privacy &amp; data</SectionHeading>
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
                  Download a structured copy of everything Hale holds about your family — your
                  history, your children, and your settings. Teen content follows the same privacy
                  rules you already see.
                </p>
                <ExportDataButton />
              </div>

              <div className="flex flex-col gap-y-3 border-t border-rule pt-8">
                <span className="eyebrow text-spruce">links you have shared</span>
                <p className="text-spruce leading-relaxed max-w-md">
                  Public links you&rsquo;ve created for a week plan or a local pick. Revoke one any
                  time — the page it points to goes quiet immediately.
                </p>
                <SharedLinks />
              </div>

              <div className="flex flex-col gap-y-3 border-t border-rule pt-8">
                <span className="eyebrow text-berry">delete account</span>
                <DeleteAccountButton />
              </div>
            </div>
          </section>

          {/* ── Billing ──────────────────────────────────────────────────── */}
          <section>
            <SectionHeading id="billing">billing</SectionHeading>
            <FamilyPlan planTier={basics.planTier} />
          </section>
        </div>
      </div>
    </div>
  );
}
