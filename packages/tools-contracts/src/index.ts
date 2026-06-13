/**
 * Reviewer verification tools — Zod-typed input/output schemas.
 *
 * The Reviewer agent MUST invoke relevant tools and the route handlers
 * MUST validate inputs/outputs against these schemas. This prevents
 * hallucinated tool args from triggering real-world actions.
 */
import type { ActionType } from '@hearth/types';
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// events.ingested — the pg-boss payload contract between apps/web (producer)
// and apps/worker (consumer). Defined once here so a field rename on either
// side fails at compile time (via IngestedEventPayload) and at runtime (via
// safeParse in the consumer), instead of failing silently.
// ─────────────────────────────────────────────────────────────────────────────
export const ingestedEventPayloadSchema = z.object({
  family_id: z.string().uuid(),
  source: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  received_at: z.string().datetime(),
});
export type IngestedEventPayload = z.infer<typeof ingestedEventPayloadSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// actions.approved — the async contract for a human approving a drafted action.
// The web app enqueues it from the approve route; the worker consumes it and
// drives the action into execution. Carrying approvedBy keeps the audit trail
// answering "which parent approved this" (PIPEDA right-to-access).
// ─────────────────────────────────────────────────────────────────────────────
export const approvedActionPayloadSchema = z.object({
  action_id: z.string().uuid(),
  family_id: z.string().uuid(),
  approved_by: z.string().min(1),
  approved_at: z.string().datetime(),
});
export type ApprovedActionPayload = z.infer<typeof approvedActionPayloadSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// check_calendar_conflict
// ─────────────────────────────────────────────────────────────────────────────
export const calendarConflictInput = z.object({
  familyId: z.string().uuid(),
  startsAt: z.string().datetime(),
  durationMinutes: z.number().int().positive(),
});
export const calendarConflictOutput = z.object({
  hasConflict: z.boolean(),
  conflictingEvents: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      startsAt: z.string().datetime(),
      endsAt: z.string().datetime(),
    }),
  ),
});
export type CalendarConflictInput = z.infer<typeof calendarConflictInput>;
export type CalendarConflictOutput = z.infer<typeof calendarConflictOutput>;

// ─────────────────────────────────────────────────────────────────────────────
// check_vaccine_schedule — Health Canada / CDC
// ─────────────────────────────────────────────────────────────────────────────
export const vaccineScheduleInput = z.object({
  childId: z.string().uuid(),
  vaccineType: z.string(),
  proposedDate: z.string().datetime(),
});
export const vaccineScheduleOutput = z.object({
  onSchedule: z.boolean(),
  expectedWindow: z
    .object({
      earliestDate: z.string().datetime(),
      latestDate: z.string().datetime(),
    })
    .optional(),
  rationale: z.string(),
});
export type VaccineScheduleInput = z.infer<typeof vaccineScheduleInput>;
export type VaccineScheduleOutput = z.infer<typeof vaccineScheduleOutput>;

// ─────────────────────────────────────────────────────────────────────────────
// check_spending_cap
// ─────────────────────────────────────────────────────────────────────────────
export const spendingCapInput = z.object({
  familyId: z.string().uuid(),
  amountUsd: z.number().nonnegative(),
  category: z.string(),
});
export const spendingCapOutput = z.object({
  withinLimits: z.boolean(),
  exceededCap: z
    .enum(['per_action', 'per_day', 'per_month', 'category_requires_approval'])
    .optional(),
  limitUsd: z.number().optional(),
  rationale: z.string(),
});
export type SpendingCapInput = z.infer<typeof spendingCapInput>;
export type SpendingCapOutput = z.infer<typeof spendingCapOutput>;

