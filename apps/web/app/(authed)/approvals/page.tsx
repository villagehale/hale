import Link from 'next/link';
import { ApprovalCard, ReversibleCard } from '~/components/hale/approval-card';
import { ApprovalsHeader } from '~/components/hale/approvals-header';
import { HISTORY_NAV } from '~/components/hale/nav';
import { UpgradePrompt } from '~/components/hale/upgrade-prompt';
import {
  loadFamilyBasics,
  loadPendingApprovals,
  loadResolvedActions,
} from '~/lib/dashboard/queries';

/**
 * The Approvals surface — the parent-facing queue of drafts the inbound pipeline
 * produced and held for approval (rule #4: an L1/L2 family's drafts never execute
 * on their own). Each row shows the action type + a human preview of what the
 * draft does; the raw drafted payload is redacted for a 13+ child (rule #1, via
 * the approvals mapper). Approving a row posts to the approve route (enqueues
 * actions.approved); dismissing posts to the decline route — the "no" the consent
 * queue requires, which records its own audit_log row (rule #6).
 *
 * The two card shapes live in components/hale/approval-card.tsx; this page owns the
 * loading, the sectioning, and nothing else.
 */
export default async function ApprovalsPage() {
  const [approvals, basics, resolved] = await Promise.all([
    loadPendingApprovals(),
    loadFamilyBasics(),
    loadResolvedActions(),
  ]);
  const reversible = resolved.filter((row) => row.undoable);

  return (
    <div>
      <ApprovalsHeader pendingCount={approvals.length} />

      {approvals.length > 0 ? (
        <ul className="rise rise-2 grid gap-4">
          {approvals.map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} />
          ))}
        </ul>
      ) : null}

      {/* The other half of consent: something Hale already did that can still be taken
        * back. Only calendar placements inside the 24h window appear (HistoryView.
        * undoable, derived from the same gate the server enforces), so this section is
        * empty almost always and never offers a control the reversal would refuse. */}
      {reversible.length > 0 ? (
        <div className="rise rise-3 mt-8">
          <h2 className="text-ink">Still reversible</h2>
          <p className="meta mt-1 text-ink-2">
            Hale put these on your calendar. You can take one back for 24 hours.
          </p>
          <ul className="mt-4 grid gap-4">
            {reversible.map((done) => (
              <ReversibleCard key={done.id} done={done} />
            ))}
          </ul>
        </div>
      ) : null}

      {approvals.length > 0 ? (
        <div className="rise rise-3 mt-8">
          <UpgradePrompt planTier={basics.planTier} entitlement="autonomy_l3">
            Want Hale to handle the routine ones on its own? Plus lets it act for you, once
            you&rsquo;ve approved the kind.
          </UpgradePrompt>
          <Link href={HISTORY_NAV.href} className="link mt-6 inline-block">
            view the full record →
          </Link>
        </div>
      ) : null}
    </div>
  );
}
