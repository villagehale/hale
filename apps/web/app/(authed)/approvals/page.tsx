import { Clock } from 'lucide-react';
import Link from 'next/link';
import { ApprovalsHeader } from '~/components/hale/approvals-header';
import { ApproveButton } from '~/components/hale/approve-button';
import { ChildTag } from '~/components/hale/child-tag';
import { DismissButton } from '~/components/hale/dismiss-button';
import { DraftDetail } from '~/components/hale/draft-detail';
import { HISTORY_NAV } from '~/components/hale/nav';
import { RequestTeenAccessButton } from '~/components/hale/request-teen-access-button';
import { ToneLabel } from '~/components/hale/tone';
import { UndoButton } from '~/components/hale/undo-button';
import { UpgradePrompt } from '~/components/hale/upgrade-prompt';
import { Icon } from '~/components/ui/icon';
import {
  loadFamilyBasics,
  loadPendingApprovals,
  loadResolvedActions,
} from '~/lib/dashboard/queries';
import { actionTypeLabel } from '~/lib/format/labels';

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
            // VIL-244 · M9: the draft's action id is its anchor, so an outbound
            // channel message can deep-link the exact row it is asking about.
            <li key={approval.id} id={approval.id} className="card scroll-mt-24">
              {/* Card body: eyebrow (clock + action type + child tag), subject,
               * detail, and the drafted-at requester line (design handoff §4.6). */}
              <div className="min-w-0" data-hale-pii>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mb-2">
                  <span className="eyebrow inline-flex items-center gap-1.5">
                    <Icon as={Clock} size={13} />
                    {actionTypeLabel(approval.actionType)}
                  </span>
                  <ChildTag childId={approval.childId} label={approval.childLabel} />
                </div>
                <p className="font-display text-[1.25rem] mt-1 text-spruce break-words">
                  {approval.preview}
                </p>
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
              {/* A divider above right-aligned Reject / Approve (design handoff §4.6:
               * not full-width, not left-hugging). */}
              <div className="rule mt-5" />
              <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
                <DismissButton actionId={approval.id} label={approval.preview} />
                {approval.teenUnlockable ? (
                  // Policy 4: never a decision on invisible content — the parent
                  // requests time-limited access (audited, teen notified) instead
                  // of approving a draft they cannot see.
                  <RequestTeenAccessButton actionId={approval.id} />
                ) : approval.teenRedacted ? (
                  // Redacted, but there is no teen to ask: the row names no child, and
                  // assent is per-child (rule #5). Offering "ask to see this" here
                  // opened a door that always 404s, so say so plainly instead.
                  <p className="meta text-slate-green">
                    kept private, and Hale can&rsquo;t tell whose this is — so there&rsquo;s
                    no one to ask. dismiss it, or check Settings › family &amp; children.
                  </p>
                ) : approval.verdict === APPROVED_VERDICT ? (
                  <ApproveButton actionId={approval.id} label={approval.preview} />
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {/* The other half of consent: something Hale already did that can still be taken
        * back. Only calendar placements inside the 24h window appear (HistoryView.
        * undoable, derived from the same gate the server enforces), so this section is
        * empty almost always and never offers a control the reversal would refuse. */}
      {reversible.length > 0 ? (
        <div className="rise rise-3 mt-8">
          <h2 className="font-display text-[1.125rem] text-spruce">Still reversible</h2>
          <p className="meta mt-1 text-slate-green">
            Hale put these on your calendar. You can take one back for 24 hours.
          </p>
          <ul className="mt-4 grid gap-4">
            {reversible.map((done) => (
              <li key={done.id} className="card">
                <div className="min-w-0" data-hale-pii>
                  <span className="eyebrow inline-flex items-center gap-1.5">
                    <Icon as={Clock} size={13} />
                    {actionTypeLabel(done.actionType)}
                  </span>
                  <p className="font-display text-[1.125rem] mt-1 text-spruce break-words">
                    {done.preview}
                  </p>
                  <p className="meta mt-2 text-slate-green">{done.resolvedAt}</p>
                </div>
                <div className="rule mt-4" />
                <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
                  <UndoButton actionId={done.id} label={done.preview} />
                </div>
              </li>
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
