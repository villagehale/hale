/**
 * PLACEHOLDER action queue. NOT real and NOT from any API. Per hard rule #1,
 * actions about a teen (13+) are REDACTED for parents: only category/summary is
 * shown — never raw content — unless an explicit, logged grant exists. Newborn/
 * young-child actions show the full reviewed payload.
 */

export type ReviewerVerdict = 'approve' | 'needs_review';

export type ApprovalAction = {
  id: string;
  actionType: string;
  subject: string;
  preview: string;
  verdict: ReviewerVerdict;
  reviewerNote: string;
  /** A teen (13+) subject ⇒ raw payload redacted from the parent by default. */
  teenRedacted: boolean;
  /** Full payload, only surfaced when not teen-redacted. */
  payload?: string;
  /** Category shown in place of payload when redacted. */
  category?: string;
};

export const APPROVAL_ACTIONS: ApprovalAction[] = [
  {
    id: 'book-checkup',
    actionType: 'Book appointment',
    subject: 'Anaya',
    preview: 'Book Anaya’s 4-month well-baby visit with Dr. Okafor.',
    verdict: 'approve',
    reviewerNote: 'Verified clinic hours and that the slot is within the recommended window.',
    teenRedacted: false,
    payload:
      'POST /appointments { child: "anaya", provider: "dr-okafor", date: "2026-07-02T14:15" }',
  },
  {
    id: 'order-formula',
    actionType: 'Reorder supplies',
    subject: 'Anaya',
    preview: 'Reorder the usual formula before you run out (≈4 days left).',
    verdict: 'approve',
    reviewerNote: 'Checked spending cap and confirmed the same product as last order.',
    teenRedacted: false,
    payload: 'POST /cart { sku: "formula-stage1", qty: 2, est_cost_cad: 58.0 }',
  },
  {
    id: 'teen-message',
    actionType: 'Draft a reply',
    subject: 'Maya (14)',
    preview: 'Hale drafted a supportive reply about a stressful school day.',
    verdict: 'needs_review',
    reviewerNote: 'Teen content — only the category is shared with you unless Maya grants access.',
    teenRedacted: true,
    category: 'Emotional support · school stress',
  },
];
