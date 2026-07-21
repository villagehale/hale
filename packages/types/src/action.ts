/**
 * Action types — what Executor knows how to dispatch.
 */
export type ActionType =
  | 'send_email'
  | 'reply_to_email'
  | 'create_calendar_event'
  | 'update_calendar_event'
  | 'place_supply_order'
  | 'cancel_supply_order'
  | 'fill_pdf_form'
  | 'submit_government_form'
  | 'book_clinic_portal'
  | 'cancel_clinic_appointment'
  | 'share_photos_with_family'
  | 'add_to_digest_only'
  | 'add_to_routine'
  // VIL-219 (B3) — internal-write placements on Hale's OWN family calendar
  // (family_events rows), NOT the dormant Google Calendar seam. calendar_add is
  // reversible (its executor returns the new family_events id as the reversal
  // handle); calendar_cancel is the reversal — it soft-deletes the placement.
  | 'calendar_add'
  | 'calendar_move'
  | 'calendar_cancel';

/**
 * The typed payload of a calendar placement action (VIL-219). Times are ISO-8601
 * instants; the family-local rendering happens at read (ICS / plan). `reversalHandle`
 * on calendar_move/cancel is the target family_events id (from the original
 * calendar_add's executor_result). Child-scoped placements carry `childId` so the
 * teen age gate can genericize a 13+ child's title in the ICS + parent-facing copy.
 */
export interface CalendarPlacementPayload {
  title: string;
  startsAt: string;
  endsAt?: string | null;
  location?: string | null;
  childId?: string | null;
  /** Provenance of the placed item (the week_plan item's sourceRef, table+id). */
  sourceRef?: { table: string; id: string } | null;
  /** Whether the placed item is privacy-sensitive (health) — carried from the week_plan
   * item so the executor stamps family_events.sensitive, which the reminder templates
   * read to genericize the copy ("a checkup", never the detail) for everyone (VIL-223). */
  privacySensitive?: boolean;
  /** For calendar_move / calendar_cancel: the family_events row to mutate/remove. */
  reversalHandle?: string;
  /** Action-level dedup hash the reviewer's idempotency check reads. */
  action_hash?: string;
}

/** Visibility of the action's outward effect — drives Reviewer policy strictness. */
export type RecipientVisibility = 'public' | 'internal_only';

export interface DraftedAction<TPayload = Record<string, unknown>> {
  id: string;
  eventId: string;
  familyId: string;
  actionType: ActionType;
  payload: TPayload;
  draftConfidence: number;
  rationale: string;
  recipientVisibility: RecipientVisibility;
  draftedAt: string;
}

export interface ToolResult {
  tool: string;
  ok: boolean;
  result: unknown;
}

export type ReviewerVerdict =
  | { kind: 'approve'; toolResults: ToolResult[]; rationale: string }
  | { kind: 'reject'; toolResults: ToolResult[]; rationale: string; remediation?: string }
  | { kind: 'flag_for_human'; toolResults: ToolResult[]; rationale: string };

/**
 * Branded so it cannot be hand-spread into existence. The only way to obtain
 * an ApprovedAction is `mintApprovedAction`, which enforces hard rules #3/#7 at
 * the value level — a plain object literal lacks the unique-symbol brand and is
 * rejected by the Executor's signature at compile time.
 */
declare const approvedActionBrand: unique symbol;

export type ApprovedAction<TPayload = Record<string, unknown>> = DraftedAction<TPayload> & {
  verdict: Extract<ReviewerVerdict, { kind: 'approve' }>;
  approvedAt: string;
  readonly [approvedActionBrand]: true;
};

/**
 * The only constructor for ApprovedAction. Throws unless the verdict is an
 * `approve` AND every REQUIRED_CHECK for the action type was invoked with an
 * ok:true RESULT (hard rules #3 + #7 — a cap-exceeded check that ran but failed
 * blocks minting, not just a missing check). The coverage predicate is injected
 * (the worker passes `coverageSatisfiedWithResults` from @hale/tools-contracts)
 * because tools-contracts already imports @hale/types — importing it back here
 * would create a dependency cycle.
 */
export function mintApprovedAction<TPayload = Record<string, unknown>>(
  draft: DraftedAction<TPayload>,
  verdict: ReviewerVerdict,
  coverageCheck: (actionType: ActionType, results: { tool: string; ok: boolean }[]) => boolean,
): ApprovedAction<TPayload> {
  if (verdict.kind !== 'approve') {
    throw new Error(`mintApprovedAction: verdict is '${verdict.kind}', not 'approve'`);
  }
  const results = verdict.toolResults.map((r) => ({ tool: r.tool, ok: r.ok }));
  if (!coverageCheck(draft.actionType, results)) {
    const summary = results.map((r) => `${r.tool}:${r.ok ? 'ok' : 'FAIL'}`).join(', ') || 'none';
    throw new Error(
      `mintApprovedAction: COVERAGE_NOT_SATISFIED for '${draft.actionType}' (results: ${summary})`,
    );
  }
  return {
    ...draft,
    verdict,
    approvedAt: new Date().toISOString(),
  } as ApprovedAction<TPayload>;
}

export interface ExecutionResult {
  ok: boolean;
  executedAt: string;
  detail: Record<string, unknown>;
  reversible: boolean;
  /** Token/handle the Executor uses to reverse the action if requested. */
  reversalHandle?: string;
}
