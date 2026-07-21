import type { FamilyStage } from '@hale/types';
import type { Resend } from 'resend';
import { createResendTransport } from '~/lib/channel/resend-transport';
import { BUSINESS_ADDRESS, SENDER_NAME, appBaseUrl } from '~/lib/cron/email-compliance';

/**
 * The one-time welcome email, sent when a family finishes onboarding. Unlike the
 * daily brief this is TRANSACTIONAL — it is not held behind DIGEST_SEND_ENABLED,
 * and it comes from the warm aloha@ identity rather than the digest sender. The
 * Resend client is injected so the send is testable without a live account.
 *
 * Privacy (rule #1): the recipient address and the parent's first name are the
 * only PII in the message; both ride in the send, never the logs. The family copy
 * is deliberately coarse — a stage word derived from a DOB and a neighbourhood /
 * city phrase — never a child name or a date of birth, because an email can be
 * forwarded outside the household.
 */

// The welcome's warm from-identity. Distinct from the digest/executor RESEND_FROM
// (aloha@) on purpose; overridable for non-prod sending domains.
const DEFAULT_FROM = 'Hale <aloha@villagehale.com>';

// Same env source as the unsubscribe link in this very email (APP_URL ?? prod):
// a staging send must not mix staging unsubscribe with prod body links.
const APP_BASE = appBaseUrl();
const SUBJECT = 'welcome to your village';

/** The product surfaces the three next steps point at. */
const LINKS = {
  home: `${APP_BASE}/home`,
  village: `${APP_BASE}/village`,
  family: `${APP_BASE}/family`,
} as const;

/* Design-system palette (apps/site globals.css): deep Prussian #003153 header
 * panel + body ink, warm-white #FAF7F1 page canvas, a white content card with a
 * subtle #E7E2DA border, Apricot-deep #C2410C the text-safe accent (links + CTA
 * fill — white-on passes AA), Apricot #F97316 fill-only for large graphics (never
 * small text), a muted light-blue #C7D3E6 tagline on the Prussian panel, and a
 * slate-blue #47587A secondary body ink. Inline styles only — most portable for
 * email clients. */
const PRUSSIAN = '#003153';
const CANVAS = '#FAF7F1';
const CARD = '#ffffff';
const CARD_BORDER = '#E7E2DA';
const LINK = '#C2410C';
const TAGLINE_BLUE = '#C7D3E6';
const SLATE = '#47587A';
const FADED_SAGE = '#5b6b86';
const FONT_STACK = "Inter,-apple-system,'Segoe UI',system-ui,Helvetica,Arial,sans-serif";

/** The personalized, non-PII content of a welcome. `firstName` is already the
 * greeting-ready token ('Barton' or 'there'); `place` and `stage` are pre-derived
 * coarse phrases (or null), never a child name or DOB. */
export interface WelcomeContent {
  /** Greeting-ready first token: a real first name, or 'there' when unknown. */
  firstName: string;
  /** Coarse place phrase: 'your neighbourhood' (FSA) or 'around {city}', or null. */
  place: string | null;
  /** Warm stage phrase derived from the children's ages, or null. */
  stage: string | null;
}

export interface WelcomeEmailSender {
  /** Returns the provider message id when accepted, null when not sent. The
   * unsubscribe URL is rendered into the CASL footer alongside the business
   * mailing address + sender identity. */
  sendWelcome(
    to: string,
    content: WelcomeContent,
    unsubscribeUrl: string,
  ): Promise<{ accepted: boolean; providerMessageId: string | null }>;
}

/** A postal code's Forward Sortation Area (the first three chars: letter-digit-
 * letter). areaCoarse already holds only the FSA, but a legacy row may carry a
 * full postal code, so we test the FSA prefix rather than exact length. */
function isFsa(value: string): boolean {
  return /^[A-Za-z]\d[A-Za-z]/.test(value.trim());
}

