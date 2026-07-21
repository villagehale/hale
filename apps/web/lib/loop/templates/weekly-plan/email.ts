import type { WeekPlanItem } from '@hale/db';
import type { RenderedContent } from '~/lib/channel/types';
import { BUSINESS_ADDRESS, SENDER_NAME } from '~/lib/cron/email-compliance';
import type { ChildNameLevel } from '~/lib/loop/prefs';
import {
  childrenInPlan,
  dayAbbrev,
  headerNames,
  leveledWhat,
  partitionByNeed,
  provenanceLabel,
  timeLabel,
  weekRangeLabel,
  weekSubject,
} from './core';
import type { PlanChild, WeeklyPlanPayload } from './payload';

/**
 * VIL-218 · B2 — the email renderer.
 *
 * Design pass (2026-07-21, two-rubric): the Sunday email is the loop's flagship
 * parent-facing artifact, so its design goes through the frontend-design +
 * ui-ux-pro-max rubrics rather than mechanically mirroring the welcome email.
 *
 * - Typography-as-personality: the week headline is the SINGLE signature moment —
 *   a serif display line (Georgia, the app's serif fallback; Source Serif 4 can't
 *   load in email) on the navy header. Serif is Hale's *voice* (headline + summary);
 *   sans is the plan's *data* (days, times, titles). One serif system, ranked by scale.
 * - Structure-is-information: the plan is two sections, not one list — an amber-wash
 *   "N need your OK" region (the decisions) above a quiet "On the calendar" region
 *   (what's handled). partitionByNeed is the spine.
 * - Palette law (#300/#312 site tokens, applied to email pixels): warm white + navy
 *   #17294a + restrained amber #b26b1f, NO blue accents (the old light-blue tagline
 *   is gone). Amber appears only as FILL (the wash + its accent bar); links are navy.
 *   Every color is contrast-checked on its own background (see the header comment
 *   values) — footer/meta ride SLATE, which clears AA on the warm page.
 *
 * Unlike SMS/push, email is the full-ish view: health is shown (parent-facing, and
 * teen items are already generic in the artifact) and titles are name-leveled. Every
 * interpolated value is escaped (rule #1 + injection).
 */

// Site palette (#300/#312), each pair contrast-checked (AA 4.5 text / 3.0 fill):
const NAVY = '#17294a'; // primary ink / header panel / links — 14.5:1 on white
const PAGE = '#f7f5f0'; // warm cream page canvas (the card floats on it)
const CARD = '#ffffff';
const CARD_BORDER = '#e4e7ee';
const WASH = '#fef0c7'; // amber wash — the "needs your OK" region — navy 12.7:1 on it
const AMBER = '#b26b1f'; // restrained amber — FILL only (the wash's accent bar) — 4.2:1 fill
const CREAM = '#f7f4ec'; // headline on navy — 13.2:1
const KICKER = '#d0c3ab'; // date-range kicker on navy — 8.3:1
const SLATE = '#5c6b87'; // summary / meta / day labels / footer — 5.4:1 white, 4.9:1 page
const SERIF = "Georgia,'Times New Roman',serif";
const SANS = "Inter,-apple-system,'Segoe UI',system-ui,Helvetica,Arial,sans-serif";

const EM_DASH = '—';
const MIDDLE_DOT = '·';
const UNDATED_GROUP = 'This week';
const QUIET_LINE = `A quiet week ahead ${EM_DASH} nothing scheduled yet.`;
const REPLY_INVITE = 'Reply to this email to adjust anything.';

// The Hale mark as a hosted PNG (inline SVG is stripped by Gmail/Outlook) — same
// asset the welcome email uses, on the navy header panel.
const LOGO_IMG =
  '<img src="https://app.villagehale.com/email-logo.png" width="56" height="56" alt="Hale" style="display:inline-block;border-radius:14px;border:0;outline:none;text-decoration:none;" />';

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A "Mon 4:30 " / "Mon " / "" time prefix for an item, from its ISO start key. */
function whenPrefix(item: WeekPlanItem, withDay: boolean): string {
  const day = withDay ? dayAbbrev(item.startsAt) : null;
  const time = timeLabel(item.startsAt);
  const parts = [day, time].filter((p): p is string => p !== null);
  return parts.length ? `${parts.join(' ')} ` : '';
}

/** One plan item as a `<p>` line: an optional bold when-prefix, the name-leveled
 * "what", and a quiet provenance caption. `withDay` is false inside a day group
 * (the group heading already carries the day). */
function itemLine(
  item: WeekPlanItem,
  children: readonly PlanChild[],
  level: ChildNameLevel,
  now: Date,
  withDay: boolean,
): string {
  const when = whenPrefix(item, withDay);
  const whenHtml = when ? `<strong style="color:${NAVY};font-weight:700;">${escapeHtml(when)}</strong>` : '';
  const what = escapeHtml(leveledWhat(item, children, level, now));
  const prov = `<span style="color:${SLATE};font-size:12px;">${MIDDLE_DOT} ${escapeHtml(provenanceLabel(item.kind))}</span>`;
  return `<p style="margin:6px 0 0;color:${NAVY};font-family:${SANS};font-size:15px;line-height:1.5;">${whenHtml}${what} ${prov}</p>`;
}

/** The amber-wash decision region: "N need your OK" over the pending items. Amber
 * is FILL here (the wash + a left accent bar), never small text — links stay navy. */
