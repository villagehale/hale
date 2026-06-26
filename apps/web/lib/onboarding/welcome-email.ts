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

/* Brand palette, mirroring apps/site's design system (globals.css) and the
 * waitlist email: Spruce/Prussian #01204F ink + night band, Linen #f6f1e7
 * canvas, Apricot #c8622d as the warm large-graphic/fill accent, Apricot-deep
 * #a84e20 as the text-safe accent (used for the step labels), Slate-green body
 * text, Faded-sage footer meta. Inline styles only — most portable for email. */
const PRUSSIAN = '#01204F';
const LINEN = '#f6f1e7';
const APRICOT = '#c8622d';
const APRICOT_DEEP = '#a84e20';
const SLATE_GREEN = '#33486b';
const FADED_SAGE = '#5b6b86';
const FONT_STACK =
  "Inter,-apple-system,'Segoe UI',system-ui,Helvetica,Arial,sans-serif";

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

/** The Hale logo as a HOSTED PNG (served from apps/web/public). Inline SVG is
 * stripped by Gmail/Outlook, so email clients rendered a logo-less header — a real
 * <img> at an absolute URL renders everywhere. The turtle icon tile sits on the
 * Prussian header band. */
const LOGO_IMG = `<img src="https://app.villagehale.com/email-logo.png" width="60" height="60" alt="Hale" style="display:inline-block;border-radius:14px;border:0;outline:none;text-decoration:none;" />`;

/** The body as portable inline-styled HTML, matching the waitlist email's
 * design language: a Prussian header band with the turtle wordmark, a warm
 * linen card, and the three next steps as numbered, branded link rows. The CASL
 * footer (sender identity, mailing address, working unsubscribe) closes every
 * message. */
function renderHtml(firstName: string | null, unsubscribeUrl: string): string {
  const para = (text: string) =>
    `<p style="margin:0 0 16px;color:${SLATE_GREEN};font-size:16px;line-height:1.65;">${text}</p>`;

  const intro = [
    para(escapeHtml(greeting(firstName))),
    para(
      escapeHtml(
        "I'm so glad you're here. Hale is the village around your family — the people, places, and quiet help that make raising kids a little lighter.",
      ),
    ),
  ].join('');

  const step = (n: number, href: string, lead: string, label: string) =>
    `<tr><td style="padding:0 0 12px;"><a href="${escapeHtml(
      href,
    )}" style="display:block;text-decoration:none;background:${LINEN};border:1px solid rgba(1,32,79,0.10);border-radius:12px;padding:14px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td width="34" valign="top" style="color:${APRICOT_DEEP};font-size:18px;font-weight:700;line-height:1.4;">${n}</td><td style="color:${PRUSSIAN};font-size:16px;line-height:1.4;"><span style="font-weight:600;">${escapeHtml(
      lead,
    )}</span><br/><span style="color:${APRICOT_DEEP};font-size:14px;font-weight:600;">${escapeHtml(
      label,
    )} &rarr;</span></td></tr></table></a></td></tr>`;

  const steps = `<p style="margin:0 0 14px;color:${PRUSSIAN};font-size:15px;font-weight:600;letter-spacing:-0.01em;">Here's where to start</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${step(
    1,
    LINKS.village,
    'See what your village recommends',
    'open your village',
  )}${step(
    2,
    LINKS.home,
    'Add your first activity to your week',
    'open your home',
  )}${step(3, LINKS.family, 'Invite a parent you trust', 'invite a co-parent')}</table>`;

  const outro = [
    `<p style="margin:24px 0 0;color:${SLATE_GREEN};font-size:16px;line-height:1.65;">${escapeHtml(
      'Reply any time — a real person reads these.',
    )}</p>`,
    `<p style="margin:8px 0 0;color:${SLATE_GREEN};font-size:16px;line-height:1.65;">${escapeHtml(
      '— the team at Hale',
    )}</p>`,
  ].join('');

  const header = `<tr><td style="background:${PRUSSIAN};border-radius:18px;padding:36px 40px 28px;text-align:center;">${LOGO_IMG}<h1 style="margin:14px 0 0;color:${LINEN};font-size:26px;font-weight:700;letter-spacing:-0.02em;">Welcome to your village.</h1><p style="margin:10px 0 0;color:${APRICOT};font-size:15px;font-weight:600;">Hale — the village around your family.</p></td></tr>`;

  const card = `<tr><td style="padding:28px 8px 0;">${intro}${steps}${outro}</td></tr>`;

  const footer = `<tr><td style="padding:28px 8px 0;"><hr style="border:none;border-top:1px solid rgba(1,32,79,0.12);margin:0 0 14px;"/><p style="margin:0;color:${FADED_SAGE};font-size:12px;line-height:1.6;">Sent by ${escapeHtml(
    SENDER_NAME,
  )} · ${escapeHtml(
    BUSINESS_ADDRESS,
  )}<br/>You're receiving this because you created a Hale account. <a href="${escapeHtml(
    unsubscribeUrl,
  )}" style="color:${FADED_SAGE};">Unsubscribe</a>.</p></td></tr>`;

  return `<div style="margin:0;background:${LINEN};font-family:${FONT_STACK};padding:24px 0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto;">${header}${card}${footer}</table></div>`;
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