// ─────────────────────────────────────────────────────────────────────────────
// check_recipient_allowlist
// ─────────────────────────────────────────────────────────────────────────────
export const recipientAllowlistInput = z.object({
  familyId: z.string().uuid(),
  recipient: z.string(),
  recipientCategory: z.enum(['general', 'medical', 'legal', 'financial', 'unknown']),
});
export const recipientAllowlistOutput = z.object({
  allowed: z.boolean(),
  requiresApproval: z.boolean(),
  rationale: z.string(),
});
export type RecipientAllowlistInput = z.infer<typeof recipientAllowlistInput>;
export type RecipientAllowlistOutput = z.infer<typeof recipientAllowlistOutput>;

// ─────────────────────────────────────────────────────────────────────────────
// check_sender_allowlist (for inbound triggers)
// ─────────────────────────────────────────────────────────────────────────────
export const senderAllowlistInput = z.object({
  familyId: z.string().uuid(),
  sender: z.string(),
});
export const senderAllowlistOutput = z.object({
  trusted: z.boolean(),
  firstSeenAt: z.string().datetime().optional(),
  rationale: z.string(),
});
export type SenderAllowlistInput = z.infer<typeof senderAllowlistInput>;
export type SenderAllowlistOutput = z.infer<typeof senderAllowlistOutput>;

// ─────────────────────────────────────────────────────────────────────────────
// check_action_time_window
// ─────────────────────────────────────────────────────────────────────────────
export const actionTimeWindowInput = z.object({
  familyId: z.string().uuid(),
  proposedExecutionAt: z.string().datetime(),
});
export const actionTimeWindowOutput = z.object({
  withinWindow: z.boolean(),
  windowDescription: z.string(),
  nextAllowedAt: z.string().datetime().optional(),
});
export type ActionTimeWindowInput = z.infer<typeof actionTimeWindowInput>;
export type ActionTimeWindowOutput = z.infer<typeof actionTimeWindowOutput>;

// ─────────────────────────────────────────────────────────────────────────────
// check_action_idempotency
// ─────────────────────────────────────────────────────────────────────────────
export const actionIdempotencyInput = z.object({
  familyId: z.string().uuid(),
  actionHash: z.string(),
  lookbackHours: z.number().int().positive().default(24),
});
export const actionIdempotencyOutput = z.object({
  isDuplicate: z.boolean(),
  matchedActionId: z.string().uuid().optional(),
  rationale: z.string(),
});
export type ActionIdempotencyInput = z.infer<typeof actionIdempotencyInput>;
export type ActionIdempotencyOutput = z.infer<typeof actionIdempotencyOutput>;

// ─────────────────────────────────────────────────────────────────────────────
// check_pii_leak
// ─────────────────────────────────────────────────────────────────────────────
export const piiLeakInput = z.object({
  familyId: z.string().uuid(),
  content: z.string(),
  allowedRecipients: z.array(z.string()),
  /**
   * The family's children's names, so child_full_name leaks can be matched
   * against the real names. Optional + additive: when omitted (no child data
   * wired for this family), the tool result notes names_unavailable rather than
   * silently passing — a degraded, observable state, not a hidden one.
   */
  knownChildNames: z.array(z.string()).optional(),
});
export const piiLeakOutput = z.object({
  leakDetected: z.boolean(),
  detections: z.array(
    z.object({
      kind: z.enum(['child_full_name', 'child_dob', 'medical_record', 'sin', 'phone', 'address']),
      excerpt: z.string(),
      recommendation: z.string(),
    }),
  ),
  /** True when no child names were supplied, so child_full_name could not be checked. */
  namesUnavailable: z.boolean().optional(),
});
export type PiiLeakInput = z.infer<typeof piiLeakInput>;
export type PiiLeakOutput = z.infer<typeof piiLeakOutput>;

// ─────────────────────────────────────────────────────────────────────────────
// check_user_override
// ─────────────────────────────────────────────────────────────────────────────
export const userOverrideInput = z.object({
  familyId: z.string().uuid(),
  userId: z.string().uuid().optional(),
  actionType: z.string(),
});
export const userOverrideOutput = z.object({
  override: z.enum(['none', 'always_ask', 'autonomous_allowed', 'never']),
  setBy: z.string().uuid().optional(),
  setAt: z.string().datetime().optional(),
});
export type UserOverrideInput = z.infer<typeof userOverrideInput>;
export type UserOverrideOutput = z.infer<typeof userOverrideOutput>;

