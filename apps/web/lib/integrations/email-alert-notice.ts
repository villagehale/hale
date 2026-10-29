import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { ExtractionKind, FamilyChildRef, SentinelClassification } from '~/lib/sentinel';

/**
 * The email-alert text. ONE model call decides, from facts, whether the email is about this
 * family's children and clear enough to tell them about, and — only then — writes the whole
 * text. Code owns the facts and the privacy cuts; the model owns the decision and every
 * word. There is no code-built sentence, no fixed copy and no fallback: a draft that cannot
 * be written, or an email the model would not text about, is NOTHING SENT.
 */

export const EMAIL_ALERT_NOTICE_SKILL = 'email-alert-notice';
export const EMAIL_ALERT_NOTICE_TOOL = 'email_alert_notice';
export const EMAIL_ALERT_NOTICE_TOOL_DESCRIPTION =
  'Decide whether this email is about the children and clear, and write the one text if so.';
export const EMAIL_ALERT_NOTICE_MAX_TOKENS = 600;
export const EMAIL_ALERT_NOTICE_MAX_ATTEMPTS = 2;

/** The kinds a notice may be about. `unclear` never reaches the writer. */
export type NoticeKind = Exclude<ExtractionKind, 'unclear'>;

export type NoticeOffer = 'add_to_week' | 'add_to_calendar';

export interface NoticeMoment {
  /** "Saturday, September 19, 2026" in the family's zone. */
  date: string;
  /** "9:00 AM" in the family's zone, always with the meridiem. */
  time: string;
}

export interface EmailAlertNoticeFacts {
  now: NoticeMoment;
  children: Array<{ name: string; ageYears: number }>;
  email: {
    sender: string | null;
    subject: string | null;
    kind: NoticeKind;
    title: string;
    namedChild: string | null;
    was: NoticeMoment | null;
    when: NoticeMoment | null;
    /** How long the occasion lasts, in minutes, when the source has an end; else null. */
    durationMinutes: number | null;
    location: string | null;
  };
  fromParentsOwnCalendar: boolean;
  alreadyOnCalendar: boolean;
  offer: NoticeOffer | null;
  otherHaleFamiliesGoing: number | null;
  private: boolean;
  language: string;
}

/** The two kinds that are news about an occasion the family already holds. */
const CALENDAR_CHANGES: ReadonlySet<ExtractionKind> = new Set(['cancellation', 'reschedule']);

/**
 * The two answers that need no writer, from the extraction's own fields: the reading step
 * said it could not tell what changed, or the family already holds this occasion and the
 * email does not change it (a reminder, a re-announcement, a second receipt). Null when the
 * writer decides.
 */
export function quietBeforeWriting(
  extraction: Pick<NonNullable<SentinelClassification['extraction']>, 'kind' | 'matchedEventRef'>,
): 'unclear' | 'already_on_calendar' | null {
  if (extraction.kind === 'unclear') return 'unclear';
  if (extraction.matchedEventRef !== null && !CALENDAR_CHANGES.has(extraction.kind)) {
    return 'already_on_calendar';
  }
  return null;
}

export type EmailAlertNotice =
  | { send: true; text: string }
  | { send: false; why: 'not_about_the_kids' | 'unclear' | 'unwritten' };

function moment(iso: string | null, timeZone: string): NoticeMoment | null {
  if (iso === null) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return momentOf(at, timeZone);
}

function momentOf(at: Date, timeZone: string): NoticeMoment {
  const date = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone,
  }).format(at);
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
  }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    date,
    time: `${part('hour')}:${part('minute')} ${part('dayPeriod').toUpperCase()}`,
  };
}

/**
 * Who it is from, as a parent would name them: the display name if the header carries
 * one, otherwise the bare domain. NEVER the full address — a display name that is itself
 * an address falls through to the domain, because reading it is reading the mailbox out.
 */
export function senderLabel(from: string): string {
  const display = /^\s*"?([^"<]*?)"?\s*<[^>]*>\s*$/.exec(from)?.[1]?.trim();
  if (display !== undefined && display !== '' && !display.includes('@')) return display;
  const address = /<([^>]*)>/.exec(from)?.[1] ?? from;
  return address.split('@')[1]?.trim() ?? '';
}

export function emailAlertNoticeFacts(input: {
  from: string;
  subject: string;
  kind: NoticeKind;
  extraction: NonNullable<SentinelClassification['extraction']>;
  children: readonly FamilyChildRef[];
  fromParentsOwnCalendar: boolean;
  offer: NoticeOffer | null;
  otherHaleFamiliesGoing: number | null;
  /** The family's reply language (`families.primary_language`), any tag. */
  language: string;
  /** The occasion's length when its source has an end (the matched calendar row). */
  durationMinutes: number | null;
  timeZone: string;
  now: Date;
}): EmailAlertNoticeFacts {
  const { extraction, timeZone } = input;
  const hidden = extraction.teenContent;
  const named = input.children.find((child) => child.id === extraction.event.childRef);
  return {
    now: momentOf(input.now, timeZone),
    // A 13+ child's mail is category-only (rule #1): the pipeline already genericised the
    // title, and which child, who wrote, when, where and the subject line are the
    // disclosure. The writer cannot say what it is not handed.
    children: hidden
      ? []
      : input.children
          .filter((child) => child.name.trim() !== '')
          .map((child) => ({
            name: child.name.trim(),
            ageYears: Math.floor(child.ageInMonths / 12),
          })),
    email: {
      sender: hidden ? null : senderLabel(input.from) || null,
      subject: hidden ? null : input.subject.trim() || null,
      kind: input.kind,
      title: extraction.event.title.trim(),
      namedChild: hidden ? null : (named?.name.trim() ?? null),
      was: hidden ? null : moment(extraction.event.originalTime, timeZone),
      when: hidden ? null : moment(extraction.event.newTime, timeZone),
      durationMinutes: hidden ? null : input.durationMinutes,
      location: hidden ? null : extraction.event.location?.trim() || null,
    },
    fromParentsOwnCalendar: input.fromParentsOwnCalendar,
    alreadyOnCalendar: extraction.matchedEventRef !== null,
    offer: hidden ? null : input.offer,
    otherHaleFamiliesGoing: hidden ? null : input.otherHaleFamiliesGoing,
    private: hidden,
    language: input.language,
  };
}

