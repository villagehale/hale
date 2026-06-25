import { ApprovalsHeader } from '~/components/hale/approvals-header';
import { ApproveButton } from '~/components/hale/approve-button';
import { DismissButton } from '~/components/hale/dismiss-button';
import { PageCorner } from '~/components/hale/page-corner';
import { ToneLabel } from '~/components/hale/tone';
import { UpgradePrompt } from '~/components/hale/upgrade-prompt';
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
              <div className="min-w-0">
                <span className="eyebrow">{approval.actionType.replaceAll('_', ' ')}</span>
                <p className="font-display text-[1.25rem] mt-1 text-spruce">{approval.preview}</p>
                {NEEDS_YOU_VERDICTS.has(approval.verdict) ? (
                  <p className="mt-2">
                    <ToneLabel tone="needs-you" detail={approval.summary} />
                  </p>
                ) : (
                  <p className="meta mt-2 text-slate-green">{approval.summary}</p>
                )}
                <p className="meta mt-2 text-slate-green">drafted {approval.draftedAt}</p>
                {approval.payload ? (
                  <details className="mt-3">
                    <summary className="meta text-slate-green cursor-pointer">view details</summary>
                    <pre className="meta mt-2 whitespace-pre-wrap break-words text-faded-sage">
                      {JSON.stringify(approval.payload, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <DismissButton actionId={approval.id} />
                <ApproveButton actionId={approval.id} />
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
