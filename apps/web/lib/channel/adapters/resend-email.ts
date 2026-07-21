import { type ResendTransport, createResendTransport } from '../resend-transport';
import type { Channel } from '../types';

/**
 * The email leg of the channel seam (VIL-213 · A2). Wraps the shared Resend
 * transport: the transport owns the SDK client and normalizes {id, error}; this
 * adapter supplies the loop from-identity, resolves the recipient for an internal
 * user id, and maps the result into the seam's ChannelSendOutcome.
 *
 * The transport no-ops (returns {id:null,error:null}) when it has no api key — which
 * would read as a successful send with a null id. So the adapter gates on
 * RESEND_API_KEY BEFORE sending and reports a clean not_configured skip instead.
 *
 * Privacy (rule #1): the recipient address and the rendered body are never logged;
 * the transport already narrows a provider error to {name, message} before it reaches
 * the message we surface here.
 */

/** Mirrors DEFAULT_FROM in lib/cron/email.ts (the loop and the crons share one
 * from-identity). Kept local because this file is scope-locked to adapters/. */
export const RESEND_DEFAULT_FROM = 'aloha@villagehale.com';

export interface ResendEmailChannelDeps {
  /** Resolve an internal user id to their email (prod: users.email; tests: a fake). */
  resolveEmail(userId: string): Promise<string | null>;
  /** The shared transport; defaults to the real Resend client keyed by env. */
  transport?: ResendTransport;
  /** Whether Resend is configured; defaults to the presence of RESEND_API_KEY. */
  configured?: boolean;
}

export function createResendEmailChannel(deps: ResendEmailChannelDeps): Channel {
  const transport = deps.transport ?? createResendTransport({ apiKey: process.env.RESEND_API_KEY });
  return {
    kind: 'email',
    async send({ userId, rendered }) {
      if (rendered.kind !== 'email') {
        throw new Error(`resend email adapter received ${rendered.kind} content`);
      }

      if (!(deps.configured ?? Boolean(process.env.RESEND_API_KEY))) {
        return { status: 'skipped', reason: 'not_configured' };
      }

      const to = await deps.resolveEmail(userId);
      if (!to) {
        return { status: 'skipped', reason: 'no_address' };
      }

      const { id, error } = await transport.send({
        from: process.env.RESEND_FROM ?? RESEND_DEFAULT_FROM,
        to,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });

      if (error) {
        return { status: 'error', transient: true, code: 'resend', message: error.message };
      }
      return { status: 'sent', providerMessageId: id };
    },
  };
}