/** Greeting-ready first token: the first whitespace-delimited name part, or
 * 'there' when no name is known — NEVER a bare 'Hi,'. */
export function firstNameToken(name: string | null): string {
  const first = name?.trim().split(/\s+/)[0];
  return first ? first : 'there';
}

/** A coarse place phrase for the body, or null. An FSA-shaped area reads as
 * 'your neighbourhood' (rule #1 — never the precise code); otherwise a city name
 * reads as 'around {city}'. */
export function placePhrase(area: string | null, city: string | null): string | null {
  if (area && isFsa(area)) return 'your neighbourhood';
  const trimmedCity = city?.trim();
  if (trimmedCity) return `around ${trimmedCity}`;
  return null;
}

/** The warm words for each single stage (never a name or DOB). */
const STAGE_WORDS: Record<FamilyStage, string> = {
  newborn: 'those first months with your little one',
  toddler: 'the toddler years',
  child: 'these growing years',
  teenager: 'the teenage years',
};

/** A warm phrase for the household's season of parenting, derived from the set of
 * children's stages (never a name or DOB). Multiple stages read as the general
 * 'raising your kids'; a single stage gets its own warm words. */
export function stagePhrase(stages: readonly FamilyStage[]): string | null {
  const unique = new Set(stages);
  if (unique.size === 0) return null;
  if (unique.size > 1) return 'raising your kids';
  const [stage] = unique;
  return stage ? STAGE_WORDS[stage] : null;
}

function greeting(firstName: string): string {
  return `Hi ${firstName},`;
}

/** The one warm line about the village, tailored to the family's place + stage
 * from real data only (rule #1 — coarse, forward-safe). Both slots are optional;
 * the sentence reads naturally with either, both, or neither. A place phrase
 * either already carries a preposition ('around Toronto') or is bare
 * ('your neighbourhood'), which takes an 'in'; when a place is present the base
 * clause drops its own 'around' so the two don't collide. */
function villageLine(content: WelcomeContent): string {
  const { place, stage } = content;
  const tail = stage
    ? ` — the people, places, and quiet help that make ${stage} a little lighter`
    : ' — the people, places, and quiet help that make raising kids a little lighter';
  const base = place
    ? `Hale is the village for your family, ${place.startsWith('around ') ? place : `in ${place}`}`
    : 'Hale is the village around your family';
  return `I'm so glad you're here. ${base}${tail}.`;
}

