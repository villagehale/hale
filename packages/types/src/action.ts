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
  | 'add_to_digest_only';

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

export interface ApprovedAction<TPayload = Record<string, unknown>> extends DraftedAction<TPayload> {
  verdict: Extract<ReviewerVerdict, { kind: 'approve' }>;
  approvedAt: string;
}

export interface ExecutionResult {
  ok: boolean;
  executedAt: string;
  detail: Record<string, unknown>;
  reversible: boolean;
  /** Token/handle the Executor uses to reverse the action if requested. */
  reversalHandle?: string;
}
