import { ApprovalsHeader } from '~/components/hale/approvals-header';
import { ApproveButton } from '~/components/hale/approve-button';
import { ChildTag } from '~/components/hale/child-tag';
import { DismissButton } from '~/components/hale/dismiss-button';
import { DraftDetail } from '~/components/hale/draft-detail';
import { PageCorner } from '~/components/hale/page-corner';
import { ToneLabel } from '~/components/hale/tone';
import { UpgradePrompt } from '~/components/hale/upgrade-prompt';
import { actionTypeLabel } from '~/lib/format/labels';
import { loadFamilyBasics, loadPendingApprovals } from '~/lib/dashboard/queries';

/**
 * The Approvals surface — the parent-facing queue of drafts the inbound pipeline
 * produced and held for approval (rule #4: an L1/L2 family's drafts never execute
 * on their own). Each row shows the action type + a human preview of what the
 * draft does; the raw drafted payload is redacted for a 13+ child (rule #1, via
 * the approvals mapper). Approving a row posts to the approve route (enqueues
 * actions.approved); dismissing posts to the decline route — the "no" the consent
 * queue requires, which records its own audit_log row (rule #6).
 */
/**
 * Only a reviewer-APPROVED draft offers "approve & send" — the approve route
 * refuses any other verdict with 409 (rule #3), so surfacing that button on a
 * flagged / rejected / still-pending row would promise an action the server will
 * reject. Those rows get a review-first treatment: the reviewer's concern is
 * shown, and the only real action offered is to dismiss the draft.
 */
const APPROVED_VERDICT = 'approved';
const NEEDS_YOU_VERDICTS = new Set(['flagged', 'rejected']);

export default async function ApprovalsPage() {
  const [approvals, basics] = await Promise.all([loadPendingApprovals(), loadFamilyBasics()]);

  return (
    <div>
      <PageCorner section="approvals · awaiting you" />

      <ApprovalsHeader pendingCount={approvals.length} />

      {approvals.length > 0 ? (
        <ul className="rise rise-2 border-t border-rule">
          {approvals.map((approval) => (
            <li
              key={approval.id}
              className="py-7 border-b border-rule flex flex-wrap items-start justify-between gap-y-4 gap-x-8"
            >
              <div className="min-w-0" data-hale-pii>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mb-2">
                  <ChildTag childId={approval.childId} label={approval.childLabel} />
                  <span className="eyebrow">{actionTypeLabel(approval.actionType)}</span>
                </div>
                <p className="font-display text-[1.25rem] mt-1 text-spruce">{approval.preview}</p>
                {NEEDS_YOU_VERDICTS.has(approval.verdict) ? (
                  <p className="mt-2">
                    <ToneLabel tone="needs-you" detail={approval.summary} />
                  </p>
                ) : (
                  <p className="meta mt-2 text-slate-green">{approval.summary}</p>
                )}
                <p className="meta mt-2 text-slate-green">drafted {approval.draftedAt}</p>
                <DraftDetail actionType={approval.actionType} payload={approval.payload} />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <DismissButton actionId={approval.id} />
                {approval.verdict === APPROVED_VERDICT ? (
                  <ApproveButton actionId={approval.id} />
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {approvals.length > 0 ? (
        <div className="rise rise-3 mt-7">
          <UpgradePrompt planTier={basics.planTier} entitlement="autonomy_l3">
            Want Hale to handle the routine ones on its own? Plus lets it act for you, once
            you&rsquo;ve approved the kind.
          </UpgradePrompt>
        </div>
      ) : null}
    </div>
  );
}
