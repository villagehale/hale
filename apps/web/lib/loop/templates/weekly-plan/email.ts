import type { WeekPlanItem } from '@hale/db';
import type { RenderedContent } from '~/lib/channel/types';
import { BUSINESS_ADDRESS, SENDER_NAME } from '~/lib/cron/email-compliance';
import type { ChildNameLevel } from '~/lib/loop/prefs';
import {
  childrenInPlan,
  dayAbbrev,
  headerNames,
  itemsChronological,
  leveledWhat,
  pendingCount,
  provenanceLabel,
  timeLabel,
  weekSubject,
} from './core';
import type { PlanChild, WeeklyPlanPayload } from './payload';

/**
 * VIL-218 · B2 — the email renderer, in the welcome-email visual language (inline
 * styled 600px table, Prussian header panel on a warm-white canvas, a white content
 * card, the CASL footer). Unlike SMS/push, email is the "full-ish" view: health is
 * shown (parent-facing, and teen items are already generic in the artifact) and item
 * titles are name-leveled. Every interpolated value is escaped (rule #1 + injection).
 */

const PRUSSIAN = '#003153';
const CANVAS = '#FAF7F1';
const CARD = '#ffffff';
const CARD_BORDER = '#E7E2DA';
const LINK = '#C2410C';
const TAGLINE_BLUE = '#C7D3E6';
const SLATE = '#47587A';
const FADED_SAGE = '#5b6b86';
const FONT_STACK = "Inter,-apple-system,'Segoe UI',system-ui,Helvetica,Arial,sans-serif";

const EM_DASH = '—';
const MIDDLE_DOT = '·';
const UNDATED_GROUP = 'This week';
const QUIET_LINE = `A quiet week ahead ${EM_DASH} nothing scheduled yet.`;
const REPLY_INVITE = 'Reply to this email to adjust anything.';

// The Hale mark as a hosted PNG (inline SVG is stripped by Gmail/Outlook) — same
// asset the welcome email uses, on the Prussian header panel.
const LOGO_IMG =
  '<img src="https://app.villagehale.com/email-logo.png" width="60" height="60" alt="Hale" style="display:inline-block;border-radius:14px;border:0;outline:none;text-decoration:none;" />';

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface DayGroup {
  key: string;
  label: string;
  items: WeekPlanItem[];
}

/** Group already-chronological items into consecutive day buckets (undated last). */
function groupByDay(ordered: readonly WeekPlanItem[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const item of ordered) {
    const key = item.startsAt ? item.startsAt.slice(0, 10) : UNDATED_GROUP;
    const label = dayAbbrev(item.startsAt) ?? UNDATED_GROUP;
    const last = groups.at(-1);
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, label, items: [item] });
  }
  return groups;
}

function itemRow(
  item: WeekPlanItem,
  children: readonly PlanChild[],
  level: ChildNameLevel,
  now: Date,
): string {
  const time = timeLabel(item.startsAt);
  const what = leveledWhat(item, children, level, now);
  const chip = provenanceLabel(item.kind);
  const timeHtml = time
    ? `<span style="color:${SLATE};font-weight:600;">${escapeHtml(time)}</span> `
    : '';
  const chipHtml = `<span style="display:inline-block;margin-left:8px;padding:1px 8px;background:${CANVAS};border:1px solid ${CARD_BORDER};border-radius:999px;color:${FADED_SAGE};font-size:11px;font-weight:600;">${escapeHtml(chip)}</span>`;
  return `<tr><td style="padding:5px 0;color:${PRUSSIAN};font-size:15px;line-height:1.5;">${timeHtml}${escapeHtml(what)}${chipHtml}</td></tr>`;
}

function dayBlock(
  group: DayGroup,
  children: readonly PlanChild[],
  level: ChildNameLevel,
  now: Date,
): string {
  const rows = group.items.map((i) => itemRow(i, children, level, now)).join('');
  return `<tr><td style="padding:14px 0 2px;"><p style="margin:0 0 4px;color:${LINK};font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;">${escapeHtml(group.label)}</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table></td></tr>`;
}

