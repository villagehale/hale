/**
 * Reviewer verification tools — Zod-typed input/output schemas.
 *
 * The Reviewer agent MUST invoke relevant tools and the route handlers
 * MUST validate inputs/outputs against these schemas. This prevents
 * hallucinated tool args from triggering real-world actions.
 */
import { z } from 'zod';

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
