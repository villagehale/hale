/**
 * The pure decision logic for the inline approval gate (mobile mirror of the web
 * ActionChip / Approve / Dismiss buttons). RN-import-free so Vitest loads it
 * directly. The card in drafted-action-card.tsx owns the fetch + state; this
 * module owns the "what does this HTTP outcome mean" call so it's unit-tested
 * without a network round-trip or a native runtime.
 *
 * The contracts mirror the shipping routes exactly:
 *   POST /api/coach/action       → 202 { actionId }  (draft held for approval)
 *   POST /api/actions/:id/approve → 202              (queued for the drain)
 *   POST /api/actions/:id/decline → 200              (dismissed)
 * Anything else is an error the card must surface (CLAUDE.md #8 — never silent).
 */

export interface ActionRequestBody {
  intentKind: string;
  focusedChildId?: string;
  sourceAnswer: string;
}

/**
 * Build the draft request body for an inline action. `focusedChildId` is the child
 * the source turn was asked about (the mobile chat is whole-family today, so this
 * is null and the field is omitted → a whole-family draft the route accepts).
 * Mirrors the web buildActionRequest.
 */
export function buildActionRequest(
  intentKind: string,
  focusedChildId: string | null,
  sourceAnswer: string,
): ActionRequestBody {
  return {
    intentKind,
    ...(focusedChildId ? { focusedChildId } : {}),
    sourceAnswer,
  };
}

/** The outcome the draft response carries: the drafted action's id or nothing. */
type DraftResponse = { status: number; actionId?: unknown };

/**
 * Read the drafted action's id off a /api/coach/action response. The route returns
 * 202 { status: 'drafted_for_approval', actionId }; anything else (or a 202 missing
 * a string id) yields null so the card surfaces an error instead of rendering an
 * approval card wired to nothing. Mirrors the web parseDraftResponse.
 */
export function parseDraftResponse(res: DraftResponse): string | null {
  if (res.status !== 202) return null;
  return typeof res.actionId === 'string' ? res.actionId : null;
}

export type ApproveState = 'approved' | 'error';
export type DeclineState = 'dismissed' | 'error';

/** Settle the approve POST: 202 (queued for the drain) → 'approved', else 'error'. */
export function approveResult(status: number): ApproveState {
  return status === 202 ? 'approved' : 'error';
}

/** Settle the decline POST: 200 (dismissed) → 'dismissed', else 'error'. */
export function declineResult(status: number): DeclineState {
  return status === 200 ? 'dismissed' : 'error';
}

/**
 * The action types whose executor is actually wired today (apps/worker executor.ts):
 * email sends via Resend, and the two internal writes (digest note / routine pin).
 * Everything else — calendar (no Google OAuth), supply orders, forms, clinic
 * portals, photo sharing — throws HALE_NOT_CONFIGURED at execution. This list is the
 * HONEST boundary the approved card reads: it must never claim Hale "did" something
 * an executor will refuse. Keep in sync with the executor's configured cases.
 */
const CONFIGURED_ACTION_TYPES: ReadonlySet<string> = new Set([
  'send_email',
  'reply_to_email',
  'add_to_digest_only',
  'add_to_routine',
]);

/**
 * The honest post-approval line for an action type. A configured executor queues
 * for the drain and runs for real → the parent is told Hale is on it. An unwired
 * action type (calendar et al.) is approved but cannot execute yet → the parent is
 * told the truth: it lands when the integration comes online. NEVER a fake
 * "Done"/"Scheduled" (the executor would throw). Pure, so it's unit-tested.
 */
export function approvedPostState(actionType: string): string {
  return CONFIGURED_ACTION_TYPES.has(actionType)
    ? 'Approved — Hale is on it.'
    : 'Approved — Hale will handle this as integrations come online.';
}
