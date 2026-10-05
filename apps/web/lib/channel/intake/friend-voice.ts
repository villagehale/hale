import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import {
  AHA_TIME_ZONE,
  type AhaSnapshot,
  ahaClockLabel,
  ahaWhenLabel,
} from '~/lib/channel/connect/aha-read';
import { type ParentRoleGuess, likelyCoParentRole } from '~/lib/channel/identity/parent-role';
import type { ReplyLanguage } from '~/lib/channel/language';
import { loadOnboardingFriendSkill } from '~/lib/cron/skill';
import { findInventedFacts } from '~/lib/loop/voice/facts-lint';
import { postOpsSlack } from '~/lib/monitoring/ops-slack';
import { forceToolJson } from '~/lib/pipeline/structured';
import { addDaysToKey, dayKeyIn } from '~/lib/plan/spine';
import {
  ONBOARDING_ORDER,
  type OnboardingCapture,
  type OnboardingChecklist,
  type OnboardingItem,
  acceptOnboardingCapture,
  checklistAfter,
  mergeCaptures,
  onboardingMissing,
} from './onboarding-turn';

/**
 * VIL-413 / VIL-417. The onboarding reply, written from a per-step direction.
 *
 * The skill (packages/agent/skills/onboarding-friend.md) holds the directions.
 * This module holds the rules that must not be left to the model: one question,
 * no invented find facts, no compliance wording, no link without a URL, French
 * accents, nothing about a connected source that is not in the kid-only
 * snapshot. A failed, judged-bad, or timed-out compose is retried once on a
 * smaller prompt. If that also fails, nothing canned goes out: the miss is
 * logged, #ops is paged, and the next inbound or the morning nudge tries again.
 */

const MAX_TOKENS = 700;
const SHORT_MAX_TOKENS = 220;
const MAX_PROSE_CHARS = 360;
const MAX_LEAD_CHARS = 160;
const MAX_BODY_CHARS = 1200;
/** How far ahead the model may name a day on the schedule step. */
export const SCHEDULE_DAYS_AHEAD = 21;

/** One model attempt. A hang past this retries on the smaller prompt. */
export const FRIEND_ATTEMPT_TIMEOUT_MS = 12_000;

/**
 * Model instruction for the retry. Not a parent-facing message: the parent
 * only ever sees what the model returns.
 */
const SHORT_FRIEND_SYSTEM = [
  'You are Hale, texting one parent. Write one short warm reply in their language.',
  'Read known, missing, and parentWords. Extract every onboarding item this message gives, in the order listed.',
  'Answer anything that is not one of those items, then ask only the first item still missing. The question is your last sentence. One ask per message.',
  'If nothing is missing, or they asked you to stop, or the step is find_show, connected, or ack, no question mark.',
  'Do not number a list and do not write a URL. Use only facts in the JSON.',
  'Do not invent an activity, a date, a weekday, a time, or a price.',
  'parentRole is your soft read of mother, father, or unknown from their name or words; basis is stated or guessed. Never state it to them as fact.',
  'On the connected step, facts.synced holds only kid-related items. If one is useful, set ahaMention to its exact title or subject and mention only that item. If read is empty, failed, withheld, or none_for_kids, set ahaMention null and do not name an event, a subject, a date, or a time, and do not say the source was empty.',
  'Adding to the calendar is a reminder. Never say booked, enrolled, signed up, or registered.',
  'No STOP, unsubscribe, or compliance wording. No emoji.',
].join(' ');

export const FRIEND_STEPS = [
  'place',
  'place_card',
  'kids_names',
  'ages',
  'find_show',
  'find_empty',
  'names',
  'name_confirm',
  'name_reply',
  'email',
  'calendar',
  'schedule',
  'coparent',
  'signup',
  'age_correction',
  'legacy_hello',
  'nudge_place',
  'nudge_ages',
  'nudge_find',
  'link_retry',
  'help',
  'stop_asking',
  'connected',
  'ack',
] as const;

export type FriendStep = (typeof FRIEND_STEPS)[number];

export type FriendListKind = 'none' | 'week' | 'year';

export type FriendFallback =
  | 'voice_unavailable'
  | 'skill_unavailable'
  | 'model_failed'
  | 'unusable';

export interface FriendTurn {
  role: 'parent' | 'hale';
  body: string;
}

/** One group on the activity map, as code found it. */
export interface FriendFindGroup {
  category: string;
  lines: readonly string[];
}

/** An activity already written to the calendar during this onboarding. */
export interface FriendScheduled {
  title: string;
  when: string;
  cadence: 'once' | 'weekly';
}

