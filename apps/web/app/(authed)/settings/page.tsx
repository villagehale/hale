import { PageCorner } from '~/components/hale/page-corner';
import { FamilyParent } from '~/components/hale/family-parent';
import { FamilyPlan } from '~/components/hale/family-plan';
import { ThemeToggle } from '~/components/hale/theme-toggle';
import { loadFamilyBasics, loadFamilyMembers } from '~/lib/dashboard/queries';

/**
 * Settings: account + app configuration, sectioned — Profile, Plan & Billing,
 * Connectors, Notifications, Appearance, Privacy & data. This is the account, not
 * the family (the children, co-parent, and household live on /family — IA split
 * #9). Appearance carries the app's single theme control (no duplicate in the
 * sidebar or header).
 */
export default async function SettingsPage() {
  const [members, basics] = await Promise.all([loadFamilyMembers(), loadFamilyBasics()]);

  return (
    <div>
      <PageCorner folio="settings" section="your account" />

      <header className="rise rise-1 mb-16 lg:mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">settings</span>
            <p className="meta mt-2">your profile · plan · connections · appearance</p>
          </div>
          <div className="lg:col-span-9">
            <h1 className="font-display">
              your <span className="text-apricot-deep">Settings.</span>
            </h1>
          </div>
        </div>
      </header>

      {/* ── Profile ────────────────────────────────────────────────────── */}
      {members.primary ? (
        <section className="rise rise-2 mb-20">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 border-y border-rule py-10">
            <div className="lg:col-span-3">
              <span className="eyebrow text-spruce">profile</span>
              <p className="meta mt-2">your name comes from Google — edit it any time</p>
            </div>
            <div className="lg:col-span-9">
              <FamilyParent name={members.primary.name} email={members.primary.email} />
            </div>
          </div>
        </section>
      ) : null}

      {/* ── Plan & Billing ─────────────────────────────────────────────── */}
      <section className="rise rise-3 mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 border-b border-rule pb-10">
          <div className="lg:col-span-3">
            <span className="eyebrow text-spruce">plan &amp; billing</span>
            <p className="meta mt-2">change any time · nothing charged today</p>
          </div>
          <div className="lg:col-span-9">
            <FamilyPlan planTier={basics.planTier} />
          </div>
        </div>
      </section>

      {/* ── Connectors ─────────────────────────────────────────────────── */}
      <section className="rise rise-4 mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 border-b border-rule pb-10">
          <div className="lg:col-span-3">
            <span className="eyebrow text-spruce">connectors</span>
            <p className="meta mt-2">calendars, stores, and portals you choose to connect</p>
          </div>
          <div className="lg:col-span-9">
            <p className="text-spruce leading-relaxed max-w-md">
              Nothing is connected yet. Hale never reaches outside your family until you connect a
              service here — and you can disconnect it just as easily.
            </p>
            <p className="meta mt-3">connectors are coming soon.</p>
          </div>
        </div>
      </section>

      {/* ── Notifications ──────────────────────────────────────────────── */}
      <section className="rise rise-5 mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 border-b border-rule pb-10">
          <div className="lg:col-span-3">
            <span className="eyebrow text-spruce">notifications</span>
            <p className="meta mt-2">how and when Hale reaches you</p>
          </div>
          <div className="lg:col-span-9">
            <p className="text-spruce leading-relaxed max-w-md">
              For now Hale only surfaces what needs your eye inside the app, on the approvals queue.
              Email and push preferences are coming soon.
            </p>
          </div>
        </div>
      </section>

      {/* ── Appearance ─────────────────────────────────────────────────── */}
      <section className="rise rise-6 mb-20">
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

      {/* ── Privacy & data ─────────────────────────────────────────────── */}
      <section className="rise rise-7">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 pb-2">
          <div className="lg:col-span-3">
            <span className="eyebrow text-spruce">privacy &amp; data</span>
            <p className="meta mt-2">where your data lives, and who can see it</p>
          </div>
          <div className="lg:col-span-9">
            <div className="panel-oat px-6 py-5 flex flex-wrap items-center gap-x-6 gap-y-2">
              {[
                "your family's data stays in canada · pipeda",
                'teen content is private from parents by default',
                'nothing is shared with a third party unless you connect one',
              ].map((note) => (
                <span key={note} className="meta">
                  {note}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
