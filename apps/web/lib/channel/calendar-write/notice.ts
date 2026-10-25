import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import type {
  GoogleCalendarOp,
  GoogleCalendarSyncReport,
} from '@hale/worker/google-calendar-placement';
import { z } from 'zod';
import type { ReplyLanguage } from '~/lib/channel/language';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * VIL-454 (T6) 1/3 — the text that tells a parent how the write to THEIR calendar went.
 *
 * The Google leg of a placement (executor `syncGoogle`) already ends in a named
 * report. This module turns that report into the facts for one AI-written 1:1 text
 * (skill `calendar-write-notice`): no fixed copy, no keyword asks. Code owns the outcome
 * and the link; the model writes the words. A report that is not the parent's news
 * (Hale's own calendar only, a duplicate pass, an event that is gone) is no notice at
 * all, so a re-driven placement never texts twice.
 *
 * Not wired to a send yet: `calendarWriteNoticeEnabled` is exactly `true` to arm it, and
 * nothing reads it in this PR. Default off.
 */

export const CALENDAR_WRITE_NOTICE_SKILL = 'calendar-write-notice';

export function calendarWriteNoticeEnabled(env: Record<string, string | undefined> = process.env) {
  return env.CALENDAR_WRITE_NOTICE_ENABLED?.trim() === 'true';
}

export type CalendarWriteOutcome =
  | 'added'
  | 'updated'
  | 'removed'
  | 'no_calendar'
  | 'needs_permission'
  | 'needs_reconnect'
  | 'could_not_write';

/** Outcomes that hand the parent a way to connect, allow, or reconnect. */
const NEEDS_LINK: ReadonlySet<CalendarWriteOutcome> = new Set([
  'no_calendar',
  'needs_permission',
  'needs_reconnect',
]);

/**
 * The parent's news in a sync report, or null when there is none to tell. Null cases:
 * the write path is off or unwired (Hale's own calendar only), a duplicate pass
 * (`already_present`), an event Hale did not place or that is gone, and more than one
 * eligible calendar (`ambiguous`, which needs a choice, not a notice).
 */
export function calendarWriteOutcome(
  op: GoogleCalendarOp,
  report: GoogleCalendarSyncReport,
): CalendarWriteOutcome | null {
  if (report.status === 'written') {
    return op === 'create' ? 'added' : op === 'update' ? 'updated' : 'removed';
  }
  if (report.status === 'failed') return 'could_not_write';
  switch (report.reason) {
    case 'not_connected':
      return 'no_calendar';
    case 'scope_missing':
      return 'needs_permission';
    case 'token_unavailable':
      return 'needs_reconnect';
    default:
      return null;
  }
}

export interface CalendarWriteEvent {
  title: string;
  /** Already rendered in the family's zone. */
  when: string;
  where: string | null;
}

export interface CalendarWriteNoticeInput {
  outcome: CalendarWriteOutcome;
  event: CalendarWriteEvent;
  connectLink: string | null;
  language: ReplyLanguage;
}

/**
 * The facts the skill is handed. A link is passed only to an outcome that needs one, so
 * a stray link on a success can't happen; a link outcome with no link to give is refused
 * (null) rather than sent without its way forward.
 */
export function calendarWriteNoticeInput(args: {
  op: GoogleCalendarOp;
  report: GoogleCalendarSyncReport;
  event: CalendarWriteEvent;
  connectLink: string | null;
  language: ReplyLanguage;
}): CalendarWriteNoticeInput | null {
  const outcome = calendarWriteOutcome(args.op, args.report);
  if (!outcome) return null;
  const needsLink = NEEDS_LINK.has(outcome);
  if (needsLink && !args.connectLink) return null;
  return {
    outcome,
    event: args.event,
    connectLink: needsLink ? args.connectLink : null,
    language: args.language,
  };
}

/** The user turn. Shared with the eval, which replays this request shape. */
export function calendarWriteNoticeUserMessage(input: CalendarWriteNoticeInput): string {
  return JSON.stringify(input);
}

export const CALENDAR_WRITE_NOTICE_MAX_CHARS = 480;
const URL_SHAPE = /https?:\/\/\S+/gi;

/**
 * Structural refusals only, never wording: empty, too long, a link that is not the one
 * handed, or a handed link that did not make it in exactly.
 */
export function calendarWriteNoticeRefusals(
  body: string,
  input: CalendarWriteNoticeInput,
): string[] {
  const text = body.trim();
  if (text === '') return ['empty'];
  const found: string[] = [];
  if (text.length > CALENDAR_WRITE_NOTICE_MAX_CHARS) found.push('over_char_cap');
  const urls = text.match(URL_SHAPE) ?? [];
  if (input.connectLink === null) {
    if (urls.length > 0) found.push('carries_link');
  } else {
    if (!text.includes(input.connectLink)) found.push('link_missing');
    if (urls.some((url) => !url.startsWith(input.connectLink as string))) found.push('other_link');
  }
  return found;
}

const outputSchema = z.object({ text: z.string() });
const outputJsonSchema = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
} as const;

export const CALENDAR_WRITE_NOTICE_MAX_ATTEMPTS = 2;

/**
 * One text, or null when two attempts were refused or failed. Null sends nothing: a
 * notice that can't be written well is not replaced by canned copy.
 */
export async function composeCalendarWriteNotice(
  client: AgentClient,
  input: CalendarWriteNoticeInput,
): Promise<string | null> {
  const skill = await loadCronSkill(CALENDAR_WRITE_NOTICE_SKILL);
  for (let attempt = 1; attempt <= CALENDAR_WRITE_NOTICE_MAX_ATTEMPTS; attempt += 1) {
    try {
      const { value } = await forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: calendarWriteNoticeUserMessage(input),
        toolName: 'calendar_write_notice',
        toolDescription: 'The one text Hale sends the parent.',
        inputJsonSchema: outputJsonSchema,
        schema: outputSchema,
        maxTokens: 300,
      });
      const text = value.text.trim();
      const refusals = calendarWriteNoticeRefusals(text, input);
      if (refusals.length === 0) return text;
      console.warn({ attempt, refusals }, 'calendar write notice: draft refused');
    } catch (err) {
      console.warn(
        { attempt, err: err instanceof Error ? err.name : 'unknown' },
        'calendar write notice: compose failed',
      );
    }
  }
  console.error(
    { outcome: 'calendar_write_notice_unwritten' },
    'calendar write notice: nothing sent',
  );
  return null;
}
