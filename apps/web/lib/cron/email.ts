import type { Resend } from 'resend';
import { createResendTransport } from '~/lib/channel/resend-transport';
import { BUSINESS_ADDRESS, SENDER_NAME } from './email-compliance';

const DEFAULT_FROM = 'aloha@villagehale.com';

/**
 * The minimal email surface the digest cron needs: send one brief and report
 * whether the provider accepted it. Injected so the digest run is testable
 * without a live Resend account, mirroring apps/site's createEmailSender.
 *
 * Privacy (rule #1): the recipient address is the only PII, and it rides in the
 * envelope, never logged. The brief body is already a scoped, parent-facing slice
 * (no raw teen content) composed by the daily-brief agent.
 */
export interface DigestEmailSender {
  /** Returns the provider message id when accepted, null when not sent. The
   * unsubscribe URL is required by CASL — the footer always carries a working
   * one-click unsubscribe + the business mailing address + sender identity. */
  sendDigest(
    to: string,
    subject: string,
    body: string,
    unsubscribeUrl: string,
  ): Promise<{ accepted: boolean; providerMessageId: string | null }>;
}

/** Plain, portable HTML wrapper for the agent's prose brief — inline styles only
 * (most portable across email clients), one paragraph per blank-line-separated
 * block so the agent's two short paragraphs render as paragraphs. The CASL footer
 * (sender identity, mailing address, working unsubscribe) is appended to every
 * message. */
function renderHtml(body: string, unsubscribeUrl: string): string {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map(
      (block) =>
        `<p style="margin:0 0 16px;color:#003153;font-size:16px;line-height:1.6;">${escapeHtml(
          block,
        ).replace(/\n/g, '<br/>')}</p>`,
    )
    .join('');
  const footer = `<hr style="border:none;border-top:1px solid #d8cfbe;margin:24px 0 12px;"/><p style="margin:0;color:#6b6357;font-size:12px;line-height:1.5;">Sent by ${escapeHtml(
    SENDER_NAME,
  )} · ${escapeHtml(
    BUSINESS_ADDRESS,
  )}<br/>You're receiving this because you have a Hale account. <a href="${escapeHtml(
    unsubscribeUrl,
  )}" style="color:#6b6357;">Unsubscribe from daily briefs</a>.</p>`;
  return `<div style="font-family:Inter,-apple-system,'Segoe UI',system-ui,Helvetica,Arial,sans-serif;background:#faf7f1;padding:24px;">${paragraphs}${footer}</div>`;
}

/** Plain-text counterpart of the CASL footer, for the text/plain part. */
function renderTextFooter(unsubscribeUrl: string): string {
  return `\n\n—\nSent by ${SENDER_NAME} · ${BUSINESS_ADDRESS}\nUnsubscribe from daily briefs: ${unsubscribeUrl}`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function createDigestEmailSender(client?: Resend): DigestEmailSender {
  return {
    async sendDigest(to, subject, body, unsubscribeUrl) {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey && !client) {
        console.info('digest email skipped: RESEND_API_KEY not set');
        return { accepted: false, providerMessageId: null };
      }
      const transport = createResendTransport({ apiKey, client });
      const from = process.env.RESEND_FROM ?? DEFAULT_FROM;
      const { id, error } = await transport.send({
        from,
        to,
        subject,
        html: renderHtml(body, unsubscribeUrl),
        text: body + renderTextFooter(unsubscribeUrl),
      });
      if (error) {
        console.error('digest email send failed', error);
        return { accepted: false, providerMessageId: null };
      }
      return { accepted: true, providerMessageId: id ?? null };
    },
  };
}
