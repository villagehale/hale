import type { RenderedContent } from '~/lib/channel/types';
import { BUSINESS_ADDRESS, SENDER_NAME } from '~/lib/cron/email-compliance';
import type { ChildNameLevel } from '~/lib/loop/prefs';
import { eventDescriptor, eventLine, whenLead } from './core';
import type { ReminderChild, ReminderEventView, ReminderPayload } from './payload';

/**
 * VIL-223 · D1 — the reminder email. Redesigned (2026-07-21) for the 2-second glance:
 * a reminder is a NOTE, not a newsletter. The Sunday email is the family look (same
 * #300/#312 palette, same serif signature discipline), but a reminder's whole message
 * is WHAT + WHEN, so the hierarchy is inverted from the digest: the TIME is the anchor
 * (big serif, its own amber underline), the event is the serif line beneath it, a small
 * uppercase kicker carries the "tomorrow / in an hour" context, and everything else is
 * cut — no branded header panel, no boxes-in-boxes, no filler. A batch (a shared
 * evening) becomes a tabular time→event list instead of the single big anchor.
 *
 * Privacy (rule #1) is enforced by eventDescriptor (teen/sensitive → "an appointment").
 * Every interpolated value is escaped. Links are navy and ride the T-24h note only
 * (rule #6 — the T-1h ping is link-free). Fail-closed CASL: throw on a missing unsub.
 */

const NAVY = '#17294a'; // ink — the time, the event, links, the kicker
const PAGE = '#f7f5f0'; // warm cream page
const CARD = '#ffffff';
const CARD_BORDER = '#e7e2d6'; // warm hairline (the note's edge)
const RULE = '#efe9dc'; // faint warm divider between batch rows
const AMBER = '#b26b1f'; // the single restrained accent — the time's underline (FILL)
const SLATE = '#5c6b87'; // kicker + meridiem + footer
const SERIF = "Georgia,'Times New Roman',serif";
const SANS = "Inter,-apple-system,'Segoe UI',system-ui,Helvetica,Arial,sans-serif";

const EM_DASH = '—';
const MIDDLE_DOT = '·';
const SEE_WEEK = 'See your week';

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The family-local clock split into its glanceable parts: "4:30" + "PM". The email
 * anchor spells the meridiem out (a big ambiguous "4:30" defeats the 2-second glance);
 * SMS/push keep the compact no-meridiem label from core. */
function localTimeParts(startsAt: string, timeZone: string): { clock: string; meridiem: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
  }).formatToParts(new Date(startsAt));
  const value = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { clock: `${value('hour')}:${value('minute')}`, meridiem: value('dayPeriod').toUpperCase() };
}

/** The single-event note: the time as a big serif anchor with a short amber underline,
 * the event on the serif line beneath. This is the reminder at its most glanceable. The
 * serif line is the VIL-229 voice line when present (already privacy-redacted at
 * composition), else the deterministic descriptor (rule #8 fallback). */
