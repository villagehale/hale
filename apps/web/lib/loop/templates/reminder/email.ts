import type { RenderedContent } from '~/lib/channel/types';
import { BUSINESS_ADDRESS, SENDER_NAME } from '~/lib/cron/email-compliance';
import type { ChildNameLevel } from '~/lib/loop/prefs';
import { eventDescriptor, eventLine, localTimeLabel, whenLead } from './core';
import type { ReminderPayload } from './payload';

/**
 * VIL-223 · D1 — the reminder email renderer. Compact by design: not the Sunday
 * spread, just a navy header carrying the lead as a serif headline, a white card that
 * lists the offset's event lines (the time bold), and — on the T-24h batch only — a
 * single amber-fill "Open your week" button. Same site palette as weekly-plan/email
 * (#300/#312 tokens): navy ink + links, warm cream page, restrained amber as FILL only.
 * Privacy (rule #1) is already enforced by eventDescriptor (teen/sensitive → generic);
 * every interpolated value is still escaped (injection). CASL footer + working
 * unsubscribe close every message, fail-closed when the URL is missing.
 */

const NAVY = '#17294a'; // primary ink / header panel / links
const PAGE = '#f7f5f0'; // warm cream page canvas
const CARD = '#ffffff';
const CARD_BORDER = '#e4e7ee';
const AMBER = '#b26b1f'; // restrained amber — FILL only (the button)
const CREAM = '#f7f4ec'; // headline on navy
const SLATE = '#5c6b87'; // footer / meta
const SERIF = "Georgia,'Times New Roman',serif";
const SANS = "Inter,-apple-system,'Segoe UI',system-ui,Helvetica,Arial,sans-serif";

const EM_DASH = '—';
const MIDDLE_DOT = '·';
const OPEN_WEEK = 'Open your week';

// The Hale mark as a hosted PNG (inline SVG is stripped by Gmail/Outlook) — the same
// asset the weekly-plan + welcome emails use, on the navy header panel.
const LOGO_IMG =
  '<img src="https://app.villagehale.com/email-logo.png" width="56" height="56" alt="Hale" style="display:inline-block;border-radius:14px;border:0;outline:none;text-decoration:none;" />';

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** One event as a card row: the privacy-safe descriptor, the family-local time bold. */
function eventRow(
  event: ReminderPayload['events'][number],
  children: ReminderPayload['children'],
  level: ChildNameLevel,
  now: Date,
  timeZone: string,
): string {
  const descriptor = escapeHtml(eventDescriptor(event, children, level, now));
  const time = escapeHtml(localTimeLabel(event.startsAt, timeZone));
  return `<p style="margin:12px 0 0;color:${NAVY};font-family:${SANS};font-size:16px;line-height:1.5;">${descriptor} at <strong style="font-weight:700;">${time}</strong></p>`;
}

function renderText(
  lead: string,
  lines: readonly string[],
  offset: ReminderPayload['offset'],
  deepLink: string | null,
  unsubscribeUrl: string,
): string {
  const out: string[] = [lead, '', ...lines.map((line) => `  ${line}`), ''];
  if (offset === '-P1D' && deepLink) out.push(`${OPEN_WEEK}: ${deepLink}`, '');
  out.push(EM_DASH, `Sent by ${SENDER_NAME} ${MIDDLE_DOT} ${BUSINESS_ADDRESS}`);
  out.push(`Unsubscribe: ${unsubscribeUrl}`);
  return out.join('\n');
}

export function renderReminderEmail(
  payload: ReminderPayload,
  level: ChildNameLevel,
  now: Date,
): RenderedContent {
  // CASL requires a working unsubscribe on every commercial message; the send job
  // guarantees one, so a null here is a wiring bug — fail closed (rule #8).
  if (!payload.unsubscribeUrl) {
    throw new Error('reminder email: missing unsubscribe url');
  }
  const unsubscribeUrl = payload.unsubscribeUrl;

  const lead = whenLead(payload.offset);
  const lines = payload.events.map((event) =>
    eventLine(event, payload.children, level, now, payload.timeZone),
  );
  const subject = `${lead}: ${lines.join(', ')}`;

  const headline = `<h1 style="margin:8px 0 0;color:${CREAM};font-family:${SERIF};font-size:30px;font-weight:700;line-height:1.2;letter-spacing:-0.01em;">${escapeHtml(lead)}</h1>`;
  const header = `<tr><td style="background:${NAVY};border-radius:20px 20px 0 0;padding:36px 40px 28px;text-align:center;">${LOGO_IMG}${headline}</td></tr>`;

  const rows = payload.events
    .map((event) => eventRow(event, payload.children, level, now, payload.timeZone))
    .join('');

  // The /plan button rides the T-24h batch only — the T-1h ping is glanceable and
  // link-free (rule #6). Amber is FILL here (never small text); the label is white.
  const button =
    payload.offset === '-P1D' && payload.deepLink
      ? `<tr><td style="padding:22px 0 2px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-radius:12px;background:${AMBER};"><a href="${escapeHtml(payload.deepLink)}" style="display:inline-block;padding:13px 26px;color:#ffffff;font-family:${SANS};font-size:16px;font-weight:600;text-decoration:none;border-radius:12px;">${OPEN_WEEK}</a></td></tr></table></td></tr>`
      : '';

  const cardInner = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:0;">${rows}</td></tr>${button}</table>`;
  const card = `<tr><td style="background:${CARD};border:1px solid ${CARD_BORDER};border-top:none;border-radius:0 0 22px 22px;padding:26px 34px 22px;">${cardInner}</td></tr>`;

  const footer = `<tr><td style="padding:22px 8px 0;"><p style="margin:0;color:${SLATE};font-family:${SANS};font-size:12px;line-height:1.6;">Sent by ${escapeHtml(SENDER_NAME)} ${MIDDLE_DOT} ${escapeHtml(BUSINESS_ADDRESS)}<br/>You're receiving this because you turned on event reminders. <a href="${escapeHtml(unsubscribeUrl)}" style="color:${NAVY};">Unsubscribe</a>.</p></td></tr>`;

  const html = `<div style="margin:0;background:${PAGE};font-family:${SANS};padding:24px 0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto;">${header}${card}${footer}</table></div>`;

  const text = renderText(lead, lines, payload.offset, payload.deepLink, unsubscribeUrl);
  return { kind: 'email', subject, html, text };
}