function pendingSection(
  pending: readonly WeekPlanItem[],
  children: readonly PlanChild[],
  level: ChildNameLevel,
  now: Date,
): string {
  const heading = `<p style="margin:0 0 6px;color:${NAVY};font-family:${SANS};font-size:14px;font-weight:700;letter-spacing:0.01em;">${escapeHtml(`${pending.length} need your OK`)}</p>`;
  const lines = pending.map((i) => itemLine(i, children, level, now, true)).join('');
  return `<tr><td style="padding:2px 0 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${WASH};border-left:3px solid ${AMBER};border-radius:10px;padding:16px 18px;">${heading}${lines}</td></tr></table></td></tr>`;
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

/** The quiet "On the calendar" region: what's already handled, grouped by day. */
function handledSection(
  handled: readonly WeekPlanItem[],
  children: readonly PlanChild[],
  level: ChildNameLevel,
  now: Date,
): string {
  const groups = groupByDay(handled)
    .map((g) => {
      const label = `<p style="margin:14px 0 0;color:${SLATE};font-family:${SANS};font-size:13px;font-weight:700;">${escapeHtml(g.label)}</p>`;
      const rows = g.items.map((i) => itemLine(i, children, level, now, false)).join('');
      return `${label}${rows}`;
    })
    .join('');
  const heading = `<p style="margin:0;color:${SLATE};font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">On the calendar</p>`;
  return `<tr><td style="padding:18px 0 0;">${heading}${groups}</td></tr>`;
}

function renderText(
  payload: WeeklyPlanPayload,
  subjectLine: string,
  pending: readonly WeekPlanItem[],
  handled: readonly WeekPlanItem[],
  level: ChildNameLevel,
  now: Date,
): string {
  const lines: string[] = [subjectLine, weekRangeLabel(payload.weekStart), ''];
  if (payload.summary) lines.push(payload.summary, '');
  if (pending.length === 0 && handled.length === 0) {
    lines.push(QUIET_LINE, '');
  }
  if (pending.length > 0) {
    lines.push(`${pending.length} need your OK`);
    for (const item of pending) {
      lines.push(
        `  ${whenPrefix(item, true)}${leveledWhat(item, payload.children, level, now)} (${provenanceLabel(item.kind)})`,
      );
    }
    lines.push('');
  }
  if (handled.length > 0) {
    lines.push('On the calendar');
    for (const group of groupByDay(handled)) {
      lines.push(group.label);
      for (const item of group.items) {
        lines.push(
          `  ${whenPrefix(item, false)}${leveledWhat(item, payload.children, level, now)} (${provenanceLabel(item.kind)})`,
        );
      }
    }
    lines.push('');
  }
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
  const { pending, handled } = partitionByNeed(payload.items);

  const kicker = `<p style="margin:16px 0 0;color:${KICKER};font-family:${SANS};font-size:12px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;">${escapeHtml(weekRangeLabel(payload.weekStart))}</p>`;
  const headline = `<h1 style="margin:8px 0 0;color:${CREAM};font-family:${SERIF};font-size:30px;font-weight:700;line-height:1.2;letter-spacing:-0.01em;">${escapeHtml(subjectLine)}</h1>`;
  const header = `<tr><td style="background:${NAVY};border-radius:20px 20px 0 0;padding:38px 40px 30px;text-align:center;">${LOGO_IMG}${kicker}${headline}</td></tr>`;

  // The summary is the assistant's serif *voice* — quieter than the headline (smaller,
  // slate), so scale ranks the one signature above it.
  const summaryHtml = payload.summary
    ? `<p style="margin:0 0 20px;color:${SLATE};font-family:${SERIF};font-size:18px;line-height:1.6;">${escapeHtml(payload.summary)}</p>`
    : '';

  let body: string;
  if (pending.length === 0 && handled.length === 0) {
    body = `<tr><td><p style="margin:0;color:${SLATE};font-family:${SANS};font-size:16px;line-height:1.6;">${escapeHtml(QUIET_LINE)}</p></td></tr>`;
  } else {
    const pendingHtml = pending.length > 0 ? pendingSection(pending, payload.children, level, now) : '';
    const handledHtml = handled.length > 0 ? handledSection(handled, payload.children, level, now) : '';
    body = `${pendingHtml}${handledHtml}`;
  }

  const reply = `<tr><td style="padding:22px 0 0;"><p style="margin:0;color:${SLATE};font-family:${SANS};font-size:15px;line-height:1.6;">${escapeHtml(REPLY_INVITE)}</p></td></tr>`;

  const cardInner = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${body}${reply}</table>`;
  const card = `<tr><td style="background:${CARD};border:1px solid ${CARD_BORDER};border-top:none;border-radius:0 0 22px 22px;padding:28px 34px 16px;">${summaryHtml}${cardInner}</td></tr>`;

  const footer = `<tr><td style="padding:22px 8px 0;"><p style="margin:0;color:${SLATE};font-family:${SANS};font-size:12px;line-height:1.6;">Sent by ${escapeHtml(SENDER_NAME)} ${MIDDLE_DOT} ${escapeHtml(BUSINESS_ADDRESS)}<br/>You're receiving this because you turned on your weekly plan. <a href="${escapeHtml(unsubscribeUrl)}" style="color:${NAVY};">Unsubscribe</a>.</p></td></tr>`;

  const html = `<div style="margin:0;background:${PAGE};font-family:${SANS};padding:24px 0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto;">${header}${card}${footer}</table></div>`;

  const text = renderText(payload, subjectLine, pending, handled, level, now);
  return { kind: 'email', subject: subjectLine, html, text };
}