export interface FriendVoiceInput {
  step: FriendStep;
  language: ReplyLanguage;
  /** 1:1 is tu. A group thread is vous. */
  address: 'tu' | 'vous';
  introduce: boolean;
  parentWords: string;
  recentTurns: readonly FriendTurn[];
  placeLabel: string | null;
  agesLabel: string | null;
  ageMonths: readonly number[];
  findLines: readonly string[];
  /** year = the kids' year header. week = numbered lines only. */
  listKind: FriendListKind;
  /** The map's groups, on find_show. Lines here are the same as findLines, grouped. */
  findGroups?: readonly FriendFindGroup[];
  activity: string | null;
  day: string | null;
  parentName: string | null;
  /** The soft read of this parent's role, when one is stored. */
  parentRole?: ParentRoleGuess | null;
  /** Which connector just landed. Set only on the connected step. */
  connector?: 'gcal' | 'gmail' | null;
  /** Whether they agreed to be watched. Set only on the ack step. */
  granted?: boolean | null;
  /**
   * Real kid-related items from the connector that just landed. Set only on
   * the connected step. The model chooses at most one. Code does not rank them.
   */
  synced?: AhaSnapshot | null;
  /** The reference instant for today, used on the schedule step. */
  now?: Date;
  /** What is already on the calendar from this onboarding. */
  scheduled?: readonly FriendScheduled[];
  /** Hale's iMessage line and the group trigger phrase, when the co-parent ask is on iMessage. */
  coparentJoin?: { line: string; phrase: string } | null;
  /** Their answer on the co-parent step, for the closing receipt. */
  coparentGroup?: boolean | null;
  /**
   * What is already stored, in onboarding order. Absent on older callers.
   * The model uses it as guidance. Code computes it from stored facts.
   */
  checklist?: OnboardingChecklist;
}

export interface FriendVoiceResult {
  body: string;
  prose: string;
  /** The bubbles to send, in order. One for most steps; two or three on find_show. */
  bubbles: string[];
  source: 'composed' | 'retry' | 'unsent';
  fallback: FriendFallback | null;
  /** Shape-checked fields from the model. Empty when nothing was stored. */
  capture: OnboardingCapture;
}

export interface FriendComposeOptions {
  /** `short` skips the skill and uses the smaller retry prompt. */
  prompt?: 'full' | 'short';
}

export interface FriendComposed {
  reply: string;
  capture?: unknown;
  ahaMention?: string | null;
  /** On find_show: one short lead per group, same order as facts.findGroups. */
  groupLeads?: readonly string[] | null;
}

export interface FriendVoiceComposer {
  compose(input: FriendVoiceInput, options?: FriendComposeOptions): Promise<FriendComposed>;
}

export interface SpeakOptions {
  /** Minted connector URL. Appended by code, never written by the model. */
  link?: string | null;
  /** The connector card will append the URL after this prose is judged. */
  linkFollows?: boolean;
  /**
   * Real data appended under the prose after judging, as its own lines: the
   * co-parent join line and phrase. Never written by the model.
   */
  trailer?: string | null;
  /** `short` is the one smaller retry, used when a list has to be rewritten. */
  prompt?: 'full' | 'short';
  /** Test hook. Production pages Slack #ops. */
  page?: (text: string) => Promise<unknown>;
  /** Test hook. Production uses {@link FRIEND_ATTEMPT_TIMEOUT_MS}. */
  attemptTimeoutMs?: number;
  /**
   * The exact title or subject the model chose to mention. Null means the
   * reply adds no specific from the synced data. Code checks the choice; it
   * does not pick one.
   */
  ahaMention?: string | null;
}

const childSchema = z
  .object({
    name: z.string().nullable().optional().default(null),
    ageMonths: z.number().nullable().optional().default(null),
    agePrecision: z.enum(['years', 'months']).nullable().optional().default(null),
  })
  .strict();

const scheduleAddSchema = z
  .object({
    line: z.number(),
    cadence: z.enum(['once', 'weekly']),
    date: z.string(),
    time: z.string().nullable().optional().default(null),
    weeks: z.number().nullable().optional().default(null),
  })
  .strict();

const replySchema = z
  .object({
    reply: z.string(),
    groupLeads: z.array(z.string()).nullable().optional().default(null),
    postalCode: z.string().nullable().optional().default(null),
    city: z.string().nullable().optional().default(null),
    children: z.array(childSchema).optional().default([]),
    parentName: z.string().nullable().optional().default(null),
    parentRole: z.enum(['mother', 'father', 'unknown']).nullable().optional().default(null),
    parentRoleBasis: z.enum(['stated', 'guessed']).nullable().optional().default(null),
    nameConfirmed: z.boolean().nullable().optional().default(null),
    connectCalendar: z.boolean().nullable().optional().default(null),
    connectGmail: z.boolean().nullable().optional().default(null),
    scheduleAdds: z.array(scheduleAddSchema).optional().default([]),
    scheduleDone: z.boolean().optional().default(false),
    coparentGroup: z.boolean().nullable().optional().default(null),
    nameDeclined: z.boolean().optional().default(false),
    kidsNamesDeclined: z.boolean().optional().default(false),
    calendarLater: z.boolean().optional().default(false),
    gmailLater: z.boolean().optional().default(false),
    stopAsking: z.boolean().optional().default(false),
    ahaMention: z.string().nullable().optional().default(null),
  })
  .strict();