function bodyText(content: WelcomeContent): string {
  return [
    greeting(content.firstName),
    villageLine(content),
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
 * <img> at an absolute URL renders everywhere. The turtle mark tile sits on the
 * Prussian header panel. */
const LOGO_IMG = `<img src="https://app.villagehale.com/email-logo.png" width="60" height="60" alt="Hale" style="display:inline-block;border-radius:14px;border:0;outline:none;text-decoration:none;" />`;

/** The body as portable inline-styled HTML in the Hale design system: a deep
 * Prussian header panel with the turtle mark, a white content card on a warm-white
 * canvas, an Apricot-deep filled CTA, and the three next steps as branded link rows.
 * The CASL footer (sender identity, mailing address, working unsubscribe) closes
 * every message. */
function renderHtml(content: WelcomeContent, unsubscribeUrl: string): string {
  const para = (text: string) =>
    `<p style="margin:0 0 16px;color:${SLATE};font-size:16px;line-height:1.65;">${text}</p>`;

  const intro = [para(escapeHtml(greeting(content.firstName))), para(escapeHtml(villageLine(content)))].join('');

  const cta = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;"><tr><td style="border-radius:12px;background:${LINK};"><a href="${escapeHtml(
    LINKS.village,
  )}" style="display:inline-block;padding:14px 28px;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;border-radius:12px;">Open your village</a></td></tr></table>`;

  const step = (n: number, href: string, lead: string, label: string) =>
    `<tr><td style="padding:0 0 12px;"><a href="${escapeHtml(
      href,
    )}" style="display:block;text-decoration:none;background:${CANVAS};border:1px solid ${CARD_BORDER};border-radius:12px;padding:14px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td width="34" valign="top" style="color:${LINK};font-size:18px;font-weight:700;line-height:1.4;">${n}</td><td style="color:${PRUSSIAN};font-size:16px;line-height:1.4;"><span style="font-weight:600;">${escapeHtml(
      lead,
    )}</span><br/><span style="color:${LINK};font-size:14px;font-weight:600;">${escapeHtml(
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
    `<p style="margin:24px 0 0;color:${SLATE};font-size:16px;line-height:1.65;">${escapeHtml(
      "You're one of Hale's founding families — everything's free while we grow, and when paid plans open you'll be first in line.",
    )}</p>`,
    `<p style="margin:8px 0 0;color:${SLATE};font-size:16px;line-height:1.65;">${escapeHtml(
      'Reply any time — a real person reads these.',
    )}</p>`,
    `<p style="margin:8px 0 0;color:${SLATE};font-size:16px;line-height:1.65;">${escapeHtml(
      '— the team at Hale',
    )}</p>`,
  ].join('');

  const header = `<tr><td style="background:${PRUSSIAN};border-radius:18px 18px 0 0;padding:36px 40px 28px;text-align:center;">${LOGO_IMG}<h1 style="margin:14px 0 0;color:#ffffff;font-size:26px;font-weight:700;letter-spacing:-0.02em;">Welcome to your village.</h1><p style="margin:10px 0 0;color:${TAGLINE_BLUE};font-size:15px;font-weight:600;">Hale — the village around your family.</p></td></tr>`;

  const card = `<tr><td style="background:${CARD};border:1px solid ${CARD_BORDER};border-top:none;border-radius:0 0 24px 24px;padding:32px 32px 8px;">${intro}${cta}${steps}${outro}</td></tr>`;

  const footer = `<tr><td style="padding:24px 8px 0;"><p style="margin:0;color:${FADED_SAGE};font-size:12px;line-height:1.6;">Sent by ${escapeHtml(
    SENDER_NAME,
  )} · ${escapeHtml(
    BUSINESS_ADDRESS,
  )}<br/>You're receiving this because you created a Hale account. <a href="${escapeHtml(
    unsubscribeUrl,
  )}" style="color:${FADED_SAGE};">Unsubscribe</a>.</p></td></tr>`;

  return `<div style="margin:0;background:${CANVAS};font-family:${FONT_STACK};padding:24px 0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto;">${header}${card}${footer}</table></div>`;
}

/** Plain-text CASL footer, for the text/plain part. */
function renderTextFooter(unsubscribeUrl: string): string {
  return `\n\n—\nSent by ${SENDER_NAME} · ${BUSINESS_ADDRESS}\nUnsubscribe: ${unsubscribeUrl}`;
}

export function createWelcomeEmailSender(client?: Resend): WelcomeEmailSender {
  return {
    async sendWelcome(to, content, unsubscribeUrl) {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey && !client) {
        console.info('welcome email skipped: RESEND_API_KEY not set');
        return { accepted: false, providerMessageId: null };
      }
      const transport = createResendTransport({ apiKey, client });
      const from = process.env.WELCOME_FROM ?? DEFAULT_FROM;
      // Optional founder copy of each welcome (new-signup signal); set WELCOME_BCC in prod.
      const bcc = process.env.WELCOME_BCC;
      const { id, error } = await transport.send({
        from,
        to,
        ...(bcc ? { bcc } : {}),
        subject: SUBJECT,
        html: renderHtml(content, unsubscribeUrl),
        text: bodyText(content) + renderTextFooter(unsubscribeUrl),
      });
      if (error) {
        console.error('welcome email send failed', error);
        return { accepted: false, providerMessageId: null };
      }
      return { accepted: true, providerMessageId: id ?? null };
    },
  };
}
