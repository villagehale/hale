import { PageCorner } from '~/components/hale/page-corner';
import { FamilyChildren } from '~/components/hale/family-children';
import { FamilyLocation } from '~/components/hale/family-location';
import { FamilyParent } from '~/components/hale/family-parent';
import { FamilyPlan } from '~/components/hale/family-plan';
import { InviteCoParent } from '~/components/hale/invite-coparent';
import { ThemeToggle } from '~/components/hale/theme-toggle';
import { loadFamilyBasics, loadFamilyMembers } from '~/lib/dashboard/queries';

export default async function FamilyPage() {
  const [members, basics] = await Promise.all([loadFamilyMembers(), loadFamilyBasics()]);

  return (
    <div>
      <PageCorner folio="family" section="family · your household" />

      <header className="rise rise-1 mb-16 lg:mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">your family</span>
            <p className="meta mt-2">your kids · your area · your co-parent</p>
          </div>
          <div className="lg:col-span-9">
            <h1 className="font-display">
              your <span className="text-apricot-deep">Family.</span>
            </h1>
          </div>
        </div>
      </header>

      {/* ── You ────────────────────────────────────────────────────────── */}
      {members.primary ? (
        <section className="rise rise-2 mb-20">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 border-y border-rule py-10">
            <div className="lg:col-span-3">
              <span className="eyebrow text-spruce">you</span>
              <p className="meta mt-2">your name comes from Google — edit it any time</p>
            </div>
            <div className="lg:col-span-9">
              <FamilyParent name={members.primary.name} email={members.primary.email} />
            </div>
          </div>
        </section>
      ) : null}

      {/* ── Kids ───────────────────────────────────────────────────────── */}
      <section className="rise rise-3 mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 border-b border-rule pb-10">
          <div className="lg:col-span-3">
            <span className="eyebrow text-spruce">your kids</span>
            <p className="meta mt-2">birthday sets the stage Hale tailors to</p>
          </div>
          <div className="lg:col-span-9">
            <FamilyChildren kids={basics.children} />
          </div>
        </div>
      </section>

      {/* ── Co-parent ──────────────────────────────────────────────────── */}
      <section className="rise rise-4 mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 border-b border-rule pb-10">
          <div className="lg:col-span-3">
            <span className="eyebrow text-spruce">your co-parent</span>
            <p className="meta mt-2">share the load · either of you can approve</p>
          </div>
          <div className="lg:col-span-9">
            {members.coParent ? (
              <div>
                <p className="meta">co-parent</p>
                <p className="font-display text-[1.5rem] mt-1">
                  {members.coParent.name ?? members.coParent.email}
                </p>
                <p className="meta mt-1">{members.coParent.email}</p>
              </div>
            ) : (
              <InviteCoParent />
            )}
          </div>
        </div>
      </section>

      {/* ── Location ───────────────────────────────────────────────────── */}
      <section className="rise rise-5 mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 border-b border-rule pb-10">
          <div className="lg:col-span-3">
            <span className="eyebrow text-spruce">your location</span>
            <p className="meta mt-2">coarse only — postal code drives local discovery</p>
          </div>
          <div className="lg:col-span-9">
            <FamilyLocation location={basics.location} />
          </div>
        </div>
      </section>

      {/* ── Plan ───────────────────────────────────────────────────────── */}
      <section className="rise rise-6 mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 border-b border-rule pb-10">
          <div className="lg:col-span-3">
            <span className="eyebrow text-spruce">your plan</span>
            <p className="meta mt-2">change any time · nothing charged today</p>
          </div>
          <div className="lg:col-span-9">
            <FamilyPlan planTier={basics.planTier} />
          </div>
        </div>
      </section>

      {/* ── Appearance ─────────────────────────────────────────────────── */}
      <section className="rise rise-7 mb-20">
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

      {/* ── Privacy ────────────────────────────────────────────────────── */}
      <section className="rise rise-7 pt-2">
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
      </section>
    </div>
  );
}