function renderText(
  payload: WeeklyPlanPayload,
  subjectLine: string,
  ordered: readonly WeekPlanItem[],
  pending: number,
  level: ChildNameLevel,
  now: Date,
): string {
  const lines: string[] = [subjectLine, ''];
  if (payload.summary) lines.push(payload.summary, '');
  if (ordered.length === 0) {
    lines.push(QUIET_LINE, '');
  } else {
    for (const group of groupByDay(ordered)) {
      lines.push(group.label);
      for (const item of group.items) {
        const time = timeLabel(item.startsAt);
        const what = leveledWhat(item, payload.children, level, now);
        lines.push(`  ${time ? `${time} ` : ''}${what} [${provenanceLabel(item.kind)}]`);
      }
      lines.push('');
    }
  }
  if (pending > 0) lines.push(`${pending} need your OK`, '');
  lines.push(REPLY_INVITE, '', EM_DASH, `Sent by ${SENDER_NAME} ${MIDDLE_DOT} ${BUSINESS_ADDRESS}`);
  lines.push(`Unsubscribe: ${payload.unsubscribeUrl}`);
  return lines.join('\n');
}

export function renderWeeklyPlanEmail(
  payload: WeeklyPlanPayload,
  level: ChildNameLevel,
  now: Date,
): RenderedContent {
  // CASL requires a working unsubscribe; the send job guarantees one, so a null here
  // is a wiring bug — fail closed rather than send a non-compliant email (rule #8).
  if (!payload.unsubscribeUrl) {
    throw new Error('weekly_plan email: missing unsubscribe url');
  }
  const unsubscribeUrl = payload.unsubscribeUrl;

  const inPlan = childrenInPlan(payload.items, payload.children);
  const subjectLine = `${weekSubject(headerNames(inPlan, level, now))} week ahead`;
  const ordered = itemsChronological(payload.items);
  const pending = pendingCount(payload.items);

  const header = `<tr><td style="background:${PRUSSIAN};border-radius:18px 18px 0 0;padding:36px 40px 26px;text-align:center;">${LOGO_IMG}<h1 style="margin:14px 0 0;color:#ffffff;font-size:24px;font-weight:700;letter-spacing:-0.02em;">${escapeHtml(subjectLine)}</h1><p style="margin:10px 0 0;color:${TAGLINE_BLUE};font-size:15px;font-weight:600;">Hale ${EM_DASH} the week ahead.</p></td></tr>`;

  const summaryHtml = payload.summary
    ? `<p style="margin:0 0 10px;color:${SLATE};font-size:16px;line-height:1.6;">${escapeHtml(payload.summary)}</p>`
    : '';

  const body =
    ordered.length === 0
      ? `<p style="margin:0 0 6px;color:${SLATE};font-size:16px;line-height:1.6;">${escapeHtml(QUIET_LINE)}</p>`
      : groupByDay(ordered)
          .map((g) => dayBlock(g, payload.children, level, now))
          .join('');

  const pendingHtml =
    pending > 0
      ? `<p style="margin:18px 0 0;color:${PRUSSIAN};font-size:15px;font-weight:700;">${escapeHtml(`${pending} need your OK`)}</p>`
      : '';

  const reply = `<p style="margin:16px 0 0;color:${SLATE};font-size:15px;line-height:1.6;">${escapeHtml(REPLY_INVITE)}</p>`;

  const card = `<tr><td style="background:${CARD};border:1px solid ${CARD_BORDER};border-top:none;border-radius:0 0 24px 24px;padding:26px 32px 14px;">${summaryHtml}${body}${pendingHtml}${reply}</td></tr>`;

  const footer = `<tr><td style="padding:24px 8px 0;"><p style="margin:0;color:${FADED_SAGE};font-size:12px;line-height:1.6;">Sent by ${escapeHtml(SENDER_NAME)} ${MIDDLE_DOT} ${escapeHtml(BUSINESS_ADDRESS)}<br/>You're receiving this because you turned on your weekly plan. <a href="${escapeHtml(unsubscribeUrl)}" style="color:${FADED_SAGE};">Unsubscribe</a>.</p></td></tr>`;

  const html = `<div style="margin:0;background:${CANVAS};font-family:${FONT_STACK};padding:24px 0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto;">${header}${card}${footer}</table></div>`;

  const text = renderText(payload, subjectLine, ordered, pending, level, now);
  return { kind: 'email', subject: subjectLine, html, text };
}
