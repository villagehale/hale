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
const SUBJECT = 'confirm your email for Hale';

const PRUSSIAN = '#01204F';
const LINEN = '#f6f1e7';
const APRICOT = '#c8622d';
const APRICOT_DEEP = '#a84e20';
const SLATE_GREEN = '#33486b';
const FADED_SAGE = '#5b6b86';
const FONT_STACK = "Inter,-apple-system,'Segoe UI',system-ui,Helvetica,Arial,sans-serif";

const LOGO_IMG = `<img src="https://app.villagehale.com/email-logo.png" width="60" height="60" alt="Hale" style="display:inline-block;border-radius:14px;border:0;outline:none;text-decoration:none;" />`;

export interface VerificationEmailSender {
  /** Returns the provider message id when accepted, null when not sent. */
  sendVerification(
    to: string,
    verifyUrl: string,
  ): Promise<{ accepted: boolean; providerMessageId: string | null }>;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function bodyText(verifyUrl: string): string {
  return [
    'Welcome to Hale.',
    'Confirm your email to finish setting up your account:',
    verifyUrl,
    "This link expires in 24 hours. If you didn't create a Hale account, you can ignore this email.",
    '— the team at Hale',
  ].join('\n\n');
}

function renderHtml(verifyUrl: string): string {
  const header = `<tr><td style="background:${PRUSSIAN};border-radius:18px;padding:36px 40px 28px;text-align:center;">${LOGO_IMG}<h1 style="margin:14px 0 0;color:${LINEN};font-size:26px;font-weight:700;letter-spacing:-0.02em;">Confirm your email.</h1><p style="margin:10px 0 0;color:${APRICOT};font-size:15px;font-weight:600;">Hale — the village around your family.</p></td></tr>`;

  const button = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0;"><tr><td style="border-radius:12px;background:${APRICOT_DEEP};"><a href="${escapeHtml(
    verifyUrl,
  )}" style="display:inline-block;padding:14px 28px;color:${LINEN};font-size:16px;font-weight:600;text-decoration:none;">Confirm email &rarr;</a></td></tr></table>`;

  const para = (text: string) =>
    `<p style="margin:0 0 16px;color:${SLATE_GREEN};font-size:16px;line-height:1.65;">${escapeHtml(
      text,
    )}</p>`;

  const card = `<tr><td style="padding:28px 8px 0;">${para(
    "Welcome to Hale. Confirm your email to finish setting up your account.",
  )}${button}${para(
    "This link expires in 24 hours. If you didn't create a Hale account, you can ignore this email.",
  )}</td></tr>`;

  const footer = `<tr><td style="padding:28px 8px 0;"><hr style="border:none;border-top:1px solid rgba(1,32,79,0.12);margin:0 0 14px;"/><p style="margin:0;color:${FADED_SAGE};font-size:12px;line-height:1.6;">Sent by ${escapeHtml(
    SENDER_NAME,
  )} · ${escapeHtml(BUSINESS_ADDRESS)}</p></td></tr>`;

  return `<div style="margin:0;background:${LINEN};font-family:${FONT_STACK};padding:24px 0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto;">${header}${card}${footer}</table></div>`;
}

export function createVerificationEmailSender(client?: Resend): VerificationEmailSender {
  return {
    async sendVerification(to, verifyUrl) {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey && !client) {
        console.info('verification email skipped: RESEND_API_KEY not set');
        return { accepted: false, providerMessageId: null };
      }
      const resend = client ?? new Resend(apiKey);
      const from = process.env.WELCOME_FROM ?? DEFAULT_FROM;
      const { data, error } = await resend.emails.send({
        from,
        to,
        subject: SUBJECT,
        html: renderHtml(verifyUrl),
        text: bodyText(verifyUrl),
      });
      if (error) {
        console.error('verification email send failed', error);
        return { accepted: false, providerMessageId: null };
      }
      return { accepted: true, providerMessageId: data?.id ?? null };
    },
  };
}
