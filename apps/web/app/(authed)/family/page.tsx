import { deriveStage } from '@hale/types';
import { AddCoParentCard } from '~/components/hale/add-coparent-card';
import { FamilyChildren } from '~/components/hale/family-children';
import { FamilyIntents } from '~/components/hale/family-intents';
import { FamilyLocation } from '~/components/hale/family-location';
import { TeenAccessGrants } from '~/components/hale/teen-access-grants';
import { loadOpenJoinInviteForFamily } from '~/lib/channel/join/invites';
import { loadFamilyBasics, loadFamilyMembers } from '~/lib/dashboard/queries';
import { db } from '~/lib/db';
import { currentFamilyId, currentUserId } from '~/lib/family';
import { listTeenAccessGrants } from '~/lib/teen-access';

/**
 * The family EDITOR — the hub of tiles died with the Instinct-adapted refresh, and
 * the content that lived one level down at /family/members moved up here: who is in
 * the household (you + co-parent, with the join-link card), the children, the coarse
 * location + tailoring, and — once the family has a 13+ child — the teen raw-access
 * grants. The parent's own profile, the plan, and connectors live in Settings; this
 * page is the family, not the account.
 */

/** A clean, minimal section label (Notion/Linear register) — small, muted, spaced
 * above its content. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="eyebrow mb-3 text-faded-sage">{children}</p>;
}

export default async function FamilyPage() {
  const database = db();
  const [members, basics, familyId, userId] = await Promise.all([
    loadFamilyMembers(),
    loadFamilyBasics(),
    currentFamilyId(database),
    currentUserId(database),
  ]);

  // The join-link status is only worth a read while the seat is empty — a joined
  // co-parent IS the card's terminal state (their member row shows them instead).
  const openInvite =
    !members.coParent && familyId
      ? await loadOpenJoinInviteForFamily(database, familyId, new Date())
      : null;

  // VIL-147: the teen raw-access section only exists once the family actually has a
  // 13+ child — an affordance for a situation that cannot arise would be noise.
  const hasTeen = basics.children.some((child) => deriveStage(child.dateOfBirth) === 'teenager');
  const teenGrants =
    hasTeen && familyId && userId ? await listTeenAccessGrants(database, familyId, userId) : [];
  const childNames = Object.fromEntries(basics.children.map((child) => [child.id, child.name]));

  return (
    <div>
      {/* The page title + subtitle live in the shell top bar (§3.2). */}
      {basics.foundingNumber !== null ? (
        <p className="rise rise-1 mb-8 inline-flex items-center rounded-full bg-apricot-tint px-4 py-1.5 font-display text-sm font-semibold text-spruce">
          Founding family · #{basics.foundingNumber}
        </p>
      ) : null}

      {/* ── Members ────────────────────────────────────────────────────── */}
      <section className="rise rise-2 mb-8">
        <SectionLabel>parents &amp; caregivers</SectionLabel>
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
                <p className="meta">co-parent · full access</p>
                <p className="font-display text-[1.25rem] mt-1" data-hale-pii>
                  {members.coParent.name ?? members.coParent.email}
                </p>
                <p className="meta mt-1" data-hale-pii>
                  {members.coParent.email}
                </p>
              </div>
            ) : (
              <AddCoParentCard
                openInvite={
                  openInvite ? { expiresAt: openInvite.expiresAt.toISOString() } : null
                }
              />
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
      <section className={`rise rise-5${hasTeen ? ' mb-8' : ''}`}>
        <SectionLabel>what you&rsquo;re hoping for</SectionLabel>
        <FamilyIntents intents={basics.intents} />
      </section>

      {/* ── Teen privacy (13+ only) ────────────────────────────────────── */}
      {hasTeen ? (
        <section className="rise rise-6">
          <SectionLabel>teen privacy</SectionLabel>
          <TeenAccessGrants grants={teenGrants} childNames={childNames} />
        </section>
      ) : null}
    </div>
  );
}
