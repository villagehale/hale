import { Calendar, FileText, Mail, ShoppingBag, Sparkles } from 'lucide-react';
import type { ComponentType } from 'react';
import { ApproveButton } from '~/components/hale/approve-button';
import { DismissButton } from '~/components/hale/dismiss-button';
import { actionTypeLabel } from '~/lib/format/labels';

/**
 * A small icon for the eyebrow, chosen from the action's family so the proposal
 * reads at a glance (a calendar for a schedule change, an envelope for an email).
 * An unknown type falls back to the neutral Hale spark — it never guesses a wrong
 * glyph. This reads ONLY the action-type token (rule #1: no payload).
 */
function eyebrowIcon(actionType: string): ComponentType<{ size?: number; className?: string }> {
  if (actionType.includes('calendar') || actionType.includes('clinic')) return Calendar;
  if (actionType.includes('email')) return Mail;
  if (actionType.includes('order')) return ShoppingBag;
  if (actionType.includes('form') || actionType.includes('digest') || actionType.includes('routine'))
    return FileText;
  return Sparkles;
}

/**
 * The inline approval gate (Slice 2). Once a chip drafts an action, this card lets
 * the parent approve or reject it WITHOUT leaving the chat — closing the dead end
 * where the chip pointed them off to the Approvals surface.
 *
 * Rule #1: the card shows ONLY the already-safe intent `label` and the human
 * action-type — it never fetches or renders the drafted action's payload, so no raw
 * child/teen content reaches this surface (the mockup's date/time/location rows come
 * from a drafted action's payload we deliberately do NOT have here). Approve/Reject
 * reuse the shipping ApproveButton (→ /api/actions/:id/approve) and DismissButton
 * (→ /decline): both go through the same audited, reviewer-gated routes as the
 * Approvals page (rules #3/#4/#6), so this card adds no client path that mutates
 * action state directly.
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
  const Icon = eyebrowIcon(actionType);
  return (
    <div className="card mt-3 flex flex-col gap-4 p-5">
      <div className="min-w-0">
        <span className="eyebrow flex items-center gap-2 text-faded-sage">
          <Icon aria-hidden size={14} />
          {actionTypeLabel(actionType)}
        </span>
        <p className="font-display text-[1.15rem] mt-2 font-semibold text-spruce break-words">
          {label}
        </p>
      </div>
      <div className="panel-oat px-4 py-3">
        <p className="meta">
          Hale drafted this for your approval — nothing is sent until you approve it.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <DismissButton actionId={actionId} label={label} />
        <ApproveButton actionId={actionId} label={label} />
      </div>
    </div>
  );
}
