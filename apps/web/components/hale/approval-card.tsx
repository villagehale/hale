import { Shield } from 'lucide-react';
import { actionGlyph } from '~/components/hale/action-glyph';
import { ApproveButton } from '~/components/hale/approve-button';
import { ChildTag } from '~/components/hale/child-tag';
import { DismissButton } from '~/components/hale/dismiss-button';
import { DraftDetail } from '~/components/hale/draft-detail';
import { RequestTeenAccessButton } from '~/components/hale/request-teen-access-button';
import { ToneLabel } from '~/components/hale/tone';
import { UndoButton } from '~/components/hale/undo-button';
import { TintChip } from '~/components/ui/tint-chip';
import type { ApprovalView } from '~/lib/dashboard/approvals';
import type { HistoryView } from '~/lib/dashboard/history';
import { actionTypeLabel } from '~/lib/format/labels';

/**
 * The two card shapes of the consent surface, on Hale Shore's card anatomy — the
 * pending draft awaiting a decision, and the executed placement still inside its
 * reversal window. They live here rather than inline in the page so the surface can
 * be rendered from literal props (design QA, and any future test that wants the card
 * without a database).
 *
 * Both are presentation only. Every state-changing control is the shipping button
 * component it always was — Approve → /api/actions/:id/approve, Dismiss → /decline,
 * Undo → /undo — so the audited, reviewer-gated routes (rules #3/#4/#6) remain the
 * only path from this surface to an action's state.
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

/**
 * The id of the row's preview node. Every row's controls read alike ("approve &
 * send", "undo this"), so the preview has to join their accessible name — and it
 * joins by REFERENCE, because rrweb records attribute values verbatim past the text
 * mask, so an `aria-label` carrying the preview would put the draft into a session
 * replay (VIL-274, rule #1). Derived from the action id, which already anchors the
 * row, so it is unique per row and stable across renders without a hook — these
 * cards render on the server, where `useId` is unavailable.
 */
export function previewIdFor(actionId: string): string {
  return `${actionId}-preview`;
}

/**
 * The card's leading mark. A redacted row leads with the PRIVACY mark rather than
 * its action family: what the parent needs to read first is that this one is held
 * back, not what kind of thing it is.
 */
function rowChip(actionType: string, teenRedacted: boolean) {
  if (teenRedacted) return { as: Shield, tone: 'red' as const };
  const { icon, tone } = actionGlyph(actionType);
  return { as: icon, tone };
}

/**
 * Shore's teen-redaction treatment, ported from apps/mobile's ApprovalPayloadBlock:
 * a RECESSED sub-panel (canvas inside a card) carrying the privacy mark and the one
 * line that says what a parent can do about it. The recess is the point — a held-back
 * payload reads as something set aside, not as an alert.
 */
function TeenRecess() {
  return (
    <div className="panel-recess mt-3 flex flex-col items-start gap-2">
      <span className="pill pill-berry inline-flex items-center gap-1.5">
        <Shield size={13} strokeWidth={1.8} aria-hidden="true" />
        Redacted · teen privacy
      </span>
      <p className="meta">
        Raw content stays hidden by default. Your teen can grant time-limited access if you ask.
      </p>
    </div>
  );
}

/** The card head both shapes share: the tint chip beside an eyebrow (+ optional
 * child tag) over the serif title role carrying the human preview. */
function CardHead({
  actionType,
  teenRedacted,
  preview,
  previewId,
  children,
}: {
  actionType: string;
  teenRedacted: boolean;
  preview: string;
  previewId: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <TintChip {...rowChip(actionType, teenRedacted)} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="eyebrow">{actionTypeLabel(actionType)}</span>
          {children}
        </div>
        <p
          id={previewId}
          className="font-display text-[1.375rem] leading-[1.75rem] font-medium tracking-[-0.02em] mt-1 text-ink break-words"
        >
          {preview}
        </p>
      </div>
    </div>
  );
}

/**
 * A draft waiting on the parent. The decision controls sit below a divider, right
 * aligned, with dismiss as the quiet secondary and approve as the one filled
 * button — the same weighting the surface has always had, because the visual
 * hierarchy of a consent queue IS part of what the consent means.
 */
export function ApprovalCard({ approval }: { approval: ApprovalView }) {
  const previewId = previewIdFor(approval.id);
  return (
    // VIL-244 · M9: the draft's action id is its anchor, so an outbound channel
    // message can deep-link the exact row it is asking about.
    <li id={approval.id} className="card scroll-mt-24">
      <div className="min-w-0" data-hale-pii>
        <CardHead
          actionType={approval.actionType}
          teenRedacted={approval.teenRedacted}
          preview={approval.preview}
          previewId={previewId}
        >
          <ChildTag childId={approval.childId} label={approval.childLabel} />
        </CardHead>
        {NEEDS_YOU_VERDICTS.has(approval.verdict) ? (
          <p className="mt-3">
            <ToneLabel tone="needs-you" detail={approval.summary} />
          </p>
        ) : (
          <p className="meta mt-3 text-ink-2">{approval.summary}</p>
        )}
        <p className="meta mt-2 text-ink-3">drafted {approval.draftedAt}</p>
        {approval.teenRedacted ? <TeenRecess /> : null}
        <DraftDetail actionType={approval.actionType} payload={approval.payload} />
      </div>
      {/* A divider above right-aligned Reject / Approve (design handoff §4.6:
       * not full-width, not left-hugging). */}
      <div className="rule mt-5" />
      <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
        <DismissButton actionId={approval.id} label={approval.preview} labelledBy={previewId} />
        {approval.teenUnlockable ? (
          // Policy 4: never a decision on invisible content — the parent
          // requests time-limited access (audited, teen notified) instead
          // of approving a draft they cannot see.
          <RequestTeenAccessButton actionId={approval.id} />
        ) : approval.teenRedacted ? (
          // Redacted, but there is no teen to ask: the row names no child, and
          // assent is per-child (rule #5). Offering "ask to see this" here
          // opened a door that always 404s, so say so plainly instead.
          <p className="meta text-ink-2">
            kept private, and Hale can&rsquo;t tell whose this is — so there&rsquo;s no one to
            ask. dismiss it, or check Settings › family &amp; children.
          </p>
        ) : approval.verdict === APPROVED_VERDICT ? (
          <ApproveButton actionId={approval.id} labelledBy={previewId} />
        ) : null}
      </div>
    </li>
  );
}

/** Something Hale already did that can still be taken back — the other half of
 * consent. Offered only when the server would accept the reversal. */
export function ReversibleCard({ done }: { done: HistoryView }) {
  const previewId = previewIdFor(done.id);
  return (
    <li className="card">
      <div className="min-w-0" data-hale-pii>
        <CardHead
          actionType={done.actionType}
          teenRedacted={done.teenRedacted}
          preview={done.preview}
          previewId={previewId}
        />
        <p className="meta mt-3 text-ink-3">{done.resolvedAt}</p>
      </div>
      <div className="rule mt-4" />
      <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
        <UndoButton actionId={done.id} labelledBy={previewId} />
      </div>
    </li>
  );
}
