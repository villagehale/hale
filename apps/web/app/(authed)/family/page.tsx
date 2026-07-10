import {
  Bookmark,
  BookOpen,
  CreditCard,
  MessageSquare,
  SquareCheck,
  UserPlus,
  UsersRound,
} from 'lucide-react';
import { FamilyHubCard } from '~/components/hale/family-hub-card';
import { loadPendingApprovals } from '~/lib/dashboard/queries';

/**
 * Family hub: the "More" surface — one nav tile per family/collaboration area.
 * This page is the index, not the editor; the actual member/kids/area editing
 * lives at /family/members. Every tile points at a route that really exists —
 * no dead links. Roles & permissions and Help center from the mockup are omitted
 * because no route (nor support surface) exists for them yet.
 */

export default async function FamilyPage() {
  const approvals = await loadPendingApprovals();

  return (
    <div>
      <header className="rise rise-1 mb-8">
        <h1 className="font-display text-[1.75rem] lg:text-[2rem] leading-tight">
          your <span className="text-apricot-deep">Family.</span>
        </h1>
        <p className="meta mt-1 text-slate-green">
          Manage your family, plan and collaboration.
        </p>
      </header>

      <div className="rise rise-2 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <FamilyHubCard
          icon={UsersRound}
          title="Family members"
          subtitle="Manage members & roles"
          href="/family/members"
        />
        <FamilyHubCard
          icon={CreditCard}
          title="Plan"
          subtitle="Subscription & benefits"
          href="/plan"
        />
        <FamilyHubCard
          icon={Bookmark}
          title="Saved"
          subtitle="Saved items & resources"
          href="/saved"
        />
        <FamilyHubCard
          icon={UserPlus}
          title="Invitations"
          subtitle="Invite family, caregivers"
          href="/family/members"
        />
        <FamilyHubCard
          icon={SquareCheck}
          title="Approvals"
          subtitle="Actions waiting for you"
          href="/approvals"
          badge={approvals.length}
        />
        <FamilyHubCard
          icon={BookOpen}
          title="Resources"
          subtitle="Guides & articles"
          href="/village"
        />
        <FamilyHubCard
          icon={MessageSquare}
          title="Messages"
          subtitle="Updates from your village"
          href="/messages"
        />
      </div>
    </div>
  );
}
