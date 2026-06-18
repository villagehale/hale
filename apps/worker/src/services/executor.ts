import { Resend } from 'resend';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { ApprovedAction, ExecutionResult } from '@hale/types';
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
export interface ExecutorDeps {
  /** Inserts the outbound_sends claim; false ⇒ already claimed ⇒ do NOT send. */
  claimOutboundSend: (actionId: string) => Promise<boolean>;
  /** Records sent_at + provider id after the provider confirms. */
  confirmOutboundSend: (actionId: string, providerMessageId: string) => Promise<void>;
  /** Audits a suppressed redelivery (action.send_skipped_duplicate). */
  recordSkippedDuplicate: (familyId: string, actionId: string) => Promise<void>;
  /** The actual email transport. */
  sendEmail: (payload: EmailPayload) => Promise<SendResult>;
}

function defaultDeps(): ExecutorDeps {
  return {
    claimOutboundSend: (actionId) => claimOutboundSendDb(actionId),
    confirmOutboundSend: (actionId, providerMessageId) =>
      confirmOutboundSendDb(actionId, providerMessageId),
    recordSkippedDuplicate: (familyId, actionId) =>
      recordSendSkippedDuplicate(familyId, actionId),
    sendEmail: resendSend,
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
      throw notConfigured('Google Calendar integration not wired (OAuth credentials required).');

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
      // No external dispatch — this action exists for state tracking only.
      return {
        ok: true,
        executedAt: new Date().toISOString(),
        detail: { kind: 'digest_only' },
        reversible: true,
      };
    }

    case 'add_to_routine': {
      // Internal routine pin — no external dispatch and NO calendar write
      // (that infra is not wired yet). State tracking only, like digest_only.
      return {
        ok: true,
        executedAt: new Date().toISOString(),
        detail: { kind: 'routine_pin' },
        reversible: true,
      };
    }

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
