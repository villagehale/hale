import { Resend } from 'resend';

const DEFAULT_FROM = 'hello@villagehale.com';

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
  /** Returns true iff the provider accepted the send. */
  sendDigest(to: string, subject: string, body: string): Promise<boolean>;
}

/** Plain, portable HTML wrapper for the agent's prose brief — inline styles only
 * (most portable across email clients), one paragraph per blank-line-separated
 * block so the agent's two short paragraphs render as paragraphs. */
function renderHtml(body: string): string {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map(
      (block) =>
        `<p style="margin:0 0 16px;color:#01204F;font-size:16px;line-height:1.6;">${escapeHtml(
          block,
        ).replace(/\n/g, '<br/>')}</p>`,
    )
    .join('');
  return `<div style="font-family:Inter,-apple-system,'Segoe UI',system-ui,Helvetica,Arial,sans-serif;background:#f6f1e7;padding:24px;">${paragraphs}</div>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function createDigestEmailSender(client?: Resend): DigestEmailSender {
  return {
    async sendDigest(to, subject, body) {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey && !client) {
        console.info('digest email skipped: RESEND_API_KEY not set');
        return false;
      }
      const resend = client ?? new Resend(apiKey);
      const from = process.env.RESEND_FROM ?? DEFAULT_FROM;
      const { error } = await resend.emails.send({
        from,
        to,
        subject,
        html: renderHtml(body),
        text: body,
      });
      if (error) {
        console.error('digest email send failed', error);
        return false;
      }
      return true;
    },
  };
}
