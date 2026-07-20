import { Resend } from 'resend';
import { BUSINESS_ADDRESS, SENDER_NAME } from '~/lib/cron/email-compliance';

/**
 * The email-verification link, sent the moment an email+password account is
 * created. TRANSACTIONAL (not held behind any digest flag, no CASL unsubscribe —
 * it is a security confirmation the user just requested). The Resend client is
 * injected so the send is testable without a live account, mirroring the welcome
 * and digest senders.
 *
 * Privacy (rule #1): the recipient address is the only PII and rides in the
 * envelope; the verification token is in the link, never logged.
 */

const DEFAULT_FROM = 'Hale <aloha@villagehale.com>';
const VERIFY_SUBJECT = 'confirm your email for Hale';
const RESET_SUBJECT = 'reset your Hale password';
const MAGIC_SUBJECT = 'your sign-in link for Hale';

const PRUSSIAN = '#003153';
const LINEN = '#faf7f1';
const APRICOT = '#f97316';
const APRICOT_DEEP = '#c2410c';
const SLATE_GREEN = '#47587a';
const FADED_SAGE = '#5b6b86';
const FONT_STACK = "Inter,-apple-system,'Segoe UI',system-ui,Helvetica,Arial,sans-serif";

const LOGO_IMG = `<img src="https://app.villagehale.com/email-logo.png" width="60" height="60" alt="Hale" style="display:inline-block;border-radius:14px;border:0;outline:none;text-decoration:none;" />`;

type SendResult = { accepted: boolean; providerMessageId: string | null };

export interface VerificationEmailSender {
  /** Returns the provider message id when accepted, null when not sent. */
  sendVerification(to: string, verifyUrl: string): Promise<SendResult>;
  /** The reset-password link. Same envelope/PII posture — token in the URL only. */
  sendReset(to: string, resetUrl: string): Promise<SendResult>;
  /** The passwordless magic sign-in link. Same envelope/PII posture — token in the
   * URL only. Used for both sign-in and first-time sign-up. */
  sendMagicLink(to: string, magicUrl: string): Promise<SendResult>;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Copy for each transactional link, so the shared shell renders both without
// duplicating the layout. Only the heading, body lines, and CTA label differ.
interface EmailCopy {
  heading: string;
  cta: string;
  lead: string;
  expiry: string;
}

const VERIFY_COPY: EmailCopy = {
  heading: 'Confirm your email.',
  cta: 'Confirm email',
  lead: 'Welcome to Hale. Confirm your email to finish setting up your account.',
  expiry: "This link expires in 24 hours. If you didn't create a Hale account, you can ignore this email.",
};

const RESET_COPY: EmailCopy = {
  heading: 'Reset your password.',
  cta: 'Reset password',
  lead: 'We got a request to reset your Hale password. Choose a new one with the link below.',
  expiry:
    "This link expires in 1 hour. If you didn't ask to reset your password, you can ignore this email — your password won't change.",
};

const MAGIC_COPY: EmailCopy = {
  heading: 'Sign in to Hale.',
  cta: 'Sign in',
  lead: 'Use the link below to sign in to Hale. It works whether or not you already have an account.',
  expiry:
    "This link expires in 15 minutes and can be used once. If you didn't ask to sign in, you can ignore this email.",
};

function bodyText(url: string, copy: EmailCopy): string {
  return [copy.lead, url, copy.expiry, '— the team at Hale'].join('\n\n');
}

function renderHtml(url: string, copy: EmailCopy): string {
  const header = `<tr><td style="background:${PRUSSIAN};border-radius:18px;padding:36px 40px 28px;text-align:center;">${LOGO_IMG}<h1 style="margin:14px 0 0;color:${LINEN};font-size:26px;font-weight:700;letter-spacing:-0.02em;">${escapeHtml(
    copy.heading,
  )}</h1><p style="margin:10px 0 0;color:${APRICOT};font-size:15px;font-weight:600;">Hale — the village around your family.</p></td></tr>`;

  const button = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0;"><tr><td style="border-radius:12px;background:${APRICOT_DEEP};"><a href="${escapeHtml(
    url,
  )}" style="display:inline-block;padding:14px 28px;color:${LINEN};font-size:16px;font-weight:600;text-decoration:none;">${escapeHtml(
    copy.cta,
  )} &rarr;</a></td></tr></table>`;

  const para = (text: string) =>
    `<p style="margin:0 0 16px;color:${SLATE_GREEN};font-size:16px;line-height:1.65;">${escapeHtml(
      text,
    )}</p>`;

  const card = `<tr><td style="padding:28px 8px 0;">${para(copy.lead)}${button}${para(copy.expiry)}</td></tr>`;

  const footer = `<tr><td style="padding:28px 8px 0;"><hr style="border:none;border-top:1px solid rgba(0,49,83,0.12);margin:0 0 14px;"/><p style="margin:0;color:${FADED_SAGE};font-size:12px;line-height:1.6;">Sent by ${escapeHtml(
    SENDER_NAME,
  )} · ${escapeHtml(BUSINESS_ADDRESS)}</p></td></tr>`;

  return `<div style="margin:0;background:${LINEN};font-family:${FONT_STACK};padding:24px 0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto;">${header}${card}${footer}</table></div>`;
}

export function createVerificationEmailSender(client?: Resend): VerificationEmailSender {
  async function send(to: string, url: string, subject: string, copy: EmailCopy): Promise<SendResult> {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey && !client) {
      console.info('auth email skipped: RESEND_API_KEY not set');
      return { accepted: false, providerMessageId: null };
    }
    const resend = client ?? new Resend(apiKey);
    const from = process.env.WELCOME_FROM ?? DEFAULT_FROM;
    const { data, error } = await resend.emails.send({
      from,
      to,
      subject,
      html: renderHtml(url, copy),
      text: bodyText(url, copy),
    });
    if (error) {
      // Log only name/message — the Resend error object can carry the recipient
      // address, and PII must not land in logs (rule #1).
      console.error('auth email send failed', { name: error.name, message: error.message });
      return { accepted: false, providerMessageId: null };
    }
    return { accepted: true, providerMessageId: data?.id ?? null };
  }

  return {
    sendVerification: (to, verifyUrl) => send(to, verifyUrl, VERIFY_SUBJECT, VERIFY_COPY),
    sendReset: (to, resetUrl) => send(to, resetUrl, RESET_SUBJECT, RESET_COPY),
    sendMagicLink: (to, magicUrl) => send(to, magicUrl, MAGIC_SUBJECT, MAGIC_COPY),
  };
}
