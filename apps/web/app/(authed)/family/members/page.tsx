import { FamilyChildren } from '~/components/hale/family-children';
import { FamilyIntents } from '~/components/hale/family-intents';
import { FamilyLocation } from '~/components/hale/family-location';
import { InviteCoParent } from '~/components/hale/invite-coparent';
import { loadFamilyBasics, loadFamilyMembers } from '~/lib/dashboard/queries';

/**
 * Family members: who is in the household (you + co-parent, with invite), the
 * children, and the household's coarse location + tailoring. The parent's own
 * profile, the plan, and connectors live in Settings — this page is the family,
 * not the account (IA split #9). Reached from the Family hub's "Family members"
 * and "Invitations" tiles.
 */

/** A clean, minimal section label (Notion/Linear register) — small, muted, spaced
 * above its content. Replaces the editorial label-rail gutters. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="eyebrow mb-3 text-faded-sage">{children}</p>;
}

export default async function FamilyMembersPage() {
  const [members, basics] = await Promise.all([loadFamilyMembers(), loadFamilyBasics()]);

  return (
    <div>
      <header className="rise rise-1 mb-8">
        <h1 className="font-display text-[1.75rem] lg:text-[2rem] leading-tight">
          your <span className="text-apricot-deep">Family.</span>
        </h1>
        <p className="meta mt-1 text-slate-green">your kids · your co-parent · your area</p>
        {basics.foundingNumber !== null ? (
          <p className="mt-4 inline-flex items-center rounded-full bg-apricot-tint px-4 py-1.5 font-display text-sm font-semibold text-spruce">
            Founding family · #{basics.foundingNumber}
          </p>
        ) : null}
      </header>

      {/* ── Members ────────────────────────────────────────────────────── */}
      <section className="rise rise-2 mb-8">
        <SectionLabel>parents</SectionLabel>
        <div className="space-y-8">
          {members.primary ? (
            <div>
              <p className="meta">you</p>
              <p className="font-display text-[1.25rem] mt-1" data-hale-pii>
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
                <p className="font-display text-[1.25rem] mt-1" data-hale-pii>
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
      </section>

      {/* ── Kids ───────────────────────────────────────────────────────── */}
      <section className="rise rise-3 mb-8">
        <SectionLabel>your kids</SectionLabel>
        <FamilyChildren kids={basics.children} />
      </section>

      {/* ── Household ──────────────────────────────────────────────────── */}
      <section className="rise rise-4 mb-8">
        <SectionLabel>your area</SectionLabel>
        <FamilyLocation location={basics.location} />
      </section>

      {/* ── Hoping for ─────────────────────────────────────────────────── */}
      <section className="rise rise-5">
        <SectionLabel>what you&rsquo;re hoping for</SectionLabel>
        <FamilyIntents intents={basics.intents} />
      </section>
    </div>
  );
}