/** The user turn. Shared with the eval, which replays this request shape. */
export function emailAlertNoticeUserMessage(facts: EmailAlertNoticeFacts): string {
  return JSON.stringify(facts);
}

const URL_SHAPE = /https?:\/\/\S+|www\.\S+/i;

/**
 * Structural refusals only, never wording or length: empty, or a link. Whether the text
 * asks to add it is the model's own structured `asks_to_add`, held to the offer row in
 * {@link readEmailAlertNotice} — a question with no row behind it makes every bare YES in
 * the household ambiguous (#649), and an offer row with no ask is a CTA nobody saw.
 */
export function emailAlertNoticeRefusals(text: string): string[] {
  const body = text.trim();
  if (body === '') return ['empty'];
  return URL_SHAPE.test(body) ? ['link'] : [];
}

/** The model's `asks_to_add` against the offer row: a fact check, not a punctuation one. */
export function offerMismatch(asksToAdd: boolean, facts: EmailAlertNoticeFacts): string[] {
  if (facts.offer !== null && !asksToAdd) return ['offer_unasked'];
  if (facts.offer === null && asksToAdd) return ['ask_without_offer'];
  return [];
}

export const emailAlertNoticeOutputSchema = z.object({
  reason: z.string(),
  about_the_kids: z.enum(['yes', 'no', 'unsure']),
  clear: z.boolean(),
  text: z.string(),
  asks_to_add: z.boolean(),
});

export type EmailAlertNoticeAnswer = z.infer<typeof emailAlertNoticeOutputSchema>;

export const EMAIL_ALERT_NOTICE_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    reason: { type: 'string' },
    about_the_kids: { type: 'string', enum: ['yes', 'no', 'unsure'] },
    clear: { type: 'boolean' },
    text: { type: 'string' },
    asks_to_add: { type: 'boolean' },
  },
  required: ['reason', 'about_the_kids', 'clear', 'text', 'asks_to_add'],
} as const;

/**
 * What the model's answer means, read the same way by production and by the eval. A
 * refused draft is `null`: the caller may ask again, and after the last attempt it is
 * `unwritten`. "Not about the kids" and "unclear" are the model's own verdicts and final.
 */
export function readEmailAlertNotice(
  answer: EmailAlertNoticeAnswer,
  facts: EmailAlertNoticeFacts,
): { notice: EmailAlertNotice } | { refused: string[] } {
  if (answer.about_the_kids !== 'yes') {
    return { notice: { send: false, why: 'not_about_the_kids' } };
  }
  if (!answer.clear) return { notice: { send: false, why: 'unclear' } };
  const text = answer.text.trim();
  const refusals = [...emailAlertNoticeRefusals(text), ...offerMismatch(answer.asks_to_add, facts)];
  if (refusals.length > 0) return { refused: refusals };
  return { notice: { send: true, text } };
}

export async function composeEmailAlertNotice(
  client: AgentClient,
  facts: EmailAlertNoticeFacts,
  familyId: string,
): Promise<EmailAlertNotice> {
  const unwritten: EmailAlertNotice = { send: false, why: 'unwritten' };
  let skill: Awaited<ReturnType<typeof loadCronSkill>>;
  try {
    skill = await loadCronSkill(EMAIL_ALERT_NOTICE_SKILL);
  } catch (err) {
    console.error(
      { familyId, err: err instanceof Error ? err.name : 'unknown' },
      'email alert: notice skill load failed, nothing sent',
    );
    return unwritten;
  }
  for (let attempt = 1; attempt <= EMAIL_ALERT_NOTICE_MAX_ATTEMPTS; attempt += 1) {
    try {
      const { value } = await forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: emailAlertNoticeUserMessage(facts),
        toolName: EMAIL_ALERT_NOTICE_TOOL,
        toolDescription: EMAIL_ALERT_NOTICE_TOOL_DESCRIPTION,
        inputJsonSchema: EMAIL_ALERT_NOTICE_TOOL_SCHEMA,
        schema: emailAlertNoticeOutputSchema,
        maxTokens: EMAIL_ALERT_NOTICE_MAX_TOKENS,
      });
      const read = readEmailAlertNotice(value, facts);
      if ('notice' in read) return read.notice;
      console.warn({ familyId, attempt, refusals: read.refused }, 'email alert: notice refused');
    } catch (err) {
      console.warn(
        { familyId, attempt, err: err instanceof Error ? err.name : 'unknown' },
        'email alert: notice compose failed',
      );
    }
  }
  console.error({ familyId, outcome: 'notice_unwritten' }, 'email alert: nothing sent');
  return unwritten;
}