const replyJsonSchema = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    groupLeads: { type: ['array', 'null'], items: { type: 'string' } },
    postalCode: { type: ['string', 'null'] },
    city: { type: ['string', 'null'] },
    children: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: ['string', 'null'] },
          ageMonths: { type: ['number', 'null'] },
          agePrecision: { type: ['string', 'null'], enum: ['years', 'months', null] },
        },
      },
    },
    parentName: { type: ['string', 'null'] },
    parentRole: { type: ['string', 'null'], enum: ['mother', 'father', 'unknown', null] },
    parentRoleBasis: { type: ['string', 'null'], enum: ['stated', 'guessed', null] },
    nameConfirmed: { type: ['boolean', 'null'] },
    connectCalendar: { type: ['boolean', 'null'] },
    connectGmail: { type: ['boolean', 'null'] },
    scheduleAdds: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          line: { type: 'number' },
          cadence: { type: 'string', enum: ['once', 'weekly'] },
          date: { type: 'string' },
          time: { type: ['string', 'null'] },
          weeks: { type: ['number', 'null'] },
        },
        required: ['line', 'cadence', 'date'],
      },
    },
    scheduleDone: { type: 'boolean' },
    coparentGroup: { type: ['boolean', 'null'] },
    nameDeclined: { type: 'boolean' },
    kidsNamesDeclined: { type: 'boolean' },
    calendarLater: { type: 'boolean' },
    gmailLater: { type: 'boolean' },
    stopAsking: { type: 'boolean' },
    ahaMention: { type: ['string', 'null'] },
  },
  required: ['reply'],
} as const;

const BANNED_PHRASE =
  /reply with the number you want|text me if that changes|i['’]ll note it|i['’]ll keep track|je le note|reponds avec le numero|réponds avec le numéro/i;

const COMPLIANCE =
  /unsubscribe|d[ée]sabonner|reply stop|r[ée]pondez arret|r[ée]pondez stop|\bSTOP\b/;

