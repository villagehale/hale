import type { ApprovedAction, CalendarPlacementPayload, ExecutionResult } from '@hale/types';
import { Resend } from 'resend';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  type CalendarClient,
  type CalendarEventInput,
  realCalendarClient,
} from './calendar-client.js';
import {
  type CalendarCancelInput,
  type CalendarMoveInput,
  type CalendarPlacementInput,
  type CalendarWriteResult,
  type InternalWriteOutcome,
  addToCalendar as addToCalendarDb,
  addToDigest as addToDigestDb,
  addToRoutine as addToRoutineDb,
  cancelCalendarEvent as cancelCalendarEventDb,
  moveCalendarEvent as moveCalendarEventDb,
} from './internal-writes.js';
import {
  claimOutboundSend as claimOutboundSendDb,
  confirmOutboundSend as confirmOutboundSendDb,
  recordSendSkippedDuplicate,
} from './memory-writer.js';

interface ExecutorRunInput {
  familyId: string;
  /** Branded — only `mintApprovedAction` can produce this; a hand-spread literal won't typecheck. */
  approved: ApprovedAction;
}

interface SendResult {
  messageId?: string;
  submittedAt?: string;
}

/**
 * Injectable seams for the Executor's outbound side. Defaults hit Postgres +
 * Resend; tests pass stubs to prove the B9 idempotency invariant without a
 * live DB or live provider.
 */
export interface InternalWriteInput {
  familyId: string;
  actionId: string;
  eventId: string;
  title: string;
  notes: string | null;
}

export interface ExecutorDeps {
  /** Inserts the outbound_sends claim; false ⇒ already claimed ⇒ do NOT send. */
  claimOutboundSend: (actionId: string) => Promise<boolean>;
  /** Records sent_at + provider id after the provider confirms. */
  confirmOutboundSend: (actionId: string, providerMessageId: string) => Promise<void>;
  /** Audits a suppressed redelivery (action.send_skipped_duplicate). */
  recordSkippedDuplicate: (familyId: string, actionId: string) => Promise<void>;
  /** The actual email transport. */
  sendEmail: (payload: EmailPayload) => Promise<SendResult>;
  /** Pins an accepted village item onto the current week's plan (add_to_routine). */
  addToRoutine: (input: InternalWriteInput) => Promise<InternalWriteOutcome>;
  /** Records an accepted village item as an undated digest note (add_to_digest_only). */
  addToDigest: (input: InternalWriteInput) => Promise<InternalWriteOutcome>;
  /** Places a Hale-authored event on family_events (calendar_add); returns its id. */
  addToCalendar: (input: CalendarPlacementInput) => Promise<CalendarWriteResult>;
  /** Re-times an existing placement (calendar_move). */
  moveCalendarEvent: (input: CalendarMoveInput) => Promise<CalendarWriteResult>;
  /** Soft-deletes an existing placement (calendar_cancel). */
  cancelCalendarEvent: (input: CalendarCancelInput) => Promise<CalendarWriteResult>;
  /** Google Calendar transport (create/update). Real impl throws until OAuth exists. */
  calendar: CalendarClient;
}

function defaultDeps(): ExecutorDeps {
  return {
    claimOutboundSend: (actionId) => claimOutboundSendDb(actionId),
    confirmOutboundSend: (actionId, providerMessageId) =>
      confirmOutboundSendDb(actionId, providerMessageId),
    recordSkippedDuplicate: (familyId, actionId) => recordSendSkippedDuplicate(familyId, actionId),
    sendEmail: resendSend,
    addToRoutine: (input) => addToRoutineDb(input),
    addToDigest: (input) => addToDigestDb(input),
    addToCalendar: (input) => addToCalendarDb(input),
    moveCalendarEvent: (input) => moveCalendarEventDb(input),
    cancelCalendarEvent: (input) => cancelCalendarEventDb(input),
    calendar: realCalendarClient,
  };
}

/**
 * Executor — dispatches approved actions to real-world tools.
 *
 * Email send is implemented via the Resend SDK. Other action types
 * require integrations (Google Calendar OAuth, Stripe + merchant
 * adapters, Computer Use for portal automation) that the worker
 * doesn't yet have credentials for. Those throw a clear
 * `HALE_NOT_CONFIGURED` error so the system fails LOUD rather than
 * pretending to succeed — which would silently degrade the
 * autonomous-trust promise.
 */