function singleBlock(
  event: ReminderEventView,
  children: readonly ReminderChild[],
  level: ChildNameLevel,
  now: Date,
  timeZone: string,
  voice: string | null,
): string {
  const { clock, meridiem } = localTimeParts(event.startsAt, timeZone);
  const what = escapeHtml(voice ?? eventDescriptor(event, children, level, now));
  const time = `<p style="margin:0;color:${NAVY};font-family:${SERIF};font-size:46px;font-weight:700;line-height:1;letter-spacing:-0.01em;">${escapeHtml(clock)}<span style="font-family:${SANS};font-size:15px;font-weight:600;color:${SLATE};letter-spacing:0.04em;">&nbsp;${escapeHtml(meridiem)}</span></p>`;
  const underline = `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="width:44px;height:3px;background:${AMBER};border-radius:2px;font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
  const line = `<p style="margin:16px 0 0;color:${NAVY};font-family:${SERIF};font-size:21px;font-weight:400;line-height:1.35;">${what}</p>`;
  return `${time}<div style="padding-top:14px;">${underline}</div>${line}`;
}

/** The batch note: a shared evening as a tabular time→event list (the times align so
 * the eye scans the column), each event's descriptor on the serif side. A VIL-229 voice
 * line, when present, opens as a serif lead sentence above the list. */
function batchBlock(
  events: readonly ReminderEventView[],
  children: readonly ReminderChild[],
  level: ChildNameLevel,
  now: Date,
  timeZone: string,
  voice: string | null,
): string {
  const lead = voice
    ? `<p style="margin:0 0 18px;color:${NAVY};font-family:${SERIF};font-size:19px;font-weight:400;line-height:1.45;">${escapeHtml(voice)}</p>`
    : '';
  const rows = events
    .map((event, i) => {
      const { clock, meridiem } = localTimeParts(event.startsAt, timeZone);
      const descriptor = escapeHtml(eventDescriptor(event, children, level, now));
      const border = i === 0 ? '' : `border-top:1px solid ${RULE};`;
      return `<tr><td width="96" valign="top" style="${border}padding:12px 12px 12px 0;color:${NAVY};font-family:${SANS};font-size:15px;font-weight:700;white-space:nowrap;">${escapeHtml(clock)} <span style="font-weight:600;color:${SLATE};font-size:12px;">${escapeHtml(meridiem)}</span></td><td valign="top" style="${border}padding:12px 0;color:${NAVY};font-family:${SERIF};font-size:18px;line-height:1.35;">${descriptor}</td></tr>`;
    })
    .join('');
  return `${lead}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>`;
}

function renderText(
  lead: string,
  lines: readonly string[],
  offset: ReminderPayload['offset'],
  deepLink: string | null,
  unsubscribeUrl: string,
): string {
  const out: string[] = [lead, '', ...lines.map((line) => `  ${line}`), ''];
  if (offset === '-P1D' && deepLink) out.push(`${SEE_WEEK}: ${deepLink}`, '');
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

  const kicker = `<p style="margin:0 0 18px;color:${SLATE};font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;">${escapeHtml(lead)}</p>`;

  // The voice line is the LLM-composed serif signature (VIL-229), already redacted to
  // the rendered view at composition; null/absent → the deterministic line (rule #8).
  const voice = payload.voice?.line ?? null;
  const [first] = payload.events;
  const body =
    payload.events.length === 1 && first
      ? singleBlock(first, payload.children, level, now, payload.timeZone, voice)
      : batchBlock(payload.events, payload.children, level, now, payload.timeZone, voice);

  // One quiet action, navy (links use navy) — the T-24h note only; the T-1h ping is
  // link-free (rule #6).
  const link =
    payload.offset === '-P1D' && payload.deepLink
      ? `<p style="margin:26px 0 0;font-family:${SANS};font-size:15px;"><a href="${escapeHtml(payload.deepLink)}" style="color:${NAVY};font-weight:600;text-decoration:none;border-bottom:1px solid ${AMBER};padding-bottom:1px;">${SEE_WEEK} &rarr;</a></p>`
      : '';

  const card = `<tr><td style="background:${CARD};border:1px solid ${CARD_BORDER};border-radius:16px;padding:34px 36px;">${kicker}${body}${link}</td></tr>`;

  const footer = `<tr><td style="padding:20px 12px 0;"><p style="margin:0;color:${SLATE};font-family:${SANS};font-size:12px;line-height:1.6;">Sent by ${escapeHtml(SENDER_NAME)} ${MIDDLE_DOT} ${escapeHtml(BUSINESS_ADDRESS)}<br/>You turned on event reminders. <a href="${escapeHtml(unsubscribeUrl)}" style="color:${NAVY};">Unsubscribe</a>.</p></td></tr>`;

  const html = `<div style="margin:0;background:${PAGE};font-family:${SANS};padding:32px 0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:468px;margin:0 auto;">${card}${footer}</table></div>`;

  const text = renderText(lead, lines, payload.offset, payload.deepLink, unsubscribeUrl);
  return { kind: 'email', subject, html, text };
}