// ─────────────────────────────────────────────────────────────────────────────
// Registry — name → { input, output } pairs for Reviewer tool dispatch
// ─────────────────────────────────────────────────────────────────────────────
export const REVIEWER_TOOLS = {
  check_calendar_conflict: {
    input: calendarConflictInput,
    output: calendarConflictOutput,
  },
  check_vaccine_schedule: {
    input: vaccineScheduleInput,
    output: vaccineScheduleOutput,
  },
  check_spending_cap: {
    input: spendingCapInput,
    output: spendingCapOutput,
  },
  check_recipient_allowlist: {
    input: recipientAllowlistInput,
    output: recipientAllowlistOutput,
  },
  check_sender_allowlist: {
    input: senderAllowlistInput,
    output: senderAllowlistOutput,
  },
  check_action_time_window: {
    input: actionTimeWindowInput,
    output: actionTimeWindowOutput,
  },
  check_action_idempotency: {
    input: actionIdempotencyInput,
    output: actionIdempotencyOutput,
  },
  check_pii_leak: {
    input: piiLeakInput,
    output: piiLeakOutput,
  },
  check_user_override: {
    input: userOverrideInput,
    output: userOverrideOutput,
  },
} as const;

export type ReviewerToolName = keyof typeof REVIEWER_TOOLS;

// ─────────────────────────────────────────────────────────────────────────────
// REQUIRED_CHECKS — per-action-type verification policy (hard rules #3 + #7)
//
// The Reviewer MUST have invoked every check listed here AND received ok:true
// from each before its `approve` verdict can be accepted (enforced downstream
// via `coverageSatisfiedWithResults`).
//
// `satisfies Record<ActionType, ...>` is load-bearing: it makes adding a new
// ActionType in @hearth/types without a matrix entry a COMPILE ERROR. As the
// product fans action types out across the four family stages, no new outward
// action can ship un-gated by accident.
//
// check_calendar_conflict and check_vaccine_schedule are deliberately ABSENT:
// they are permanently not_configured stubs (ratified brief decision). Requiring
// an unsatisfiable check would deadlock the pipeline — every action gated by it
// would be impossible to approve.
// ─────────────────────────────────────────────────────────────────────────────
export const REQUIRED_CHECKS = {
  // Outbound email to a recipient: PII leak guard + recipient allowlist +
  // dedup. No inbound sender, so no sender allowlist.
  send_email: ['check_pii_leak', 'check_recipient_allowlist', 'check_action_idempotency'],

  // Reply to inbound mail: as send_email PLUS the sender must be a trusted
  // origin (a reply implies an inbound thread). Hard rule #1 / task: PII +
  // recipient + sender allowlist all required.
  reply_to_email: [
    'check_pii_leak',
    'check_recipient_allowlist',
    'check_sender_allowlist',
    'check_action_idempotency',
  ],

  // New calendar event: respect quiet-hours window + don't double-create.
  create_calendar_event: ['check_action_time_window', 'check_action_idempotency'],

  // Mutating an existing event: same gates as creation.
  update_calendar_event: ['check_action_time_window', 'check_action_idempotency'],

  // Spends money (Stripe + merchant) → check_spending_cap is mandatory
  // (hard rule #7). Plus dedup and the user's autonomy override.
  place_supply_order: ['check_spending_cap', 'check_action_idempotency', 'check_user_override'],

  // Cancelling an order can incur restock/cancellation fees → monetary,
  // so check_spending_cap applies. Plus dedup.
  cancel_supply_order: ['check_spending_cap', 'check_action_idempotency'],

  // Government/clinic PDFs carry newborn PII → leak guard + dedup.
  fill_pdf_form: ['check_pii_leak', 'check_action_idempotency'],

  // CRA/ESDC submissions: may carry fees (monetary → spending cap) and always
  // carry PII; high-stakes so the user's override is consulted.
  submit_government_form: [
    'check_spending_cap',
    'check_pii_leak',
    'check_action_idempotency',
    'check_user_override',
  ],

  // Booking a clinic portal slot (Computer Use): may incur booking/no-show
  // fees (monetary → spending cap), must respect time window, and not double-book.
  book_clinic_portal: [
    'check_spending_cap',
    'check_action_time_window',
    'check_action_idempotency',
  ],

  // Cancelling an appointment: time-sensitive + idempotent. No money leaves.
  cancel_clinic_appointment: ['check_action_time_window', 'check_action_idempotency'],

  // Sharing photos outward leaks the most sensitive PII (a child's image) to a
  // recipient → PII guard + recipient allowlist + dedup.
  share_photos_with_family: [
    'check_pii_leak',
    'check_recipient_allowlist',
    'check_action_idempotency',
  ],

  // Internal-only digest entry: no outward effect, but still must be idempotent
  // so retries don't double-post. Non-empty per policy.
  add_to_digest_only: ['check_action_idempotency'],
} as const satisfies Record<ActionType, readonly ReviewerToolName[]>;

