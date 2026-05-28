import { config } from '../config.js';
import { logger } from '../logger.js';
import type { ApprovedAction, ExecutionResult } from '@haru/types';

interface ExecutorRunInput {
  familyId: string;
  approved: ApprovedAction & { agentRunId: string };
}

/**
 * Executor — dispatches approved actions to real-world tools.
 *
 * Email send is implemented via Postmark REST. Other action types
 * require integrations (Google Calendar OAuth, Stripe + merchant
 * adapters, Computer Use for portal automation) that the worker
 * doesn't yet have credentials for. Those throw a clear
 * `HARU_NOT_CONFIGURED` error so the system fails LOUD rather than
 * pretending to succeed — which would silently degrade the
 * autonomous-trust promise.
 */
export async function runExecutor(input: ExecutorRunInput): Promise<ExecutionResult> {
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
      return sendEmail(input);

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

    default: {
      const exhaustive: never = input.approved.actionType;
      throw new Error(`unhandled action_type in Executor: ${String(exhaustive)}`);
    }
  }
}

// ─── send_email via Postmark ────────────────────────────────────────────

interface EmailPayload {
  to?: string;
  from?: string;
  subject?: string;
  body?: string;
  cc?: string[];
  reply_to_message_id?: string;
}

async function sendEmail(input: ExecutorRunInput): Promise<ExecutionResult> {
  if (!process.env.POSTMARK_API_KEY) {
    throw notConfigured('POSTMARK_API_KEY is not set; cannot send email.');
  }
  const from = process.env.POSTMARK_FROM_ADDRESS;
  if (!from) {
    throw notConfigured('POSTMARK_FROM_ADDRESS is not set.');
  }

  const payload = input.approved.payload as EmailPayload;
  if (!payload.to || !payload.subject || !payload.body) {
    throw new Error('send_email payload missing required fields (to, subject, body)');
  }

  const response = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': process.env.POSTMARK_API_KEY,
    },
    body: JSON.stringify({
      From: from,
      To: payload.to,
      Cc: payload.cc?.join(', '),
      Subject: payload.subject,
      TextBody: payload.body,
      MessageStream: 'outbound',
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Postmark send failed (${response.status}): ${detail}`);
  }

  const result = (await response.json()) as { MessageID?: string; SubmittedAt?: string };
  return {
    ok: true,
    executedAt: new Date().toISOString(),
    detail: {
      kind: 'email_sent',
      messageId: result.MessageID,
      submittedAt: result.SubmittedAt,
      recipient: payload.to,
    },
    reversible: false,
    reversalHandle: result.MessageID,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function notConfigured(reason: string): Error {
  const err = new Error(`HARU_NOT_CONFIGURED: ${reason}`);
  err.name = 'HaruNotConfiguredError';
  return err;
}

// Silence unused-import warning until executor consumes worker config.
void config;
