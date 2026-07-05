import { ApproveButton } from '~/components/hale/approve-button';
import { DismissButton } from '~/components/hale/dismiss-button';
import { actionTypeLabel } from '~/lib/format/labels';

/**
 * The inline approval gate (Slice 2). Once a chip drafts an action, this card lets
 * the parent approve or reject it WITHOUT leaving the chat — closing the dead end
 * where the chip pointed them off to the Approvals surface.
 *
 * Rule #1: the card shows ONLY the already-safe intent `label` and the human
 * action-type — it never fetches or renders the drafted action's payload, so no raw
 * child/teen content reaches this surface. Approve/Reject reuse the shipping
 * ApproveButton (→ /api/actions/:id/approve) and DismissButton (→ /decline): both go
 * through the same audited, reviewer-gated routes as the Approvals page (rules
 * #3/#4/#6), so this card adds no client path that mutates action state directly.
 */
export function ActionApprovalCard({
  actionId,
  label,
  actionType,
}: {
  actionId: string;
  label: string;
  actionType: string;
}) {
  return (
    <div className="panel-apricot-tint mt-3 p-4 flex flex-col gap-3">
      <div className="min-w-0">
        <span className="eyebrow">{actionTypeLabel(actionType)}</span>
        <p className="font-display text-[1.05rem] mt-1 text-spruce break-words">{label}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <DismissButton actionId={actionId} label={label} />
        <ApproveButton actionId={actionId} label={label} />
      </div>
    </div>
  );
}