export async function runExecutor(
  input: ExecutorRunInput,
  deps: ExecutorDeps = defaultDeps(),
): Promise<ExecutionResult> {
  logger.info(
    {
      familyId: input.familyId,
      actionType: input.approved.actionType,
      actionId: input.approved.id,
    },
    'executor: dispatching',
  );

  switch (input.approved.actionType) {
    case 'send_email':
    case 'reply_to_email':
      return sendEmail(input, deps);

    case 'create_calendar_event':
    case 'update_calendar_event':
      return calendarEvent(input, deps);

    case 'place_supply_order':
    case 'cancel_supply_order':
      throw notConfigured('Stripe + merchant adapter not wired.');

    case 'fill_pdf_form':
      throw notConfigured('PDF form-fill service not wired.');

    case 'submit_government_form':
      throw notConfigured('CRA / ESDC submission flow not wired.');

    case 'book_clinic_portal':
    case 'cancel_clinic_appointment':
      throw notConfigured('Pediatric portal Computer Use automation not wired for this clinic.');

    case 'share_photos_with_family':
      throw notConfigured('Photo sharing dispatch not wired.');

    case 'add_to_digest_only': {
      const outcome = await deps.addToDigest(internalWriteInput(input));
      return {
        ok: true,
        executedAt: new Date().toISOString(),
        detail: { kind: 'digest_note', outcome },
        reversible: true,
      };
    }

    case 'add_to_routine': {
      const outcome = await deps.addToRoutine(internalWriteInput(input));
      return {
        ok: true,
        executedAt: new Date().toISOString(),
        detail: { kind: 'routine_pin', outcome },
        reversible: true,
      };
    }

    case 'calendar_add':
    case 'calendar_move':
    case 'calendar_cancel':
      return calendarPlacement(input, deps);

    default: {
      const exhaustive: never = input.approved.actionType;
      throw new Error(`unhandled action_type in Executor: ${String(exhaustive)}`);
    }
  }
}

// ─── send_email ──────────────────────────────────────────────────────────

export interface EmailPayload {
  to?: string;
  from?: string;
  subject?: string;
  body?: string;
  cc?: string[];
  reply_to_message_id?: string;
}

/**
 * Claim-then-send. The claim insert is the idempotency gate: on a pg-boss
 * redelivery (e.g. a worker that sent successfully but crashed before the
 * orchestrator committed) the claim conflicts, so the provider is never
 * called twice. sent_at is written only after the provider confirms.
 */
async function sendEmail(input: ExecutorRunInput, deps: ExecutorDeps): Promise<ExecutionResult> {
  const actionId = input.approved.id;
  const payload = input.approved.payload as EmailPayload;
  if (!payload.to || !payload.subject || !payload.body) {
    throw new Error('send_email payload missing required fields (to, subject, body)');
  }

  const claimed = await deps.claimOutboundSend(actionId);
  if (!claimed) {
    logger.warn(
      { familyId: input.familyId, actionId },
      'executor: outbound send already claimed — skipping duplicate send',
    );
    await deps.recordSkippedDuplicate(input.familyId, actionId);
    return {
      ok: true,
      executedAt: new Date().toISOString(),
      detail: { kind: 'send_skipped_duplicate', actionId },
      reversible: false,
    };
  }

  const result = await deps.sendEmail(payload);
  const messageId = result.messageId;
  if (!messageId) {
    throw new Error('email provider returned no message id');
  }
  await deps.confirmOutboundSend(actionId, messageId);

  return {
    ok: true,
    executedAt: new Date().toISOString(),
    detail: {
      kind: 'email_sent',
      messageId,
      submittedAt: result.submittedAt,
      recipient: payload.to,
    },
    reversible: false,
    reversalHandle: messageId,
  };
}

// ─── add_to_routine / add_to_digest_only ─────────────────────────────────

/** The accepted village candidate's coarse fields (rule #1) → the internal-write
 * shape. `title` is required (the item has no meaning without it); `summary`
 * becomes the plan's notes. */
function internalWriteInput(input: ExecutorRunInput): InternalWriteInput {
  const payload = input.approved.payload as { title?: unknown; summary?: unknown };
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  if (!title) {
    throw new Error(`${input.approved.actionType} payload missing required field (title)`);
  }
  const notes =
    typeof payload.summary === 'string' && payload.summary.trim() ? payload.summary.trim() : null;
  return {
    familyId: input.familyId,
    actionId: input.approved.id,
    eventId: input.approved.eventId,
    title,
    notes,
  };
}

// ─── create/update_calendar_event ────────────────────────────────────────

/**
 * Calendar create/update via the injected CalendarClient. The default client
 * throws HALE_NOT_CONFIGURED (no Google OAuth yet); the interface is here so the
 * case is wired and the executor's contract is testable with a Fake, and so
 * finishing the integration touches only calendar-client.ts. The reviewer's
 * check_action_idempotency (REQUIRED_CHECKS) already gated the mint, so a
 * redelivery of an already-created event is deduped upstream.
 */
async function calendarEvent(
  input: ExecutorRunInput,
  deps: ExecutorDeps,
): Promise<ExecutionResult> {
  const payload = input.approved.payload as {
    title?: unknown;
    starts_at?: unknown;
    ends_at?: unknown;
    description?: unknown;
    provider_event_id?: unknown;
  };
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  const startsAt = typeof payload.starts_at === 'string' ? payload.starts_at : '';
  const endsAt = typeof payload.ends_at === 'string' ? payload.ends_at : '';
  if (!title || !startsAt || !endsAt) {
    throw new Error(
      `${input.approved.actionType} payload missing required fields (title, starts_at, ends_at)`,
    );
  }

  const event: CalendarEventInput = {
    familyId: input.familyId,
    title,
    startsAt,
    endsAt,
    description: typeof payload.description === 'string' ? payload.description : undefined,
    providerEventId:
      typeof payload.provider_event_id === 'string' ? payload.provider_event_id : undefined,
  };

  const result =
    input.approved.actionType === 'update_calendar_event'
      ? await deps.calendar.updateEvent(event)
      : await deps.calendar.createEvent(event);

  return {
    ok: true,
    executedAt: new Date().toISOString(),
    detail: {
      kind:
        input.approved.actionType === 'update_calendar_event'
          ? 'calendar_updated'
          : 'calendar_created',
      providerEventId: result.providerEventId,
    },
    reversible: true,
    reversalHandle: result.providerEventId,
  };
}

