/**
 * The pure decision logic for the inline approval gate (mobile mirror of the web
 * ActionChip / Approve / Dismiss buttons). RN-import-free so Vitest loads it
 * directly. The card in action-approval-card.tsx owns the fetch + state; this
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