/** Adding to the calendar is a reminder. These words claim a registration Hale did not make. */
const REGISTRATION_CLAIM =
  /\b(booked|enrolled|signed (?:you|them|her|him) up|registered (?:you|them|her|him)|you're registered|inscrit[es]?\b|réservé)\b/i;

const ACTIVITY_WORD =
  /\b(swims?|swimming|soccer|gym|gymnastics|librar(?:y|ies)|zoo|museum|hockey|dance|ballet|music|storytime|story time|camps?|daycare|earlyon|farm|natation)\b/gi;

const WEEKDAY =
  /\b(mon|tues|wednes|thurs|fri|satur|sun)days?\b|\b(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b/gi;

const PRICE = /\$\s?\d+(?:\.\d{2})?/g;

/** ASCII stand-ins for accented words. A following letter (é in adapté) is not a gap. */
const FRENCH_ASCII_GAP = /\b(?:pres|age|adapt|prenoms?|ecole|ca|numero|reponds)(?![\p{L}])/iu;

const DANGLING_LINK = /\bthis link\b|\bce lien\b/i;

/** Steps that end with no question. find_show shows; the name ask is the next bubble. */
const ZERO_QUESTION_STEPS = new Set<FriendStep>(['stop_asking', 'connected', 'ack', 'find_show']);

/**
 * Steps that may end with no question or with one: the receipt for a name, or
 * the one ask again when they turned the held name down.
 */
const FLEX_QUESTION_STEPS = new Set<FriendStep>(['name_reply']);

/** Steps where the model may say "this link": the real URL follows. */
const LINK_STEPS = new Set<FriendStep>(['calendar', 'email']);

export function turnsFromTranscript(
  transcript: readonly { direction: 'in' | 'out'; body: string }[],
): FriendTurn[] {
  return transcript.slice(-8).map((entry) => ({
    role: entry.direction === 'in' ? 'parent' : 'hale',
    body: entry.body,
  }));
}

interface DayLabel {
  date: string;
  label: string;
}

function dayLabel(dayKey: string, language: ReplyLanguage): string {
  const [year, month, day] = dayKey.split('-').map((part) => Number(part));
  if (!year || !month || !day) return dayKey;
  return new Intl.DateTimeFormat(language === 'fr' ? 'fr-CA' : 'en-CA', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

/** Today and the next three weeks, as the only dates the model may name. */
export function upcomingDays(now: Date, language: ReplyLanguage): DayLabel[] {
  const today = dayKeyIn(now, AHA_TIME_ZONE);
  const days: DayLabel[] = [];
  for (let offset = 0; offset <= SCHEDULE_DAYS_AHEAD; offset += 1) {
    const date = addDaysToKey(today, offset);
    days.push({ date, label: dayLabel(date, language) });
  }
  return days;
}

/** What the model is handed. No link, no family id, no phone. */
export function friendVoiceContext(input: FriendVoiceInput): unknown {
  const checklist = input.checklist ?? null;
  const now = input.now ?? null;
  const today = now ? dayKeyIn(now, AHA_TIME_ZONE) : null;
  return {
    step: input.step,
    language: input.language,
    address: input.address,
    introduce: input.introduce,
    parentWords: input.parentWords,
    recentTurns: input.recentTurns,
    order: [...ONBOARDING_ORDER],
    known: checklist,
    missing: checklist ? onboardingMissing(checklist) : null,
    facts: {
      placeLabel: input.placeLabel,
      agesLabel: input.agesLabel,
      ageMonths: input.ageMonths,
      findLines: input.findLines,
      findGroups: input.findGroups ?? null,
      activity: input.activity,
      day: input.day,
      parentName: input.parentName,
      parentRole: input.parentRole ?? null,
      coParentRoleLikely: likelyCoParentRole(input.parentRole),
      connector: input.connector ?? null,
      granted: input.granted ?? null,
      synced: syncedForModel(input),
      today: today ? { date: today, label: dayLabel(today, input.language) } : null,
      upcomingDays: input.step === 'schedule' && now ? upcomingDays(now, input.language) : null,
      scheduled: input.scheduled ?? [],
      coparentJoin: input.coparentJoin ?? null,
      coparentGroup: input.coparentGroup ?? null,
    },
  };
}

/** Labels the model may quote. Both languages are slots, so a French reply can name samedi. */
function syncedForModel(input: FriendVoiceInput): unknown {
  const synced = input.synced;
  if (!synced) return null;
  return {
    read: synced.read,
    calendar: synced.calendar.map((item) => ({
      title: item.title,
      when: ahaWhenLabel(item.start, item.allDay, AHA_TIME_ZONE, input.language),
      clock: item.allDay ? null : ahaClockLabel(item.start, AHA_TIME_ZONE),
      location: item.location,
      declined: item.declined,
    })),
    email: synced.email.map((item) => ({
      subject: item.subject,
      fromName: item.fromName,
      when: item.receivedAt
        ? ahaWhenLabel(item.receivedAt, false, AHA_TIME_ZONE, input.language)
        : null,
      snippet: item.snippet,
    })),
    overlaps: synced.overlaps,
  };
}

export function friendFactSlots(input: FriendVoiceInput, link?: string | null): string[] {
  const slots = [input.parentWords, input.agesLabel ?? '', input.placeLabel ?? ''];
  for (const turn of input.recentTurns) slots.push(turn.body);
  for (const line of input.findLines) slots.push(line);
  for (const group of input.findGroups ?? []) for (const line of group.lines) slots.push(line);
  for (const months of input.ageMonths) slots.push(String(months));
  if (input.activity) slots.push(input.activity);
  if (input.day) slots.push(input.day);
  if (input.parentName) slots.push(input.parentName);
  if (input.connector === 'gcal') slots.push('calendar', 'calendrier');
  if (input.connector === 'gmail') slots.push('gmail', 'Gmail');
  if (link) slots.push(link);
  if (input.coparentJoin) slots.push(input.coparentJoin.line, input.coparentJoin.phrase);
  for (const item of input.scheduled ?? []) slots.push(item.title, item.when);
  if (input.now) {
    for (const day of upcomingDays(input.now, 'en')) slots.push(day.label);
    for (const day of upcomingDays(input.now, 'fr')) slots.push(day.label);
  }
  for (const slot of syncedFactSlots(input)) slots.push(slot);
  return slots.filter((slot) => slot.length > 0);
}

function syncedFactSlots(input: FriendVoiceInput): string[] {
  const synced = input.synced;
  if (!synced) return [];
  const slots: string[] = [];
  for (const item of synced.calendar) {
    slots.push(item.title);
    if (item.location) slots.push(item.location);
    slots.push(ahaWhenLabel(item.start, item.allDay, AHA_TIME_ZONE, 'en'));
    slots.push(ahaWhenLabel(item.start, item.allDay, AHA_TIME_ZONE, 'fr'));
    const clock = item.allDay ? null : ahaClockLabel(item.start, AHA_TIME_ZONE);
    if (clock) slots.push(clock);
  }
  for (const item of synced.email) {
    slots.push(item.subject);
    if (item.fromName) slots.push(item.fromName);
    if (item.snippet) slots.push(item.snippet);
    if (item.receivedAt) {
      slots.push(ahaWhenLabel(item.receivedAt, false, AHA_TIME_ZONE, 'en'));
      slots.push(ahaWhenLabel(item.receivedAt, false, AHA_TIME_ZONE, 'fr'));
      const clock = ahaClockLabel(item.receivedAt, AHA_TIME_ZONE);
      if (clock) slots.push(clock);
    }
  }
  return slots;
}

/**
 * Activities wait until ages are known. A week list is never the ages ask.
 */
export function friendWeekAction(agesKnown: boolean, _lineCount: number): 'skip' | 'ask_ages' {
  return agesKnown ? 'skip' : 'ask_ages';
}

export function numberedFindLines(lines: readonly string[], from = 1): string {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => `${from + index}. ${line}`)
    .join('\n');
}

/**
 * Split model prose so the question can sit under a list. A question with no
 * earlier sentence stays whole, as the last line.
 */
export function peelFriendAsk(prose: string): { lead: string; ask: string } {
  const trimmed = prose.trim();
  const mark = trimmed.indexOf('?');
  if (mark < 0) return { lead: trimmed, ask: '' };
  const before = trimmed.slice(0, mark);
  let splitAt = -1;
  for (let i = before.length - 1; i >= 0; i--) {
    const char = before[i];
    if (char === '.' || char === '!' || char === '\n') {
      splitAt = i;
      break;
    }
  }
  if (splitAt < 0) return { lead: '', ask: trimmed };
  return {
    lead: trimmed.slice(0, splitAt + 1).trim(),
    ask: trimmed.slice(splitAt + 1).trim(),
  };
}

/**
 * The activity map as bubbles: the model's opener, then one bubble per group
 * with the model's lead over the real numbered lines. Numbers run across the
 * whole map so a later "number 4" points at one line. A missing lead leaves
 * the lines on their own; a lead is never invented by code.
 */
export function assembleFindShowBubbles(
  opener: string,
  groups: readonly FriendFindGroup[],
  leads: readonly string[] | null | undefined,
): string[] {
  const bubbles: string[] = [];
  const lead = opener.trim();
  if (lead.length > 0) bubbles.push(lead);
  let from = 1;
  groups.forEach((group, index) => {
    const lines = group.lines.map((line) => line.trim()).filter((line) => line.length > 0);
    if (lines.length === 0) return;
    const head = (leads?.[index] ?? '').trim();
    const numbered = numberedFindLines(lines, from);
    from += lines.length;
    bubbles.push(head.length > 0 ? `${head}\n${numbered}` : numbered);
  });
  return bubbles;
}

export function assembleFriendBody(
  prose: string,
  input: Pick<FriendVoiceInput, 'language' | 'findLines' | 'listKind'>,
  link?: string | null,
  trailer?: string | null,
): string {
  const trimmed = prose.trim();
  const lines = input.findLines.map((line) => line.trim()).filter((line) => line.length > 0);
  let body = trimmed;
  if (lines.length > 0 && input.listKind !== 'none') {
    const { lead, ask } = peelFriendAsk(trimmed);
    const parts: string[] = [];
    if (lead.length > 0) parts.push(lead);
    const numbered = numberedFindLines(lines.slice(0, 3));
    if (numbered.length > 0) parts.push(numbered);
    if (ask.length > 0) parts.push(ask);
    body = parts.join('\n');
  }
  if (typeof trailer === 'string' && trailer.trim().length > 0) body = `${body}\n${trailer.trim()}`;
  if (typeof link === 'string' && link.startsWith('https://')) body = `${body}\n${link}`;
  return body;
}

function questionMarks(text: string): number {
  const prose = text.replace(/https?:\/\/\S+/g, '');
  return [...prose].filter((char) => char === '?').length;
}

function questionsBeyondFacts(body: string, facts: readonly string[]): number {
  const inFacts = facts.reduce((count, line) => count + questionMarks(line), 0);
  return questionMarks(body) - inFacts;
}

function mentionsOutsideSlots(text: string, pattern: RegExp, slots: readonly string[]): string[] {
  const found = text.match(pattern) ?? [];
  const unique = [...new Set(found.map((token) => token.toLowerCase()))];
  return unique.filter((token) => !slots.some((slot) => slot.toLowerCase().includes(token)));
}

/** The one question ends the message. A URL or trailer code appended after it does not count. */
export function questionIsLast(body: string, trailer?: string | null): boolean {
  let withoutUrl = body.replace(/\nhttps:\/\/\S+\s*$/u, '').trim();
  if (trailer && withoutUrl.endsWith(trailer.trim())) {
    withoutUrl = withoutUrl.slice(0, withoutUrl.length - trailer.trim().length).trim();
  }
  const mark = withoutUrl.lastIndexOf('?');
  if (mark < 0) return false;
  if (withoutUrl.slice(mark + 1).trim().length > 0) return false;
  const before = withoutUrl
    .slice(0, mark)
    .split('\n')
    .filter((line) => !/^\d+\.\s/u.test(line.trim()));
  return !before.join('\n').includes('?');
}

export type FriendJudgeFailure =
  | 'empty'
  | 'long'
  | 'question'
  | 'banned'
  | 'compliance'
  | 'invented'
  | 'french'
  | 'link'
  | 'registration_claim';

function trailerFacts(options: SpeakOptions): string[] {
  return options.trailer ? [options.trailer] : [];
}

export function judgeFriendReply(
  body: string,
  input: FriendVoiceInput,
  options: SpeakOptions = {},
): { ok: true } | { ok: false; reason: FriendJudgeFailure } {
  const trimmed = body.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };
  if (trimmed.length > MAX_BODY_CHARS) return { ok: false, reason: 'long' };
  const needed = ZERO_QUESTION_STEPS.has(input.step) ? 0 : 1;
  const groupLines = (input.findGroups ?? []).flatMap((group) => group.lines);
  const asked = questionsBeyondFacts(trimmed, [
    ...input.findLines,
    ...groupLines,
    ...trailerFacts(options),
  ]);
  if (FLEX_QUESTION_STEPS.has(input.step)) {
    if (asked > 1) return { ok: false, reason: 'question' };
  } else if (asked !== needed) {
    return { ok: false, reason: 'question' };
  }
  if (asked === 1 && !questionIsLast(trimmed, options.trailer)) {
    return { ok: false, reason: 'question' };
  }
  if (BANNED_PHRASE.test(trimmed)) return { ok: false, reason: 'banned' };
  if (COMPLIANCE.test(trimmed)) return { ok: false, reason: 'compliance' };
  if (REGISTRATION_CLAIM.test(trimmed)) return { ok: false, reason: 'registration_claim' };

  const slots = friendFactSlots(input, options.link);
  for (const fact of trailerFacts(options)) slots.push(fact);
  if (findInventedFacts(trimmed, slots).length > 0) return { ok: false, reason: 'invented' };
  if (mentionsOutsideSlots(trimmed, PRICE, slots).length > 0) {
    return { ok: false, reason: 'invented' };
  }
  if (mentionsOutsideSlots(trimmed, WEEKDAY, slots).length > 0) {
    return { ok: false, reason: 'invented' };
  }
  if (input.step !== 'email' && mentionsOutsideSlots(trimmed, ACTIVITY_WORD, slots).length > 0) {
    return { ok: false, reason: 'invented' };
  }
  if (/https?:\/\//i.test(trimmed)) {
    const allowed = options.link && trimmed.includes(options.link);
    if (!allowed) return { ok: false, reason: 'invented' };
  }

  if (input.language === 'fr') {
    if (FRENCH_ASCII_GAP.test(trimmed)) return { ok: false, reason: 'french' };
    if (input.address === 'tu' && /\b(vous|votre|vos)\b/i.test(trimmed)) {
      return { ok: false, reason: 'french' };
    }
    if (input.address === 'vous' && /\b(tu|toi|ton|ta|tes)\b/i.test(trimmed)) {
      return { ok: false, reason: 'french' };
    }
  }

  if (DANGLING_LINK.test(trimmed)) {
    const attached = Boolean(options.link && trimmed.includes(options.link));
    if (!attached && !options.linkFollows) return { ok: false, reason: 'link' };
    if (!LINK_STEPS.has(input.step) && !attached) return { ok: false, reason: 'link' };
  }

  if (input.step === 'find_empty' && /^\s*\d+\.\s/m.test(trimmed)) {
    return { ok: false, reason: 'invented' };
  }
  if (input.step === 'connected') {
    const named = options.ahaMention?.trim() ?? '';
    const outside = named.length > 0 ? trimmed.replace(named, ' ') : trimmed;
    const namesGmail = /\bgmail\b/i.test(outside);
    const namesCalendar = /\b(calendar|calendrier|agenda)\b/i.test(outside);
    if (input.connector === 'gcal' && namesGmail) return { ok: false, reason: 'invented' };
    if (input.connector === 'gmail' && namesCalendar) return { ok: false, reason: 'invented' };
    const grounded = ahaGrounding(trimmed, input, named);
    if (grounded) return { ok: false, reason: grounded };
  }
  return { ok: true };
}

function ahaTitles(input: FriendVoiceInput): string[] {
  const synced = input.synced;
  if (!synced) return [];
  return [
    ...synced.calendar.map((item) => item.title),
    ...synced.email.map((item) => item.subject),
  ];
}

function overlapPartners(input: FriendVoiceInput, named: string): Set<string> {
  const partners = new Set<string>();
  for (const pair of input.synced?.overlaps ?? []) {
    if (pair.earlier === named) partners.add(pair.later);
    if (pair.later === named) partners.add(pair.earlier);
  }
  return partners;
}

/** A snippet this long, copied whole, is the email quoted verbatim. */
const VERBATIM_SNIPPET_CHARS = 40;

/**
 * A declared mention must be one exact synced title or subject, and the reply
 * must contain it. Any other title is an extra fact, unless the snapshot's
 * overlap list pairs the two. No mention means no title: nothing extra. A
 * read with nothing kid-related allows no mention at all. An email is never
 * quoted verbatim.
 */
function ahaGrounding(
  body: string,
  input: FriendVoiceInput,
  named: string,
): FriendJudgeFailure | null {
  if (!input.synced) return null;
  const titles = ahaTitles(input);
  for (const item of input.synced.email) {
    const snippet = item.snippet?.trim() ?? '';
    if (snippet.length >= VERBATIM_SNIPPET_CHARS && body.includes(snippet)) return 'invented';
  }
  if (named.length > 0) {
    if (input.synced.read !== 'ok') return 'invented';
    if (!titles.includes(named)) return 'invented';
    if (!body.includes(named)) return 'invented';
    const partners = overlapPartners(input, named);
    for (const title of titles) {
      if (title === named || partners.has(title)) continue;
      if (named.includes(title) || title.includes(named)) continue;
      if (body.includes(title)) return 'invented';
    }
    return null;
  }
  for (const title of titles) {
    if (title.length >= 3 && body.includes(title)) return 'invented';
  }
  return null;
}

class FriendAttemptTimeout extends Error {
  constructor() {
    super('onboarding-friend: attempt timed out');
    this.name = 'FriendAttemptTimeout';
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return work;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new FriendAttemptTimeout()), ms);
    if (typeof timer.unref === 'function') timer.unref();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function unsent(reason: FriendFallback): FriendVoiceResult {
  return {
    body: '',
    prose: '',
    bubbles: [],
    source: 'unsent',
    fallback: reason,
    capture: acceptOnboardingCapture(null),
  };
}

/** The step a reply is written for, once this message's facts are counted. */
export function stepAfterCapture(current: FriendStep, gap: OnboardingItem | undefined): FriendStep {
  switch (gap) {
    case 'postal':
      return current === 'place_card' ? 'place_card' : 'place';
    case 'kids':
      return 'kids_names';
    case 'ages':
      return 'ages';
    case 'name':
      return current === 'find_empty' || current === 'name_confirm' ? current : 'names';
    case 'gmail':
      return 'email';
    case 'calendar':
      return 'calendar';
    case 'schedule':
      return 'schedule';
    case 'coparent':
      return 'coparent';
    default:
      return current;
  }
}

/**
 * The judge sees the step the reply was written for. A yes that finishes the
 * current ask is judged as the next gap, so the pull-back is not graded against
 * the question that just got answered. A finished ladder or a stop is a receipt.
 */
function judgeInputFor(input: FriendVoiceInput, capture: OnboardingCapture): FriendVoiceInput {
  if (input.step === 'find_show' || input.step === 'connected') return input;
  if (!input.checklist && !capture.stopAsking) return input;
  const remaining = input.checklist
    ? onboardingMissing(checklistAfter(input.checklist, capture))
    : [];
  if (capture.stopAsking || (input.checklist != null && remaining.length === 0)) {
    return { ...input, step: capture.stopAsking ? 'stop_asking' : 'ack' };
  }
  const step = stepAfterCapture(input.step, remaining[0]);
  return step === input.step ? input : { ...input, step };
}

/** Step and reason only. Parent words stay out of #ops. */
function unsentPage(step: FriendStep, reason: FriendFallback): string {
  return `onboarding friend voice unsent step=${step} reason=${reason}`;
}

function scheduleLimits(input: FriendVoiceInput) {
  return {
    findLineCount: input.findLines.length,
    today: input.now ? dayKeyIn(input.now, AHA_TIME_ZONE) : null,
  };
}

export async function speakFriend(
  composer: FriendVoiceComposer | undefined,
  input: FriendVoiceInput,
  options: SpeakOptions = {},
): Promise<FriendVoiceResult> {
  const finish = (
    prose: string,
    bubbles: string[],
    source: FriendVoiceResult['source'],
    capture: OnboardingCapture,
  ): FriendVoiceResult => {
    const body =
      input.step === 'find_show'
        ? bubbles.join('\n\n')
        : assembleFriendBody(prose, input, options.link, options.trailer);
    return {
      body,
      prose: prose.trim(),
      bubbles: input.step === 'find_show' ? bubbles : [body],
      source,
      fallback: null,
      capture,
    };
  };

  const page = async (reason: FriendFallback): Promise<void> => {
    const text = unsentPage(input.step, reason);
    console.error({ fallback: reason, step: input.step }, 'onboarding-friend: reply not sent');
    try {
      await (options.page ?? postOpsSlack)(text);
    } catch (err) {
      console.error(
        { err: err instanceof Error ? err.name : 'unknown', step: input.step },
        'onboarding-friend: ops page failed',
      );
    }
  };

  if (!composer) {
    await page('voice_unavailable');
    return unsent('voice_unavailable');
  }

  const timeoutMs = options.attemptTimeoutMs ?? FRIEND_ATTEMPT_TIMEOUT_MS;

  const attempt = async (
    prompt: 'full' | 'short',
  ): Promise<
    | { prose: string; bubbles: string[]; capture: OnboardingCapture }
    | { fail: FriendFallback; capture: OnboardingCapture }
  > => {
    const empty = acceptOnboardingCapture(null);
    try {
      const composed = await withTimeout(composer.compose(input, { prompt }), timeoutMs);
      const capture = acceptOnboardingCapture(composed.capture, scheduleLimits(input));
      const prose = composed.reply.trim();
      if (prose.length > MAX_PROSE_CHARS) return { fail: 'unusable', capture };
      let bubbles: string[] = [];
      let judgedText: string;
      if (input.step === 'find_show') {
        const groups = input.findGroups ?? [];
        const leads = composed.groupLeads ?? null;
        if (leads?.some((lead) => lead.trim().length > MAX_LEAD_CHARS)) {
          return { fail: 'unusable', capture };
        }
        bubbles = assembleFindShowBubbles(prose, groups, leads);
        if (bubbles.length === 0) return { fail: 'unusable', capture };
        judgedText = bubbles.join('\n\n');
      } else {
        if (prose.length === 0) return { fail: 'unusable', capture };
        judgedText = assembleFriendBody(prose, input, options.link, options.trailer);
      }
      const judged = judgeFriendReply(judgedText, judgeInputFor(input, capture), {
        ...options,
        ahaMention: composed.ahaMention ?? null,
      });
      if (!judged.ok) {
        console.error(
          { reason: judged.reason, step: input.step, prompt },
          'onboarding-friend: unusable reply',
        );
        return { fail: 'unusable', capture };
      }
      return { prose, bubbles, capture };
    } catch (err) {
      console.error(
        {
          err: err instanceof Error ? err.name : 'unknown',
          step: input.step,
          prompt,
        },
        'onboarding-friend: compose failed',
      );
      return { fail: 'model_failed', capture: empty };
    }
  };

  const firstPrompt = options.prompt === 'short' ? 'short' : 'full';
  const first = await attempt(firstPrompt);
  if ('prose' in first) {
    return finish(
      first.prose,
      first.bubbles,
      firstPrompt === 'short' ? 'retry' : 'composed',
      first.capture,
    );
  }

  if (firstPrompt === 'short') {
    await page(first.fail);
    return unsent(first.fail);
  }

  const second = await attempt('short');
  const capture =
    'capture' in second ? mergeCaptures(first.capture, second.capture) : first.capture;
  if ('prose' in second) return finish(second.prose, second.bubbles, 'retry', capture);
  await page(second.fail);
  return { ...unsent(second.fail), capture };
}

export function createFriendVoiceComposer(client: AgentClient | null): FriendVoiceComposer {
  return {
    async compose(input, options) {
      if (!client) throw new Error('onboarding-friend: voice_unavailable');
      const short = options?.prompt === 'short';
      const skill = short ? null : await loadOnboardingFriendSkill();
      const { value } = await forceToolJson({
        client,
        lane: pickLane(skill?.meta.task ?? 'speak'),
        system: skill?.instructions ?? SHORT_FRIEND_SYSTEM,
        userMessage: JSON.stringify(friendVoiceContext(input)),
        toolName: 'reply',
        toolDescription: 'Return the onboarding reply and any facts the parent just gave.',
        inputJsonSchema: replyJsonSchema,
        schema: replySchema,
        maxTokens: short ? SHORT_MAX_TOKENS : MAX_TOKENS,
        transport: 'stream',
      });
      return {
        reply: value.reply,
        groupLeads: value.groupLeads,
        capture: {
          postalCode: value.postalCode,
          city: value.city,
          children: value.children,
          parentName: value.parentName,
          parentRole: value.parentRole,
          parentRoleBasis: value.parentRoleBasis,
          nameConfirmed: value.nameConfirmed,
          connectCalendar: value.connectCalendar,
          connectGmail: value.connectGmail,
          scheduleAdds: value.scheduleAdds,
          scheduleDone: value.scheduleDone,
          coparentGroup: value.coparentGroup,
          nameDeclined: value.nameDeclined,
          kidsNamesDeclined: value.kidsNamesDeclined,
          calendarLater: value.calendarLater,
          gmailLater: value.gmailLater,
          stopAsking: value.stopAsking,
        },
        ahaMention: value.ahaMention,
      };
    },
  };
}