// ─── calendar_add / calendar_move / calendar_cancel (VIL-219) ────────────

/**
 * Internal-write calendar placements onto Hale's OWN family_events (source
 * 'placement'), NOT the dormant Google Calendar seam. calendar_add returns the
 * new row id as the reversal handle NESTED IN `detail` — the orchestrator persists
 * only `detail` into actions.executor_result, so a top-level reversalHandle would
 * be dropped and the UNDO primitive could never find the row. calendar_move mutates
 * that row; calendar_cancel soft-deletes it (its own soft-delete, distinct from the
 * UNDO primitive in apps/web/lib/actions/reverse-calendar.ts).
 */
async function calendarPlacement(
  input: ExecutorRunInput,
  deps: ExecutorDeps,
): Promise<ExecutionResult> {
  const actionType = input.approved.actionType;
  const payload = input.approved.payload as unknown as CalendarPlacementPayload;
  const executedAt = new Date().toISOString();

  if (actionType === 'calendar_cancel') {
    const result = await deps.cancelCalendarEvent({
      familyId: input.familyId,
      actionId: input.approved.id,
      reversalHandle: requirePayloadString(payload.reversalHandle, 'reversalHandle', actionType),
    });
    return {
      ok: true,
      executedAt,
      detail: { kind: 'calendar_cancelled', outcome: result.outcome, reversalHandle: result.familyEventId },
      reversible: false,
    };
  }

  const title = requirePayloadString(payload.title, 'title', actionType);
  const startsAt = parsePayloadInstant(payload.startsAt, 'startsAt', actionType);
  const endsAt = optionalPayloadInstant(payload.endsAt, 'endsAt', actionType);
  const location = typeof payload.location === 'string' ? payload.location : null;

  if (actionType === 'calendar_move') {
    const result = await deps.moveCalendarEvent({
      familyId: input.familyId,
      actionId: input.approved.id,
      reversalHandle: requirePayloadString(payload.reversalHandle, 'reversalHandle', actionType),
      title,
      startsAt,
      endsAt,
      location,
    });
    return {
      ok: true,
      executedAt,
      // A move is not cleanly reversible: undoing it means restoring the prior
      // time, which we don't persist. Only calendar_add is undoable (soft-delete).
      detail: { kind: 'calendar_moved', outcome: result.outcome, reversalHandle: result.familyEventId },
      reversible: false,
    };
  }

  const result = await deps.addToCalendar({
    familyId: input.familyId,
    actionId: input.approved.id,
    title,
    startsAt,
    endsAt,
    location,
    childId: typeof payload.childId === 'string' ? payload.childId : null,
    sensitive: payload.privacySensitive === true,
  });
  return {
    ok: true,
    executedAt,
    detail: { kind: 'calendar_placed', outcome: result.outcome, reversalHandle: result.familyEventId },
    reversible: true,
  };
}

function requirePayloadString(v: unknown, field: string, actionType: string): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`${actionType} payload missing required field (${field})`);
  }
  return v.trim();
}

function parsePayloadInstant(v: unknown, field: string, actionType: string): Date {
  const s = requirePayloadString(v, field, actionType);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`${actionType} payload has invalid ${field} instant: ${s}`);
  }
  return d;
}

function optionalPayloadInstant(v: unknown, field: string, actionType: string): Date | null {
  if (v === undefined || v === null || v === '') return null;
  return parsePayloadInstant(v, field, actionType);
}

// ─── Resend transport ─────────────────────────────────────────────────────

const DEFAULT_FROM = 'hello@villagehale.com';

export async function resendSend(payload: EmailPayload): Promise<SendResult> {
  if (!process.env.RESEND_API_KEY) {
    throw notConfigured('RESEND_API_KEY is not set; cannot send email.');
  }
  const from = payload.from ?? process.env.RESEND_FROM ?? DEFAULT_FROM;

  const resend = new Resend(process.env.RESEND_API_KEY);
  const { data, error } = await resend.emails.send({
    from,
    // `to` is required upstream (sendEmail validates the payload), so it is set.
    to: payload.to as string,
    cc: payload.cc,
    subject: payload.subject as string,
    text: payload.body as string,
  });

  if (error) {
    throw new Error(`Resend send failed (${error.name}): ${error.message}`);
  }
  return { messageId: data?.id };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function notConfigured(reason: string): Error {
  const err = new Error(`HALE_NOT_CONFIGURED: ${reason}`);
  err.name = 'HaleNotConfiguredError';
  return err;
}

// Silence unused-import warning until executor consumes worker config.
void config;
