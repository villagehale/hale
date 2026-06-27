import { PageCorner } from '~/components/hale/page-corner';
import { FamilyChildren } from '~/components/hale/family-children';
import { FamilyIntents } from '~/components/hale/family-intents';
import { FamilyLocation } from '~/components/hale/family-location';
import { InviteCoParent } from '~/components/hale/invite-coparent';
import { loadFamilyBasics, loadFamilyMembers } from '~/lib/dashboard/queries';

/**
 * Family control only: who is in the household (you + co-parent, with invite),
 * the children, and the household's coarse location + tailoring. The parent's own
 * profile, the plan, and connectors live in Settings — this page is the family,
 * not the account (IA split #9).
 */
export default async function FamilyPage() {
  const [members, basics] = await Promise.all([loadFamilyMembers(), loadFamilyBasics()]);

  return (
    <div>
      <PageCorner folio="family" section="your household" />

      <header className="rise rise-1 mb-16 lg:mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">your family</span>
            <p className="meta mt-2">your kids · your co-parent · your area</p>
          </div>
          <div className="lg:col-span-9">
            <h1 className="font-display">
              your <span className="text-apricot-deep">Family.</span>
            </h1>
          </div>
        </div>
      </header>

      {/* ── Members ────────────────────────────────────────────────────── */}
      <section className="rise rise-2 mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 border-y border-rule py-10">
          <div className="lg:col-span-3">
            <span className="eyebrow text-spruce">parents</span>
            <p className="meta mt-2">either of you can approve · edit your own name in settings</p>
          </div>
          <div className="lg:col-span-9 space-y-10">
            {members.primary ? (
              <div>
                <p className="meta">you</p>
                <p className="font-display text-[1.5rem] mt-1" data-hale-pii>
                  {members.primary.name ?? members.primary.email}
                </p>
                <p className="meta mt-1" data-hale-pii>
                  {members.primary.email}
                </p>
              </div>
            ) : null}

            <div>
              {members.coParent ? (
                <div>
                  <p className="meta">co-parent</p>
                  <p className="font-display text-[1.5rem] mt-1" data-hale-pii>
                    {members.coParent.name ?? members.coParent.email}
                  </p>
                  <p className="meta mt-1" data-hale-pii>
                    {members.coParent.email}
                  </p>
                </div>
              ) : (
                <InviteCoParent />
              )}
            </div>
          </div>
        </div>
      </section>

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

      {/* ── Household ──────────────────────────────────────────────────── */}
      <section className="rise rise-4 mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 border-b border-rule pb-10">
          <div className="lg:col-span-3">
            <span className="eyebrow text-spruce">your area</span>
            <p className="meta mt-2">coarse only — postal code drives local discovery</p>
          </div>
          <div className="lg:col-span-9">
            <FamilyLocation location={basics.location} />
          </div>
        </div>
      </section>

      {/* ── Hoping for ─────────────────────────────────────────────────── */}
      <section className="rise rise-5">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 pb-2">
          <div className="lg:col-span-3">
            <span className="eyebrow text-spruce">what you&rsquo;re hoping for</span>
            <p className="meta mt-2">optional — helps Hale tailor what it surfaces</p>
          </div>
          <div className="lg:col-span-9">
            <FamilyIntents intents={basics.intents} />
          </div>
        </div>
      </section>
    </div>
  );
}
