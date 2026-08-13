import type { ResendAttachment } from '~/lib/channel/resend-transport';
import type { ChannelKind, LoopMessage, RenderedContent, TemplateRenderer } from '~/lib/channel/types';
import { BUSINESS_ADDRESS, SENDER_NAME } from '~/lib/cron/email-compliance';
import type { ChildNameLevel } from '~/lib/loop/prefs';

/**
 * VIL-249 · M13 — the calendar-invite email, and the one text that asks a family for
 * an address to send it to.
 *
 * WHY THE SUMMARY ARRIVES PRE-REDACTED. Every other template applies the parent's
 * child_name_level at RENDER time. This one cannot: the invite's whole payload is the
 * iTIP object, whose SUMMARY had to be serialized before the message existed, so the
 * composer (lib/loop/ics-invite.ts) resolves the level through the same single reader
 * the dispatch uses (loadLoopPrefsView) and hands the finished descriptor down.
 *
 * THE PROSE IS COMPOSED, THE FACTS AND THE FOOTER ARE NOT (founder, 2026-08-12: no
 * preset message bodies). The subject and the one-or-two-sentence note arrive on the
 * payload already written by the model and already gated — including a containment
 * check that both carry the redacted summary verbatim, so the envelope can never say
 * more than the attachment (rule #1). What stays structural here is the chrome around
 * them: the event line, the time, and the CASL footer, which is a legal requirement
 * rather than a message.
 */

export const CALENDAR_INVITE_TEMPLATE_KEY = 'calendar_invite';
export const CALENDAR_EMAIL_ASK_TEMPLATE_KEY = 'calendar_email_ask';

export interface CalendarInvitePayload {
  /** The event's descriptor, already rendered at the recipient's privacy level. */
  summary: string;
  /** The start, formatted in the family's timezone — the same string the composer was
   * handed and had to reproduce verbatim. */
  when: string;
  method: 'REQUEST' | 'CANCEL';
  /** The composed subject line (gated: contains {@link CalendarInvitePayload.summary}). */
  subject: string;
  /** The composed note above the attachment (gated: contains the summary AND the time). */
  body: string;
  unsubscribeUrl: string;
  attachment: ResendAttachment;
}

const NAVY = '#17294a';
const PAGE = '#f7f5f0';
const CARD = '#ffffff';
const CARD_BORDER = '#e7e2d6';
const AMBER = '#b26b1f';
const SLATE = '#5c6b87';
const SERIF = "Georgia,'Times New Roman',serif";
const SANS = "Inter,-apple-system,'Segoe UI',system-ui,Helvetica,Arial,sans-serif";
const EM_DASH = '—';
const MIDDLE_DOT = '·';

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** "Wed, Jul 22 at 10:30 AM", in the family's own zone. Exported because the composer
 * is handed this exact string and the containment gate holds it to it. */
export function inviteWhenLabel(startsAt: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone,
  }).format(startsAt);
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
  }).format(startsAt);
  return `${day} at ${time}`;
}

export function asCalendarInvitePayload(payload: Record<string, unknown>): CalendarInvitePayload {
  const p = payload as Partial<CalendarInvitePayload>;
  if (!p.summary || !p.when || !p.method || !p.attachment) {
    throw new Error('calendar invite renderer: payload is missing the composed invite');
  }
  // No preset body exists to fall back on, so a payload without the composed prose is
  // a caller that skipped the composer — a wiring bug, not a state to render around.
  if (!p.subject || !p.body) {
    throw new Error('calendar invite renderer: payload carries no composed subject/body');
  }
  // CASL: every message on the loop's email streams carries a working unsubscribe, and
  // the composer always has one — a missing link is a wiring bug, not a state (rule #8).
  if (!p.unsubscribeUrl) {
    throw new Error('calendar invite renderer: missing unsubscribe url');
  }
  return p as CalendarInvitePayload;
}

export function renderCalendarInviteEmail(payload: CalendarInvitePayload): RenderedContent {
  const summaryHtml = `<p style="margin:0;color:${NAVY};font-family:${SERIF};font-size:26px;font-weight:400;line-height:1.3;">${escapeHtml(payload.summary)}</p>`;
  const underline = `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="width:44px;height:3px;background:${AMBER};border-radius:2px;font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
  const whenHtml = `<p style="margin:16px 0 0;color:${NAVY};font-family:${SANS};font-size:16px;font-weight:600;">${escapeHtml(payload.when)}</p>`;
  const noteHtml = `<p style="margin:22px 0 0;color:${SLATE};font-family:${SANS};font-size:14px;line-height:1.6;">${escapeHtml(payload.body)}</p>`;
  const card = `<tr><td style="background:${CARD};border:1px solid ${CARD_BORDER};border-radius:16px;padding:34px 36px;">${summaryHtml}<div style="padding-top:14px;">${underline}</div>${whenHtml}${noteHtml}</td></tr>`;
  const footer = `<tr><td style="padding:20px 12px 0;"><p style="margin:0;color:${SLATE};font-family:${SANS};font-size:12px;line-height:1.6;">Sent by ${escapeHtml(SENDER_NAME)} ${MIDDLE_DOT} ${escapeHtml(BUSINESS_ADDRESS)}<br/>You get these because Hale keeps your family's calendar. <a href="${escapeHtml(payload.unsubscribeUrl)}" style="color:${NAVY};">Unsubscribe</a>.</p></td></tr>`;
  const html = `<div style="margin:0;background:${PAGE};font-family:${SANS};padding:32px 0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:468px;margin:0 auto;">${card}${footer}</table></div>`;

  const text = [
    payload.body,
    '',
    EM_DASH,
    `Sent by ${SENDER_NAME} ${MIDDLE_DOT} ${BUSINESS_ADDRESS}`,
    `Unsubscribe: ${payload.unsubscribeUrl}`,
  ].join('\n');

  return { kind: 'email', subject: payload.subject, html, text, attachments: [payload.attachment] };
}

/**
 * The invite renderer. EMAIL ONLY, deliberately: the message is pinned to the email
 * leg (LoopMessage.channel) because a text/calendar part has no SMS or push form —
 * rendering a bare sentence for those channels would be a send that delivers nothing.
 * A throw here means the pin was removed, which is a wiring bug and not a state to
 * degrade into.
 */
export const calendarInviteRenderer: TemplateRenderer = {
  render(message: LoopMessage, channel: ChannelKind): RenderedContent {
    if (channel !== 'email') {
      throw new Error(`calendar invite renderer: no ${channel} form of a calendar invite`);
    }
    return renderCalendarInviteEmail(asCalendarInvitePayload(message.payload));
  },
};

/**
 * The just-in-time ask (D-register: single-ask intake, then just-in-time everything).
 * SMS only, and the body arrives on the payload because it is COMPOSED, not authored:
 * lib/loop/voice/calendar-invite-voice.ts writes it and gates it (one question, GSM-7,
 * one segment, no links, no invented specifics) before it ever reaches a message.
 */
export const calendarEmailAskRenderer: TemplateRenderer = {
  render(message: LoopMessage, channel: ChannelKind, _nameLevel: ChildNameLevel): RenderedContent {
    if (channel !== 'sms') {
      throw new Error(`calendar email ask: no ${channel} form of the ask`);
    }
    const text = message.payload.text;
    if (typeof text !== 'string' || !text) {
      throw new Error('calendar email ask: payload carries no text');
    }
    return { kind: 'sms', text };
  },
};