// ─────────────────────────────────────────────────────────────────────────────
// CROSS_PARENT_ACTION_TYPES — action types whose effect touches BOTH parents'
// data, requiring two-parent consent before autonomous execution (hard rule #5).
//
// Membership is derived from the ActionType union by effect, justified per type:
//   share_photos_with_family — shares a child's image (data both parents jointly
//     hold) OUTWARD to a recipient; a unilateral share exposes the co-parent's
//     child too.
//   create_calendar_event / update_calendar_event — writes to the shared family
//     calendar; an event/invite commits the co-parent's schedule, not just the
//     acting parent's.
//   family_event_invite is an EVENT type, not an ActionType — its calendar-write
//     effect is already covered by the two calendar action types above.
//
// All other action types touch only the acting parent's surface (their email
// thread, their order, their form) or internal-only state (digest), so they are
// out of scope for two-parent consent.
// ─────────────────────────────────────────────────────────────────────────────
export const CROSS_PARENT_ACTION_TYPES: ReadonlySet<ActionType> = new Set<ActionType>([
  'share_photos_with_family',
  'create_calendar_event',
  'update_calendar_event',
]);

/** True iff `actionType` affects both parents' data (hard rule #5). Pure — no I/O. */
export function isCrossParentActionType(actionType: ActionType): boolean {
  return CROSS_PARENT_ACTION_TYPES.has(actionType);
}

/**
 * True iff every check required for `actionType` was invoked AND returned
 * ok:true. Pure — no I/O. This is the structural enforcement of hard rules
 * #3 (no approval on prose alone) + #7 (cap exceeded → reject): a check that
 * ran but failed (e.g. check_spending_cap {ok:false}) blocks approval, not just
 * a missing check. Name presence alone is insufficient — the RESULT must be ok.
 *
 * Extra tool results are harmless; an empty list never satisfies a non-empty
 * policy, so it always fails (every entry is non-empty by construction).
 */
export function coverageSatisfiedWithResults(
  actionType: ActionType,
  results: { tool: string; ok: boolean }[],
): boolean {
  const okByTool = new Map(results.map((r) => [r.tool, r.ok]));
  return REQUIRED_CHECKS[actionType].every((check) => okByTool.get(check) === true);
}

/**
 * The first required check for `actionType` that is missing or returned
 * ok:false — the machine-readable reason a coverage gate failed. Returns null
 * when coverage is fully satisfied.
 */
export function firstUnsatisfiedCheck(
  actionType: ActionType,
  results: { tool: string; ok: boolean }[],
): string | null {
  const okByTool = new Map(results.map((r) => [r.tool, r.ok]));
  return REQUIRED_CHECKS[actionType].find((check) => okByTool.get(check) !== true) ?? null;
}
