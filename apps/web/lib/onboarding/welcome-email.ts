import { Resend } from 'resend';
import { BUSINESS_ADDRESS, SENDER_NAME } from '~/lib/cron/email-compliance';

/**
 * The one-time welcome email, sent when a family finishes onboarding. Unlike the
 * daily brief this is TRANSACTIONAL — it is not held behind DIGEST_SEND_ENABLED,
 * and it comes from the warm aloha@ identity rather than the digest sender. The
 * Resend client is injected so the send is testable without a live account.
 *
 * Privacy (rule #1): the recipient address and the parent's first name are the
 * only PII; both ride in the message, never the logs.
 */

// The welcome's warm from-identity. Distinct from the digest/executor RESEND_FROM
// (hello@) on purpose; overridable for non-prod sending domains.
const DEFAULT_FROM = 'Hale <aloha@villagehale.com>';

const APP_BASE = 'https://app.villagehale.com';
const SUBJECT = 'welcome to your village';

/** The product surfaces the three next steps point at. */
const LINKS = {
  home: `${APP_BASE}/home`,
  village: `${APP_BASE}/village`,
  family: `${APP_BASE}/family`,
} as const;

export interface WelcomeEmailSender {
  /** Returns the provider message id when accepted, null when not sent. The
   * unsubscribe URL is rendered into the CASL footer alongside the business
   * mailing address + sender identity. */
  sendWelcome(
    to: string,
    firstName: string | null,
    unsubscribeUrl: string,
  ): Promise<{ accepted: boolean; providerMessageId: string | null }>;
}

function greeting(firstName: string | null): string {
  return firstName ? `Hi ${firstName},` : 'Hi,';
}

/** The founder-voice body, plain and conversational, sentence case. One line on
 * the village concept, then the three concrete next steps. */
function bodyText(firstName: string | null): string {
  return [
    greeting(firstName),
    "I'm so glad you're here. Hale is the village around your family — the people, places, and quiet help that make raising kids a little lighter.",
    "Here's where to start:",
    `1. See what your village recommends: ${LINKS.village}`,
    `2. Add your first activity to your week: ${LINKS.home}`,
    `3. Invite a parent you trust: ${LINKS.family}`,
    'Reply any time — a real person reads these.',
    '— the team at Hale',
  ].join('\n\n');
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The body as portable inline-styled HTML, with the three steps as real links.
 * The CASL footer (sender identity, mailing address, working unsubscribe) is
 * appended to every message. */
function renderHtml(firstName: string | null, unsubscribeUrl: string): string {
  const para = (text: string) =>
    `<p style="margin:0 0 16px;color:#01204F;font-size:16px;line-height:1.6;">${text}</p>`;
  const link = (href: string, label: string) =>
    `<a href="${escapeHtml(href)}" style="color:#01204F;">${escapeHtml(label)}</a>`;

  const intro = [
    para(escapeHtml(greeting(firstName))),
    para(
      escapeHtml(
        "I'm so glad you're here. Hale is the village around your family — the people, places, and quiet help that make raising kids a little lighter.",
      ),
    ),
    para(escapeHtml("Here's where to start:")),
  ].join('');

  const stepItems = [
    `<li>See what your village recommends — ${link(LINKS.village, 'open your village')}</li>`,
    `<li>Add your first activity to your week — ${link(LINKS.home, 'open your home')}</li>`,
    `<li>Invite a parent you trust — ${link(LINKS.family, 'invite a co-parent')}</li>`,
  ].join('');
  const steps = `<ol style="margin:0 0 16px;padding-left:20px;color:#01204F;font-size:16px;line-height:1.6;">${stepItems}</ol>`;

  const outro = [
    para(escapeHtml('Reply any time — a real person reads these.')),
    para(escapeHtml('— the team at Hale')),
  ].join('');

  const footer = `<hr style="border:none;border-top:1px solid #d8cfbe;margin:24px 0 12px;"/><p style="margin:0;color:#6b6357;font-size:12px;line-height:1.5;">Sent by ${escapeHtml(
    SENDER_NAME,
  )} · ${escapeHtml(
    BUSINESS_ADDRESS,
  )}<br/>You're receiving this because you created a Hale account. <a href="${escapeHtml(
    unsubscribeUrl,
  )}" style="color:#6b6357;">Unsubscribe</a>.</p>`;

  return `<div style="font-family:Inter,-apple-system,'Segoe UI',system-ui,Helvetica,Arial,sans-serif;background:#f6f1e7;padding:24px;">${intro}${steps}${outro}${footer}</div>`;
}

/** Plain-text CASL footer, for the text/plain part. */
function renderTextFooter(unsubscribeUrl: string): string {
  return `\n\n—\nSent by ${SENDER_NAME} · ${BUSINESS_ADDRESS}\nUnsubscribe: ${unsubscribeUrl}`;
}

export function createWelcomeEmailSender(client?: Resend): WelcomeEmailSender {
  return {
    async sendWelcome(to, firstName, unsubscribeUrl) {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey && !client) {
        console.info('welcome email skipped: RESEND_API_KEY not set');
        return { accepted: false, providerMessageId: null };
      }
      const resend = client ?? new Resend(apiKey);
      const from = process.env.WELCOME_FROM ?? DEFAULT_FROM;
      const { data, error } = await resend.emails.send({
        from,
        to,
        subject: SUBJECT,
        html: renderHtml(firstName, unsubscribeUrl),
        text: bodyText(firstName) + renderTextFooter(unsubscribeUrl),
      });
      if (error) {
        console.error('welcome email send failed', error);
        return { accepted: false, providerMessageId: null };
      }
      return { accepted: true, providerMessageId: data?.id ?? null };
    },
  };
}
