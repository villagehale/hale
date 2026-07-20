import { Bookmark, CreditCard, MessageSquare, SquareCheck } from 'lucide-react';
import Link from 'next/link';
import { PLAN_DISPLAY } from '@hale/types';
import { FamilyHubCard } from '~/components/hale/family-hub-card';
import { loadFamilyBasics, loadFamilyMembers, loadPendingApprovals } from '~/lib/dashboard/queries';

/**
 * Family hub (design handoff §4.6): a 4-card top grid — Approvals / Messages /
 * Saved / Plan & billing — over a read-only Parents & children summary. Every
 * count is live: the Approvals tile carries the real pending count, and no tile
 * fabricates one (Messages has no unread concept, so it shows no badge — never the
 * mockup's hardcoded "2", honesty lane). Editing the family (invite a co-parent,
 * add/edit a child, set the area) lives one level down at /family/members so the
 * editor has a single home; this hub only surfaces and links to it.
 */

/** A clean, minimal section label (Notion/Linear register) — small, muted, spaced
 * above its content, matching the /family/members and /plan pages. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="eyebrow mb-3 text-faded-sage">{children}</p>;
}

export default async function FamilyPage() {
  const [approvals, members, basics] = await Promise.all([
    loadPendingApprovals(),
    loadFamilyMembers(),
    loadFamilyBasics(),
  ]);

  const planLabel =
    basics.planTier === 'free'
      ? `${PLAN_DISPLAY.free.name} plan`
      : PLAN_DISPLAY[basics.planTier].name;

  const areaLabel =
    [basics.location.city, basics.location.province].filter(Boolean).join(', ') || null;

  return (
    <div>
      {/* The page title + subtitle live in the shell top bar (design handoff §3.2). */}

      {/* ── 4-card grid (§4.6) ─────────────────────────────────────────── */}
      <div className="rise rise-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <FamilyHubCard
          icon={SquareCheck}
          title="Approvals"
          subtitle="Waiting for you"
          href="/approvals"
          badge={approvals.length}
        />
        <FamilyHubCard
          icon={MessageSquare}
          title="Messages"
          subtitle="From your village"
          href="/messages"
        />
        <FamilyHubCard icon={Bookmark} title="Saved" subtitle="Your saved items" href="/saved" />
        <FamilyHubCard
          icon={CreditCard}
          title="Plan & billing"
          subtitle={planLabel}
          href="/settings#billing"
        />
      </div>

      {/* ── Parents & children summary (§4.6) ──────────────────────────── */}
      <div className="rise rise-3 mt-10 grid grid-cols-1 lg:grid-cols-2 gap-10">
        <section>
          <SectionLabel>parents &amp; guardians</SectionLabel>
          <div className="space-y-6">
            {members.primary ? (
              <div>
                <p className="font-display text-[1.25rem]" data-hale-pii>
                  {members.primary.name ?? members.primary.email}
                </p>
                <p className="meta mt-1">Primary parent</p>
              </div>
            ) : null}
            {members.coParent ? (
              <div>
                <p className="font-display text-[1.25rem]" data-hale-pii>
                  {members.coParent.name ?? members.coParent.email}
                </p>
                <p className="meta mt-1">Co-parent</p>
              </div>
            ) : (
              <p className="meta text-slate-green">No co-parent yet.</p>
            )}
          </div>

          <div className="mt-8">
            <SectionLabel>family area</SectionLabel>
            {areaLabel ? (
              <p className="text-spruce">
                {areaLabel}
                {basics.location.country ? (
                  <span className="meta ml-2">{basics.location.country}</span>
                ) : null}
              </p>
            ) : (
              <p className="meta text-slate-green">No area set yet.</p>
            )}
          </div>
        </section>

        <section>
          <SectionLabel>children</SectionLabel>
          {basics.children.length > 0 ? (
            <ul className="space-y-4">
              {basics.children.map((child) => (
                <li key={child.id}>
                  <p className="font-display text-[1.25rem]" data-hale-pii>
                    {child.name}
                  </p>
                  <p className="meta mt-1">{child.stageLabel}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="meta text-slate-green">No children added yet.</p>
          )}

          <Link href="/family/members" className="link mt-8 inline-block">
            manage family &amp; children →
          </Link>
        </section>
      </div>
    </div>
  );
}
