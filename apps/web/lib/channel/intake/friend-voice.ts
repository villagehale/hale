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
import { inProactiveQuietHours } from '~/lib/channel/outbound-gate';
import { loadOnboardingFriendShortSkill, loadOnboardingFriendSkill } from '~/lib/cron/skill';
import { findInventedFacts } from '~/lib/loop/voice/facts-lint';
import { postOpsSlack } from '~/lib/monitoring/ops-slack';
import { forceToolJson, llmTransport } from '~/lib/pipeline/structured';
import { addDaysToKey, dayKeyIn } from '~/lib/plan/spine';
import type { RateLimiter } from '~/lib/rate-limit/limiter';
import { HALE_IDENTITY, NAMES_HALE_COMPANY, isIdentityChallenge } from './identity-challenge';
import {
  type CoparentGroupMode,
  ONBOARDING_ORDER,
  type OnboardingCapture,
  type OnboardingChecklist,
  type OnboardingItem,
  type ScheduleLimits,
  acceptOnboardingCapture,
  checklistAfter,
  countRejectedScheduleAdds,
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
 * smaller prompt that still names the step
 * (packages/agent/skills/onboarding-friend-short.md). If that also fails,
 * nothing canned goes out: the miss is logged, #ops is paged, and the next
 * inbound or the morning nudge tries again. The one exception is the map:
 * the activity lines are real data code found, so they go out numbered on
 * their own when both openers fail.
 */

/**
 * The reply plus the capture fields, as one forced tool call. The map turn
 * returns an opener, up to three leads and the kids; a cut-off at max_tokens
 * is a failed attempt, so the budget is well over what a good reply uses.
 */
const MAX_TOKENS = 1000;
const SHORT_MAX_TOKENS = 600;
/** A text bubble. Longer than this reads as a letter, not a text. */
export const MAX_PROSE_CHARS = 220;
const MAP_OPENER_CHARS = 120;

/** What a worried parent wants to hear and Hale cannot say: Google shares all of it. */
const ACCESS_UNTRUE = [
  "Hale only reads, sees, or looks at the kids' emails or events",
  'Hale never sees work or personal email',
  'it is connected before they tap the link',
] as const;

/** The true access lines for a connector ask, as facts the model words itself. */
const ACCESS_FACTS = {
  email: [
    'Google shares the whole inbox with Hale',
    'Hale keeps and uses only what is about the kids',
    'Hale never sends email',
    'they can disconnect any time',
  ],
  calendar: [
    'Google shares the whole calendar with Hale',
    'Hale keeps and uses only what is about the kids',
    'Hale never changes or deletes their events',
    'they can disconnect any time',
  ],
} as const;
const MAX_LEAD_CHARS = 160;
const MAX_BODY_CHARS = 1200;
/** How far ahead the model may name a day on the schedule step. */
export const SCHEDULE_DAYS_AHEAD = 21;

/** One model attempt. A hang past this retries on the smaller prompt. */
export const FRIEND_ATTEMPT_TIMEOUT_MS = 12_000;

/**
 * One model attempt on a new parent's opening turn. Both attempts together stay under
 * ten seconds, so a parent texting Hale for the first time is not left holding the
 * phone for two full attempts; a turn that still sends nothing is owed its reply by the
 * first-reply sweep a minute later (first-reply-recovery.ts), which has the full budget.
 */
export const OPENING_ATTEMPT_TIMEOUT_MS = 4_500;

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

/** One kid as stored: name and age, either may still be unknown. */
export interface FriendChild {
  name: string | null;
  ageMonths: number | null;
}

/** An activity already written to the calendar during this onboarding. */
export interface FriendScheduled {
  /** The map line it came from, 1-based, when known. */
  line?: number;
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
  /** Each kid by name and age, so a line's age fit can be matched to the right kid. */
  children?: readonly FriendChild[];
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
  /** On the retry only: the draft that was not sent and why, so the second try fixes that. */
  retry?: { draft: string; problem: string } | null;
  /**
   * How long ago the parent's last inbound was, when this reply is picking it up
   * after a real wait. Absent when that text just arrived. Facts only.
   */
  lastInbound?: LastInboundFact | null;
}

/**
 * Facts about the parent's last inbound, for a reply that is no longer instant.
 * `minutesAgo` is the wait. `overnight` means that text landed inside proactive
 * quiet hours. `yesterday` means its Toronto calendar day is already over.
 */
export interface LastInboundFact {
  minutesAgo: number;
  overnight: boolean;
  yesterday: boolean;
}

export interface FriendVoiceResult {
  body: string;
  prose: string;
  /** The bubbles to send, in order. One for most steps; two or three on find_show. */
  bubbles: string[];
  /**
   * `lines` is the map with no opener: both attempts failed, so the real
   * numbered lines go out on their own and `fallback` says why. Only find_show.
   */
  source: 'composed' | 'retry' | 'lines' | 'unsent';
  fallback: FriendFallback | null;
  /** The step the reply was judged for, once this message's facts were counted. */
  step: FriendStep;
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
  /**
   * The connector card will append the URL after this prose is judged. A
   * function answers per judged step: the card rides only the ask for its own
   * connector, so a reply judged as another step carries no link.
   */
  linkFollows?: boolean | ((step: FriendStep) => boolean);
  /** The card for this step is already on the thread, so "the link above" is true. */
  linkAbove?: boolean;
  /**
   * The reply will not be sent whatever it says (the turn hands over to the
   * map). The first draft's capture is taken as is: no judging, no retry, no page.
   */
  replyDiscardedWhen?: (capture: OnboardingCapture) => boolean;
  /**
   * Real data appended under the prose after judging, as its own lines: the
   * co-parent join line and phrase. Never written by the model.
   */
  trailer?: string | null;
  /** `short` is the one smaller retry, used when a list has to be rewritten. */
  prompt?: 'full' | 'short';
  /** Test hook. Production pages Slack #ops. */
  page?: (text: string) => Promise<unknown>;
  /** Per attempt. Absent is {@link FRIEND_ATTEMPT_TIMEOUT_MS}; the opening turn passes
   * {@link OPENING_ATTEMPT_TIMEOUT_MS}. */
  attemptTimeoutMs?: number;
  /**
   * The exact title or subject the model chose to mention. Null means the
   * reply adds no specific from the synced data. Code checks the choice; it
   * does not pick one.
   */
  ahaMention?: string | null;
  /**
   * The parent just said yes to the connector this reply is for. The card is
   * already on the thread or rides this reply, so the reply may ask nothing.
   */
  yesToLink?: boolean;
  /** This reply records schedule adds: a plain confirmation needs no question. */
  scheduleRecorded?: boolean;
}

/** The judge sees the link decision already made for the step it judges. */
type JudgeOptions = Omit<SpeakOptions, 'linkFollows'> & {
  linkFollows?: boolean;
};

const childSchema = z.object({
  name: z.string().nullable().optional().default(null),
  ageMonths: z.number().nullable().optional().default(null),
  agePrecision: z.enum(['years', 'months']).nullable().optional().default(null),
});

const scheduleAddSchema = z.object({
  line: z.number(),
  cadence: z.enum(['once', 'weekly']),
  date: z.string(),
  time: z.string().nullable().optional().default(null),
  weeks: z.number().nullable().optional().default(null),
  child: z.string().nullable().optional().default(null),
});

function leadText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    for (const key of ['lead', 'text', 'groupLead', 'intro']) {
      if (typeof row[key] === 'string') return row[key] as string;
    }
  }
  return '';
}

/** A list the model wrote as JSON text inside a string, split back into its leads. */
function splitLeadString(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(leadText);
    } catch {
      // Not JSON after all; split it below.
    }
  }
  return trimmed
    .split(/"\s*,\s*"|\n+/u)
    .map((part) => part.replace(/^[\s["]+|[\s\]"]+$/gu, '').trim());
}

function leadsFrom(value: unknown): string[] | null {
  if (value == null) return null;
  if (typeof value === 'string') return splitLeadString(value);
  if (Array.isArray(value)) return value.flatMap((item) => splitLeadString(leadText(item)));
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap((item) =>
      splitLeadString(leadText(item)),
    );
  }
  return null;
}

const replySchema = z.object({
  reply: z
    .string()
    .nullish()
    .transform((value) => value ?? ''),
  // Leads come back in more than one shape (a list, one string per line, the
  // group objects they were written for); their words are the leads.
  groupLeads: z
    .unknown()
    .optional()
    .transform((value) => leadsFrom(value)),
  // A malformed field reads as not given: a decision is never guessed from it.
  // Schedule adds stay strict, so a reply never confirms an add that was dropped.
  postalCode: z.string().nullable().optional().default(null).catch(null),
  city: z.string().nullable().optional().default(null).catch(null),
  children: z.array(childSchema).optional().default([]).catch([]),
  parentName: z.string().nullable().optional().default(null).catch(null),
  parentRole: z
    .enum(['mother', 'father', 'unknown'])
    .nullable()
    .optional()
    .default(null)
    .catch(null),
  parentRoleBasis: z.enum(['stated', 'guessed']).nullable().optional().default(null).catch(null),
  nameConfirmed: z.boolean().nullable().optional().default(null).catch(null),
  connectCalendar: z.boolean().nullable().optional().default(null).catch(null),
  connectGmail: z.boolean().nullable().optional().default(null).catch(null),
  scheduleAdds: z.array(scheduleAddSchema).optional().default([]),
  scheduleDone: z.boolean().optional().default(false).catch(false),
  coparentGroup: z.boolean().nullable().optional().default(null).catch(null),
  coparentGroupMode: z.enum(['existing', 'new']).nullable().optional().default(null).catch(null),
  nameDeclined: z.boolean().optional().default(false).catch(false),
  kidsNamesDeclined: z.boolean().optional().default(false).catch(false),
  calendarLater: z.boolean().optional().default(false).catch(false),
  gmailLater: z.boolean().optional().default(false).catch(false),
  stopAsking: z.boolean().optional().default(false).catch(false),
  ahaMention: z.string().nullable().optional().default(null).catch(null),
});

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
          agePrecision: {
            type: ['string', 'null'],
            enum: ['years', 'months', null],
          },
        },
      },
    },
    parentName: { type: ['string', 'null'] },
    parentRole: {
      type: ['string', 'null'],
      enum: ['mother', 'father', 'unknown', null],
    },
    parentRoleBasis: {
      type: ['string', 'null'],
      enum: ['stated', 'guessed', null],
    },
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
          child: { type: ['string', 'null'] },
        },
        required: ['line', 'cadence', 'date'],
      },
    },
    scheduleDone: { type: 'boolean' },
    coparentGroup: { type: ['boolean', 'null'] },
    coparentGroupMode: { type: ['string', 'null'], enum: ['existing', 'new', null] },
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
  /\b(booked|enrolled|signed[- ]up|signed (?:you|them|her|him|\w+) up|registered|registration (?:is )?done|inscrit[es]?\b|réservé)\b/i;

const ACTIVITY_WORD =
  /\b(swims?|swimming|soccer|gym|gymnastics|librar(?:y|ies)|zoo|museum|hockey|dance|ballet|music|storytime|story time|camps?|daycare|earlyon|farm|natation|scouts?|beavers)\b/gi;

const WEEKDAY =
  /\b(mon|tues|wednes|thurs|fri|satur|sun)days?\b|\b(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b/gi;

const PRICE = /\$\s?\d+(?:\.\d{2})?/g;
/** Hale's price is not in the facts: the site has it. "Free" or "not free" are both claims. */
const PRICE_WORD =
  /\bfree\b|\bno (?:cost|charge|fee)s?\b|\bgratuit\w*|\bcosts? (?:nothing|money)\b/i;

function priceTalk(text: string, input: FriendVoiceInput): string[] {
  const prose = text.replace(/\bfeel free\b/gi, '');
  if (!PRICE_WORD.test(prose)) return [];
  // An activity line or a synced item may say it is free; Hale's own price is never given.
  const given = [...input.findLines, ...(input.findGroups ?? []).flatMap((group) => group.lines)];
  return given.some((line) => PRICE_WORD.test(line)) ? [] : ['price'];
}

/** ASCII stand-ins for accented words. A following letter (é in adapté) is not a gap. */
const FRENCH_ASCII_GAP = /\b(?:pres|age|adapt|prenoms?|ecole|ca|numero|reponds)(?![\p{L}])/iu;

/** A connector spoken of as already on, before the parent has tapped its link. */
const CONNECTED_CLAIM =
  /^\s*(?:all )?done\b|\b(?:you['’]re|you are|we['’]re|we are) (?:all )?set\b|\ball set\b|\b(?:is|['’]s) (?:now )?(?:set|done|live)\b|\b(?:got|have|has|is|are|now|already|i['’]ve)\b[^.?!]{0,25}\b(?:connected|linked|hooked up|synced|set up|access to)\b|\bi['’]m (?:now )?(?:connected|watching)\b/i;

/** "The link" as a thing to tap; "link your Gmail" is a verb and points at nothing. */
const DANGLING_LINK =
  /\b(?:the|this|that|a|my|our|your)\s+links?\b|\blinks?(?:['’]s| is)?\s+(?:right\s+)?(?:below|above|here|up there)\b|\blien\b/i;
/** Pointing back at a card that is already on the thread. True only when it is. */
const LINK_ABOVE =
  /\blink(?:['’]s| is)? (?:right )?(?:above|up there|there|i sent|i just sent|from earlier|earlier)\b|\blien (?:plus haut|ci-dessus|envoy[ée])/i;

/**
 * Privacy lines that are not true. Google shares the whole inbox or calendar;
 * Hale keeps and uses only what is about the kids. "I only read the kid
 * stuff", "I never see your work mail" and "work stays private" promise more
 * than that.
 */
const FALSE_PRIVACY =
  /\bnever (?:see|sees|read|reads|look at|looks at|open|opens)\b|\bnever touch(?:es)? (?:your |any )?(?:work|personal|private|other)\b|\b(?:won['’]?t|will not|don['’]?t|do not|can['’]?t|cannot) (?:see|read|look at|open|touch|access) (?:your |any )?(?:work|personal|private|other)\b|\bonly (?:read|reads|see|sees|look at|looks at|look for|looks for|scan|scans|watch|watches|check|checks|open|opens)\b|\b(?:see|sees|read|reads|look at|looks at)(?: [\w'’]+)? only\b|\bnever (?:see )?anything (?:personal|private)\b|\bnever see anything else\b|\bnever (?:your )?(?:work|personal|private)\b|\b(?:pick|choose|control|decide|limit)\b[^.?!]{0,30}\b(?:what|which)\b[^.?!]{0,30}\b(?:see|sees|read|reads|access)\b|\bdown to the (?:label|folder)\b|\bstays? between you\b|\b(?:work|personal|private)[\w\s'’-]{0,25}\b(?:never|not)\b[^.?!]{0,20}\b(?:touched|seen|read|opened|looked at)\b|\b(?:invisible|hidden|unseen|off[- ]limits) to (?:me|hale|us)\b|\b(?:stays?|remains?) (?:invisible|hidden|unseen|off[- ]limits)\b|(?:^|[.!?—–-]\s*)(?:no[,—–-]*\s*)?(?:only|just) (?:what['’]?s|the stuff|stuff|things|the things) (?:about|for|related)\b|\b(?:the rest|everything else|anything else|all else)\b[^.?!]{0,20}\b(?:don['’]?t|do not|never|won['’]?t|will not) (?:touch|see|read|look at|open)\b|\b(?:delete|deletes|erase|erases|discard|discards|throw away|toss)\b[^.?!]{0,15}\b(?:the rest|everything else|anything else|the others?|other)\b/i;

/** Asking what to call the parent. Only the name steps may. */
const NAME_ASK =
  /what (?:should|can|do|shall) i call you|what['’]?s your name|your name\?|comment (?:je )?(?:dois|peux)[- ]?(?:je )?t['’]appeler|ton (?:pr[ée]nom|nom)\s*\?/i;
const NAME_STEPS = new Set<FriendStep>(['names', 'name_confirm', 'name_reply', 'find_empty']);

/**
 * Towns and areas across the GTA. A reply may name one only when the facts or
 * the parent did: L7G is Georgetown, not Ajax, and the model does not know that.
 */
const COVERAGE_AREA = /\b(?:the )?(?:greater )?toronto area\b|\bgreater toronto\b/gi;
const GTA_PLACE =
  /\b(toronto|scarborough|etobicoke|north york|east york|mississauga|brampton|caledon|bolton|oakville|burlington|milton|halton hills|georgetown|acton|markham|vaughan|woodbridge|richmond hill|thornhill|aurora|newmarket|stouffville|unionville|pickering|ajax|whitby|oshawa|clarington|bowmanville|courtice|uxbridge|hamilton|guelph|port credit|streetsville)\b/gi;

/** Steps that end with no question. find_show shows; the name ask is the next bubble. */
const ZERO_QUESTION_STEPS = new Set<FriendStep>(['stop_asking', 'connected', 'ack', 'find_show']);

/** Steps that are not an ask: the walk's next item is not theirs to raise. */
const ASKS_NOTHING = new Set<FriendStep>(['connected', 'find_show', 'ack', 'stop_asking']);

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

/**
 * Under an hour the reply is still the answer to a message that just arrived —
 * including the sweep's own two-minute pause. Past that, the model gets the wait
 * as a number of minutes plus whether that text was overnight or yesterday.
 * No sentence and no apology: the model words whatever it says.
 */
const LAST_INBOUND_MARK_MINUTES = 60;

export function lastInboundFact(
  inboundAt: Date,
  now: Date,
  timeZone: string = AHA_TIME_ZONE,
): LastInboundFact | null {
  const elapsedMs = now.getTime() - inboundAt.getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  const minutesAgo = Math.floor(elapsedMs / 60_000);
  if (minutesAgo < LAST_INBOUND_MARK_MINUTES) return null;
  return {
    minutesAgo,
    overnight: inProactiveQuietHours(inboundAt, timeZone),
    yesterday: dayKeyIn(inboundAt, timeZone) < dayKeyIn(now, timeZone),
  };
}

/** What the model is handed. No link, no family id, no phone. */
export function friendVoiceContext(input: FriendVoiceInput): unknown {
  const checklist = input.checklist ?? null;
  const now = input.now ?? null;
  const today = now ? dayKeyIn(now, AHA_TIME_ZONE) : null;
  const missing = checklist ? onboardingMissing(checklist) : null;
  // Lines carry their number, so an add points at the line the parent meant and
  // not at a zero-based array position.
  const numbered = input.findLines.map((text, index) => ({
    n: index + 1,
    text,
  }));
  let from = 0;
  const groups = input.findGroups
    ? input.findGroups.map((group) => {
        const lines = group.lines.map((text) => {
          from += 1;
          return { n: from, text };
        });
        return { category: group.category, lines };
      })
    : null;
  return {
    step: input.step,
    language: input.language,
    address: input.address,
    introduce: input.introduce,
    parentWords: input.parentWords,
    // A message Hale sends on its own (after a connect, a card) answers nothing.
    ...(input.parentWords.trim().length === 0
      ? {
          occasion: 'your own message: the parent has not written since your last text',
        }
      : {}),
    // Hours later, or the next morning: the wait, as facts. A just-arrived text omits it.
    ...(input.lastInbound ? { lastInbound: input.lastInbound } : {}),
    recentTurns: input.recentTurns,
    order: [...ONBOARDING_ORDER],
    known: checklist,
    missing,
    answering: ASKS_NOTHING.has(input.step) ? null : (missing?.[0] ?? null),
    reading: readingForModel(input),
    next: ASKS_NOTHING.has(input.step) ? null : (missing?.[1] ?? null),
    facts: {
      placeLabel: input.placeLabel,
      agesLabel: input.agesLabel,
      ageMonths: input.ageMonths,
      children: input.children ?? null,
      findLines: numbered,
      findGroups: groups,
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
      // Code puts the number, and a sentence or the phrase, under the reply; the model
      // only knows they are there.
      coparentJoin: input.coparentJoin
        ? {
            below:
              'the number on its own line, then a short line: for their own group, a sentence to add it; for a new group, a phrase to send',
            how: {
              existing: 'add the number below to the family group chat they already have',
              new: 'start a group text with the other parent and the number below, then send the phrase below in it',
            },
          }
        : null,
      coparentGroup: input.coparentGroup ?? null,
      // Who runs Hale is for when they ask; otherwise the founder's name is
      // one more name the model could take for the parent's.
      identity: input.introduce || isIdentityChallenge(input.parentWords) ? HALE_IDENTITY : null,
      access:
        input.step === 'email' || input.step === 'calendar'
          ? { true: ACCESS_FACTS[input.step], untrue: ACCESS_UNTRUE }
          : null,
    },
    ...(input.retry ? { retry: input.retry } : {}),
  };
}

const PLAIN_YES =
  /^(?:ok(?:ay)?(?: fine| sure)?|fine|sure(?: thing)?|yes(?: please)?|yeah|yep|yup|go ahead|sounds good|let['’]?s do it|do it|oui|d['’]accord|ok d['’]accord)[.!]*$/i;
const LONE_NAME = /^\p{Lu}[\p{L}'’-]+(?:\s\p{Lu}[\p{L}'’-]+)?[.!]?$/u;
const YES_ITEMS = new Set<OnboardingItem>(['gmail', 'calendar', 'coparent']);

function answeringItem(input: FriendVoiceInput): OnboardingItem | null {
  if (ASKS_NOTHING.has(input.step) || !input.checklist) return null;
  return onboardingMissing(input.checklist)[0] ?? null;
}

/**
 * What code can read from the parent's words without the model: a lone name
 * after the name ask, or a plain yes to a connector or the group chat. The
 * model is told, and the capture is held to it.
 */
export function parentReading(
  input: FriendVoiceInput,
): { kind: 'name'; name: string } | { kind: 'yes'; item: OnboardingItem } | null {
  const words = input.parentWords.trim();
  const item = answeringItem(input);
  if (!item || words.length === 0) return null;
  // A plain "ok" answers a question only when Hale's last text asked one.
  const lastHale = [...input.recentTurns].reverse().find((turn) => turn.role === 'hale');
  if (!lastHale?.body.includes('?')) return null;
  if (item === 'name' && LONE_NAME.test(words)) {
    const name = words.replace(/[.!]+$/u, '');
    const kids = (input.children ?? []).map((kid) => (kid.name ?? '').toLowerCase());
    if (!kids.includes(name.toLowerCase())) return { kind: 'name', name };
  }
  const yesItem =
    YES_ITEMS.has(item) || (item === 'schedule' && (input.scheduled ?? []).length > 0);
  if (yesItem && PLAIN_YES.test(words.replace(/,/g, ''))) return { kind: 'yes', item };
  return null;
}

function readingForModel(input: FriendVoiceInput): string | null {
  const cue = groupModeCue(input);
  if (cue) return `if parentWords is a yes to coparent, it is for ${GROUP_MODE_WORDS[cue]}`;
  const reading = parentReading(input);
  if (!reading) return null;
  if (reading.kind === 'name') {
    return `parentWords is their name (${reading.name}): it answers the name ask`;
  }
  return reading.item === 'coparent'
    ? `parentWords is a yes to coparent, for ${GROUP_MODE_WORDS.existing}`
    : `parentWords is a yes to ${reading.item}`;
}

const GROUP_MODE_WORDS: Record<CoparentGroupMode, string> = {
  existing: 'the family group they already have',
  new: 'a new group with the other parent',
};

const EXISTING_GROUP_CUE =
  /\badd (?:you|yourself|hale)\b|\bajoute[- ]?toi\b|\b(?:our|my|the family) (?:family )?group\b|\bexisting\b|\bnotre groupe\b|\bgroupe (?:existant|de famille)\b/i;
const NEW_GROUP_CUE =
  /\bnew (?:group|one|chat)\b|\bstart (?:one|a group)\b|\bnouveau\b|\bnouvelle?\b/i;
// "pas" also catches "pas de problème": that yes names no group, and the model's reading stands.
const NEGATION = /\b(?:no|nope|nah|not|non|pas|don['’]?t)\b/i;

/**
 * Which group the parent's words name, when they name one: "add you to our group"
 * is theirs, "start a new group" is new. A no, a question, or both cues at once
 * name nothing, and the model's reading stands.
 */
export function coparentGroupModeCue(words: string): CoparentGroupMode | null {
  if (words.includes('?') || NEGATION.test(words)) return null;
  const existing = EXISTING_GROUP_CUE.test(words);
  const fresh = NEW_GROUP_CUE.test(words);
  if (existing === fresh) return null;
  return existing ? 'existing' : 'new';
}

function groupModeCue(input: FriendVoiceInput): CoparentGroupMode | null {
  return answeringItem(input) === 'coparent' ? coparentGroupModeCue(input.parentWords) : null;
}

/**
 * The group a yes means, held to the parent's words. A cue decides the group over
 * the model but never makes a yes; a yes that names no group means the one they
 * already have.
 */
function withGroupMode(capture: OnboardingCapture, input: FriendVoiceInput): OnboardingCapture {
  if (capture.coparentGroup !== true) return { ...capture, coparentGroupMode: null };
  const mode = groupModeCue(input) ?? capture.coparentGroupMode ?? 'existing';
  return { ...capture, coparentGroupMode: mode };
}

/**
 * A question is not a yes. "Do you read all my emails?" asks; it does not
 * agree to connect Gmail or to a group chat.
 */
function noYesInAQuestion(capture: OnboardingCapture, input: FriendVoiceInput): OnboardingCapture {
  if (!input.parentWords.includes('?')) return capture;
  return {
    ...capture,
    connectGmail: capture.connectGmail === true ? null : capture.connectGmail,
    connectCalendar: capture.connectCalendar === true ? null : capture.connectCalendar,
    coparentGroup: capture.coparentGroup === true ? null : capture.coparentGroup,
  };
}

/**
 * The turn that records reminders confirms them; the schedule closes on the
 * parent's next message, so their "sounds good" to the confirmation is not
 * read as a yes to the question after it.
 */
function settleSchedule(capture: OnboardingCapture): OnboardingCapture {
  return capture.scheduleAdds.length > 0 && capture.scheduleDone
    ? { ...capture, scheduleDone: false }
    : capture;
}

/** The capture, held to what code read for certain. */
function withReading(capture: OnboardingCapture, input: FriendVoiceInput): OnboardingCapture {
  const reading = parentReading(input);
  if (!reading) return capture;
  if (reading.kind === 'name') {
    const kids = (input.children ?? []).map((kid) => (kid.name ?? '').toLowerCase());
    if (capture.parentName || kids.includes(reading.name.toLowerCase())) return capture;
    return { ...capture, parentName: reading.name };
  }
  if (reading.item === 'gmail') return { ...capture, connectGmail: true, gmailLater: false };
  if (reading.item === 'calendar') {
    return { ...capture, connectCalendar: true, calendarLater: false };
  }
  // "Sounds good" to the reminders just confirmed closes the schedule.
  if (reading.item === 'schedule') return { ...capture, scheduleDone: true };
  return { ...capture, coparentGroup: true };
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

/** "18:30" on a line is "6:30" in a text; the same time, said the usual way. */
function twelveHourTimes(line: string): string[] {
  return [...line.matchAll(/\b(\d{1,2}):(\d{2})\b/gu)].flatMap((match) => {
    const hour = Number(match[1]);
    return hour > 12 && hour < 24 ? [`${hour - 12}:${match[2]}`] : [];
  });
}

export function friendFactSlots(input: FriendVoiceInput, link?: string | null): string[] {
  const slots = [input.parentWords, input.agesLabel ?? '', input.placeLabel ?? ''];
  for (const turn of input.recentTurns) slots.push(turn.body);
  for (const line of input.findLines) slots.push(line, ...twelveHourTimes(line));
  for (const group of input.findGroups ?? []) {
    for (const line of group.lines) slots.push(line, ...twelveHourTimes(line));
  }
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
  slots.push(
    HALE_IDENTITY.company,
    HALE_IDENTITY.site,
    `https://${HALE_IDENTITY.site}`,
    HALE_IDENTITY.person,
    HALE_IDENTITY.contact,
  );
  return slots.filter((slot) => slot.length > 0);
}

/**
 * Every true way to say when a synced item is: the long label in both
 * languages, the weekday on its own, the day of the month ("17", "17th"),
 * the month, and the clock as "10:00", "10 am", "10am" and "10 h". The
 * judge is checking the fact, not the model's phrasing of it.
 */
export function instantFactSlots(start: string, allDay: boolean): string[] {
  const slots: string[] = [];
  const instant = allDay ? new Date(`${start}T12:00:00Z`) : new Date(start);
  if (Number.isNaN(instant.getTime())) return slots;
  const zone = allDay ? 'UTC' : AHA_TIME_ZONE;
  for (const locale of ['en-CA', 'fr-CA']) {
    const parts = new Intl.DateTimeFormat(locale, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      timeZone: zone,
    }).formatToParts(instant);
    for (const part of parts) {
      if (part.type === 'weekday' || part.type === 'month') slots.push(part.value);
      if (part.type === 'day') {
        const day = Number(part.value);
        slots.push(
          part.value,
          `${part.value}th`,
          `${part.value}st`,
          `${part.value}nd`,
          `${part.value}rd`,
        );
        if (day === 1) slots.push('1er');
      }
    }
    slots.push(
      new Intl.DateTimeFormat(locale, {
        weekday: 'short',
        timeZone: zone,
      }).format(instant),
      new Intl.DateTimeFormat(locale, {
        month: 'short',
        timeZone: zone,
      }).format(instant),
    );
  }
  if (!allDay) {
    const parts = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: false,
      timeZone: AHA_TIME_ZONE,
    }).formatToParts(instant);
    const hour24 = Number(parts.find((part) => part.type === 'hour')?.value ?? Number.NaN);
    const minute = parts.find((part) => part.type === 'minute')?.value ?? '';
    if (!Number.isNaN(hour24) && minute) {
      const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
      const meridiem = hour24 < 12 ? 'am' : 'pm';
      const padded = String(hour24).padStart(2, '0');
      slots.push(`${padded}:${minute}`, `${hour24}:${minute}`, `${hour12}:${minute}`);
      slots.push(
        `${hour12} ${meridiem}`,
        `${hour12}${meridiem}`,
        `${hour12}:${minute} ${meridiem}`,
      );
      slots.push(`${hour12} ${meridiem === 'am' ? 'a.m.' : 'p.m.'}`);
      slots.push(
        `${padded} h ${minute}`,
        `${hour24} h ${minute}`,
        `${hour24}h${minute}`,
        `${hour24} h`,
      );
      if (minute === '00') slots.push(`${hour24}h`);
    }
  }
  return slots;
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
    slots.push(...instantFactSlots(item.start, item.allDay));
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
      slots.push(...instantFactSlots(item.receivedAt, false));
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

/** "swimming" against a line that says "Swim", "camps" against "Day Camp", "storytime" against "Story Time". */
function activityStem(token: string): string {
  return token
    .toLowerCase()
    .replace(/[\s-]+/g, '')
    .replace(/(?:mming|ing|ies|es|s)$/u, (suffix) =>
      suffix === 'mming' ? 'm' : suffix === 'ies' ? 'i' : '',
    );
}

function activitiesOutsideSlots(text: string, slots: readonly string[]): string[] {
  const found = text.match(ACTIVITY_WORD) ?? [];
  const unique = [...new Set(found.map((token) => token.toLowerCase()))];
  const haystack = slots.map((slot) => slot.toLowerCase().replace(/[\s-]+/g, ''));
  return unique.filter((token) => {
    const stem = activityStem(token);
    return !haystack.some((slot) => slot.includes(token) || slot.includes(stem));
  });
}

const WEEKDAY_KEYS: Record<string, string[]> = {
  mon: ['mon', 'lundi'],
  tues: ['tue', 'tues', 'mardi'],
  wednes: ['wed', 'wednes', 'mercredi'],
  thurs: ['thu', 'thur', 'thurs', 'jeudi'],
  fri: ['fri', 'vendredi'],
  satur: ['sat', 'satur', 'samedi'],
  sun: ['sun', 'dimanche'],
  lundi: ['mon', 'lundi'],
  mardi: ['tue', 'tues', 'mardi'],
  mercredi: ['wed', 'wednes', 'mercredi'],
  jeudi: ['thu', 'thur', 'thurs', 'jeudi'],
  vendredi: ['fri', 'vendredi'],
  samedi: ['sat', 'satur', 'samedi'],
  dimanche: ['sun', 'dimanche'],
};

/**
 * A weekday the reply names must be one a slot names too, in either language
 * or abbreviated the way a subject line does ("Thu Oct 8"). The day itself is
 * the fact; its spelling is not.
 */
function weekdaysOutsideSlots(text: string, slots: readonly string[]): string[] {
  const found = text.match(WEEKDAY) ?? [];
  const unique = [...new Set(found.map((token) => token.toLowerCase()))];
  const lowered = slots.map((slot) => slot.toLowerCase());
  return unique.filter((token) => {
    const key = Object.keys(WEEKDAY_KEYS).find((candidate) => token.startsWith(candidate));
    const forms = key ? WEEKDAY_KEYS[key] : undefined;
    if (!forms) return !lowered.some((slot) => slot.includes(token));
    return !lowered.some((slot) =>
      forms.some((form) => new RegExp(`\\b${form}(?:days?|\\.|\\b)`, 'u').test(slot)),
    );
  });
}

/** A phone number in prose: code puts the real one under the reply, never the model. */
const PHONE = /\+?\d[\d\s().-]{8,}\d/u;
/** A web address without its scheme ("hale.app/join"). Only the site in the facts may be named. */
const BARE_DOMAIN = /\b[\w-]+\.(?:app|com|ca|io|org|net|co)(?:\/[^\s,)]*)?/giu;
/** Capitalised words any reply may use: Hale's own names and the services it talks about. */
const ALLOWED_NAMES = new Set([
  'hale',
  'village',
  'technologies',
  'inc',
  'google',
  'gmail',
  'calendar',
  'imessage',
  'gta',
  // Hale's coverage, said when a place falls outside it.
  'toronto',
  'ontario',
  'advanced',
  'continue',
  // Days and months are checked as facts on their own (weekday and date checks).
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
  'oct',
  'nov',
  'dec',
  'sept',
  'sep',
]);

/**
 * A proper name the model wrote mid-sentence (a town, a school, a venue) that
 * is not in the facts or the parent's words. "That's the Dundas area" for an
 * L7G postal code is a guess, and a guess said as fact.
 */
function namesOutsideSlots(text: string, slots: readonly string[]): string[] {
  const haystack = slots.join(' ').toLowerCase();
  const out = new Set<string>();
  for (const sentence of sentencesOf(text)) {
    const words = sentence.split(/[\s—–-]+/u);
    words.forEach((raw, index) => {
      if (index === 0) return;
      const word = raw.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '').replace(/['’]s$/u, '');
      if (!/^\p{Lu}\p{Ll}{2,}$/u.test(word)) return;
      const lower = word.toLowerCase();
      if (ALLOWED_NAMES.has(lower) || haystack.includes(lower)) return;
      out.add(word);
    });
  }
  return [...out];
}

/** Words in quotes are a claim of exact text (a phrase to send, a title): they must be given. */
function quotesOutsideSlots(text: string, slots: readonly string[]): string[] {
  const lowered = slots.map((slot) => slot.toLowerCase());
  return [...text.matchAll(/["“]([^"”\n]{2,60})["”]/gu)]
    .map((match) => (match[1] ?? '').trim())
    .filter(
      (quote) => quote.length > 0 && !lowered.some((slot) => slot.includes(quote.toLowerCase())),
    );
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * The weekday of each month-and-day date the slots carry ("October 14" is a
 * Wednesday in 2026). Naming the true weekday of a given date is not invention.
 */
function weekdaysOfDates(slots: readonly string[], now: Date | undefined): string[] {
  const today = now ?? new Date();
  const out = new Set<string>();
  for (const slot of slots) {
    for (const match of slot.matchAll(
      /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/giu,
    )) {
      const month = MONTHS.indexOf((match[1] ?? '').toLowerCase());
      const day = Number(match[2]);
      if (month < 0 || day < 1 || day > 31) continue;
      let date = new Date(Date.UTC(today.getUTCFullYear(), month, day, 12));
      if (date.getTime() < today.getTime() - 60 * 86_400_000) {
        date = new Date(Date.UTC(today.getUTCFullYear() + 1, month, day, 12));
      }
      out.add(date.toLocaleDateString('en-CA', { weekday: 'long', timeZone: 'UTC' }));
    }
  }
  return [...out];
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** "I'm Barton" from Hale, when Barton is the parent. */
function speaksAsParent(text: string, parentName: string | null | undefined): boolean {
  const name = parentName?.trim() ?? '';
  if (name.length < 2) return false;
  const pattern = new RegExp(
    `\\b(?:i['’]?m|i am|this is|it['’]?s|je suis|c['’]est)\\s+${escapeRegExp(name)}\\b`,
    'iu',
  );
  // "Barton's calendar" to Barton: Hale talks to the parent, not about them.
  const aboutThem = new RegExp(`\\b${escapeRegExp(name)}['’]s\\b`, 'iu');
  return pattern.test(text) || aboutThem.test(text);
}

export type FriendJudgeFailure =
  | 'privacy'
  | 'empty'
  | 'long'
  | 'question'
  | 'banned'
  | 'compliance'
  | 'invented'
  | 'french'
  | 'link'
  | 'registration_claim'
  | 'identity'
  | 'topic'
  | 'premature';

function trailerFacts(options: JudgeOptions): string[] {
  return options.trailer ? [options.trailer] : [];
}

export function judgeFriendReply(
  body: string,
  input: FriendVoiceInput,
  options: JudgeOptions = {},
): { ok: true } | { ok: false; reason: FriendJudgeFailure; detail?: string } {
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
  const flex =
    FLEX_QUESTION_STEPS.has(input.step) ||
    (options.yesToLink === true && LINK_STEPS.has(input.step)) ||
    options.scheduleRecorded === true;
  if (flex) {
    if (asked > 1) return { ok: false, reason: 'question' };
  } else if (asked !== needed) {
    return { ok: false, reason: 'question' };
  }
  // The question may sit anywhere in the prose, but never above a list it asks about.
  if (asked === 1 && /\?[\s\S]*\n\s*\d+\.\s/u.test(trimmed))
    return { ok: false, reason: 'question' };
  if (NAME_ASK.test(trimmed) && !NAME_STEPS.has(input.step)) {
    return { ok: false, reason: 'question' };
  }
  // Hale is Hale. A reply that answers "Barton" with "I'm Barton" has the roles backwards.
  if (speaksAsParent(trimmed, input.parentName)) return { ok: false, reason: 'identity' };
  if (FALSE_PRIVACY.test(trimmed)) return { ok: false, reason: 'privacy' };
  if (BANNED_PHRASE.test(trimmed)) return { ok: false, reason: 'banned' };
  if (COMPLIANCE.test(trimmed)) return { ok: false, reason: 'compliance' };
  if (REGISTRATION_CLAIM.test(trimmed)) return { ok: false, reason: 'registration_claim' };
  // Who is behind this number is a disclosure: when they asked, the company is named.
  if (isIdentityChallenge(input.parentWords) && !NAMES_HALE_COMPANY.test(trimmed)) {
    return { ok: false, reason: 'identity' };
  }
  // Asked about price: Hale does not quote one, it points to the site.
  if (
    !ASKS_NOTHING.has(input.step) &&
    /\b(?:free|cost|costs|price|pricing|pay|charge|gratuit|co[uû]te?)\b/i.test(input.parentWords) &&
    !/villagehale\.com|\b(?:the|our) (?:web)?site\b|\bsite web\b/i.test(trimmed)
  ) {
    return { ok: false, reason: 'identity', detail: 'price' };
  }

  const slots = friendFactSlots(input, options.link);
  for (const fact of trailerFacts(options)) slots.push(fact);
  const invented = [
    ...findInventedFacts(trimmed, slots),
    ...mentionsOutsideSlots(trimmed, PRICE, slots),
    ...weekdaysOutsideSlots(trimmed, [...slots, ...weekdaysOfDates(slots, input.now)]),
    ...priceTalk(trimmed, input),
    // "The Toronto area" is Hale's coverage, not a guess at where the parent lives.
    ...mentionsOutsideSlots(trimmed.replace(COVERAGE_AREA, ''), GTA_PLACE, slots),
    ...quotesOutsideSlots(trimmed, slots),
    ...namesOutsideSlots(trimmed, slots),
    ...(PHONE.test(trimmed) ? ['phone number'] : []),
    ...mentionsOutsideSlots(trimmed, BARE_DOMAIN, slots),
    ...(input.step !== 'email' ? activitiesOutsideSlots(trimmed, slots) : []),
  ];
  if (invented.length > 0) return { ok: false, reason: 'invented', detail: invented.join(',') };
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

  // "The link" is true only when a link rides this bubble, or when the card is
  // already on the thread and the reply points back at it.
  if (DANGLING_LINK.test(trimmed)) {
    const attached = Boolean(options.link && trimmed.includes(options.link));
    const above = options.linkAbove === true && LINK_ABOVE.test(trimmed);
    const follows = options.linkFollows === true && LINK_STEPS.has(input.step);
    if (!attached && !follows && !above) return { ok: false, reason: 'link' };
  }
  // A card is for one connector. Prose about the other one under its link
  // sends the parent to the wrong place.
  if (options.linkFollows || options.link) {
    // Naming the other connector is fine ("so I can add them to your calendar");
    // asking to connect it under this link is not.
    const connects = (thing: string) =>
      new RegExp(
        `\\b(?:connect|link|hook up|sync|access)\\w*\\b[^.?!]{0,25}\\b(?:${thing})\\b|\\b(?:${thing})\\b[^.?!]{0,15}\\b(?:connect|link|access)\\w*`,
        'i',
      ).test(trimmed);
    // The ask is for this connector: a question about the other one is the wrong ask.
    const otherAsked = (thing: RegExp) =>
      sentencesOf(trimmed).some((sentence) => sentence.includes('?') && thing.test(sentence));
    if (input.step === 'calendar' && otherAsked(/\b(?:gmail|inbox|e-?mails?)\b/i)) {
      return { ok: false, reason: 'link' };
    }
    if (input.step === 'email' && otherAsked(/\b(?:calendars?|calendrier|agenda)\b/i)) {
      return { ok: false, reason: 'link' };
    }
    if (input.step === 'calendar' && connects('gmail|inbox|e-?mail')) {
      return { ok: false, reason: 'link' };
    }
    if (input.step === 'email' && connects('calendar|calendrier|agenda')) {
      return { ok: false, reason: 'link' };
    }
  }

  // Nothing is connected until they tap the link: the ask and the reply to a yes say so.
  if (LINK_STEPS.has(input.step) && CONNECTED_CLAIM.test(trimmed)) {
    return { ok: false, reason: 'premature' };
  }
  // The connector ask carries that connector's card: the prose has to be about it.
  if (LINK_STEPS.has(input.step) && options.yesToLink !== true) {
    const topic =
      input.step === 'email'
        ? /\b(gmail|inbox|e-?mails?|mail|courriels?)\b/i
        : /\b(calendars?|calendrier|agenda)\b/i;
    // An answer to their own question about it is on topic without naming it again.
    if (!topic.test(trimmed) && !topic.test(input.parentWords)) {
      return { ok: false, reason: 'topic' };
    }
  }

  if (input.step === 'find_empty' && /^\s*\d+\.\s/m.test(trimmed)) {
    return { ok: false, reason: 'invented' };
  }
  if (input.step === 'connected') {
    const named = options.ahaMention?.trim() ?? '';
    const outside = named.length > 0 ? trimmed.replace(named, ' ') : trimmed;
    const namesGmail = /\bgmail\b/i.test(outside);
    const namesCalendar = /\b(calendar|calendrier|agenda)\b/i.test(outside);
    if (input.connector === 'gcal' && namesGmail) {
      return { ok: false, reason: 'invented', detail: 'gmail on calendar wow' };
    }
    if (input.connector === 'gmail' && namesCalendar) {
      return { ok: false, reason: 'invented', detail: 'calendar on gmail wow' };
    }
    const grounded = ahaGrounding(trimmed, input, named);
    if (grounded) return { ok: false, reason: 'invented', detail: grounded };
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

/** A snippet this long, copied whole, is the email quoted verbatim. */
const VERBATIM_SNIPPET_CHARS = 40;

/** Lower case, no possessive, one space between words: "Mia's swim" reads as "mia swim". */
function looseText(value: string): string {
  return value
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const DATE_TOKEN =
  /^(?:\d{1,2}(?:st|nd|rd|th)?|\d{1,2}:\d{2}|\d{1,2}(?:am|pm)|am|pm|at|on|le|à|a|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|(?:mon|tues|wednes|thurs|fri|satur|sun)day|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|may|june|july|august|september|october|november|december|janv|févr|fevr|mars|avr|mai|juin|juil|août|aout|déc|dec|janvier|février|fevrier|avril|juillet|septembre|octobre|novembre|décembre|decembre)$/u;

/**
 * The title with the date and time a subject line carries at either end
 * taken off: "Picture Day at Park Public School Thu Oct 8" is about picture
 * day at Park Public School. What is left is what the reply must carry.
 */
export function mentionCore(title: string): string {
  const words = looseText(title)
    .split(' ')
    .filter((word) => word.length > 0);
  let start = 0;
  let end = words.length;
  while (start < end && DATE_TOKEN.test(words[start] ?? '')) start += 1;
  while (end > start && DATE_TOKEN.test(words[end - 1] ?? '')) end -= 1;
  const core = words.slice(start, end).join(' ');
  return core.length >= 3 ? core : words.join(' ');
}

/** Words that do not tell one title from another. */
const TITLE_FILLER = new Set([
  'the',
  'and',
  'for',
  'with',
  'your',
  'from',
  'des',
  'les',
  'pour',
  'avec',
]);

/**
 * The reply names this title: its core words in order, or, in the reply's own
 * words, both words of a two-word title or two of a longer one ("picture day
 * at Park Public" is the Park Public School picture day).
 */
export function bodyCarriesTitle(body: string, title: string): boolean {
  const core = mentionCore(title);
  if (core.length === 0) return false;
  const text = ` ${looseText(body)} `;
  if (text.includes(` ${core} `)) return true;
  const words = core
    .replace(/\s+-\s+.*$/u, '')
    .split(' ')
    .filter((word) => word.length >= 3 && !TITLE_FILLER.has(word));
  if (words.length === 0) return false;
  const hits = words.filter((word) => text.includes(` ${word} `) || text.includes(` ${word}s `));
  return words.length <= 2 ? hits.length === words.length : hits.length >= 2;
}

/**
 * What a wow line may carry: up to two synced titles or subjects (one item, or
 * two kid items worth naming together), none when the read was not `ok`, and
 * never an email quoted whole. The titles are found in the reply itself; the
 * declared mention is a hint, and a declared title that is not in the snapshot
 * is an invention. Everything in `synced` is already kid-only.
 */
function ahaGrounding(body: string, input: FriendVoiceInput, named: string): string | null {
  if (!input.synced) return null;
  const titles = ahaTitles(input);
  for (const item of input.synced.email) {
    const snippet = item.snippet?.trim() ?? '';
    if (snippet.length >= VERBATIM_SNIPPET_CHARS && body.includes(snippet))
      return 'verbatim snippet';
  }
  // The declared mention is a pointer, not a test of spelling: "Mia swim and
  // Mia birthday party" points at two real titles.
  const loose = looseText(named);
  if (
    loose.length > 0 &&
    !titles.some((title) => {
      const t = looseText(title);
      return t.length > 0 && (loose.includes(t) || t.includes(loose));
    })
  ) {
    return 'ahaMention not in synced';
  }
  const carried = titles.filter((title) => title.length >= 3 && bodyCarriesTitle(body, title));
  if (carried.length > 0 && input.synced.read !== 'ok') return 'synced item on a failed read';
  if (carried.length > 2) return 'more than two items';
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

function unsent(reason: FriendFallback, step: FriendStep): FriendVoiceResult {
  return {
    body: '',
    prose: '',
    bubbles: [],
    source: 'unsent',
    fallback: reason,
    step,
    capture: acceptOnboardingCapture(null),
  };
}

/** The map with no opener and no leads: real lines, numbered, nothing written by code. */
function linesOnly(input: FriendVoiceInput, reason: FriendFallback): FriendVoiceResult {
  const bubbles = assembleFindShowBubbles('', input.findGroups ?? [], null);
  if (bubbles.length === 0) return unsent(reason, input.step);
  return {
    body: bubbles.join('\n\n'),
    prose: '',
    bubbles,
    source: 'lines',
    fallback: reason,
    step: input.step,
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
/**
 * The parent just said yes to the connector this turn asked about. The reply
 * is the receipt for that yes; the next ask waits for the connect receipt.
 */
export function yesToLink(input: FriendVoiceInput, capture: OnboardingCapture): boolean {
  if (input.step === 'email') return capture.connectGmail === true && !input.checklist?.gmail;
  if (input.step === 'calendar') {
    return capture.connectCalendar === true && !input.checklist?.calendar;
  }
  return false;
}

function judgeInputFor(given: FriendVoiceInput, capture: OnboardingCapture): FriendVoiceInput {
  // A name this message gave is the parent's for every check below.
  const input =
    capture.parentName && !given.parentName ? { ...given, parentName: capture.parentName } : given;
  if (input.step === 'find_show' || input.step === 'connected') return input;
  if (yesToLink(input, capture)) return input;
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

/**
 * The #ops page for an unsent reply, at most once per scope (a family or an
 * onboarding session) per kind per day. A limiter that cannot answer pages
 * anyway: a missed page is worse than a repeated one.
 */
export function pageOncePerDay(
  limiter: RateLimiter | undefined,
  scope: string,
  post: (text: string) => Promise<unknown> = postOpsSlack,
): (text: string) => Promise<unknown> {
  return async (text) => {
    if (limiter) {
      try {
        const verdict = await limiter.check(`${scope}:${text}`, 'onboarding_ops_page', {
          limit: 1,
          windowSec: 86_400,
        });
        if (!verdict.allowed) {
          console.info({ page: 'suppressed' }, 'onboarding-friend: #ops already paged today');
          return;
        }
      } catch (err) {
        console.error(
          { err: err instanceof Error ? err.name : 'unknown' },
          'onboarding-friend: page limiter failed - paging anyway',
        );
      }
    }
    return post(text);
  };
}

/** Step and reason only. Parent words stay out of #ops. */
function unsentPage(step: FriendStep, reason: FriendFallback): string {
  return `onboarding friend voice unsent step=${step} reason=${reason}`;
}

function scheduleLimits(input: FriendVoiceInput): ScheduleLimits {
  return {
    findLineCount: input.findLines.length,
    today: input.now ? dayKeyIn(input.now, AHA_TIME_ZONE) : null,
    lines: input.findLines,
    children: input.children ?? [],
    scheduledLines: (input.scheduled ?? []).flatMap((row) => (row.line ? [row.line] : [])),
  };
}

export async function speakFriend(
  composer: FriendVoiceComposer | undefined,
  given: FriendVoiceInput,
  options: SpeakOptions = {},
): Promise<FriendVoiceResult> {
  // A lone name after the name ask is read by code: the reply is written from
  // the step after it, so the model greets them and moves on instead of asking again.
  const reading = parentReading(given);
  const pre =
    reading?.kind === 'name'
      ? advancedInput(given, {
          ...acceptOnboardingCapture(null),
          parentName: reading.name,
        })
      : null;
  const base = pre?.input ?? given;
  const input = base;
  const withPre = (capture: OnboardingCapture): OnboardingCapture =>
    pre ? mergeCaptures(pre.settled, capture) : capture;
  const finish = (
    prose: string,
    bubbles: string[],
    source: FriendVoiceResult['source'],
    turnCapture: OnboardingCapture,
    step: FriendStep,
  ): FriendVoiceResult => {
    const capture = withPre(turnCapture);
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
      step,
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
    return input.step === 'find_show'
      ? linesOnly(input, 'voice_unavailable')
      : unsent('voice_unavailable', input.step);
  }

  const timeoutMs = options.attemptTimeoutMs ?? FRIEND_ATTEMPT_TIMEOUT_MS;

  const attempt = async (
    prompt: 'full' | 'short',
    input: FriendVoiceInput = base,
  ): Promise<
    | {
        prose: string;
        bubbles: string[];
        capture: OnboardingCapture;
        step: FriendStep;
      }
    | {
        fail: FriendFallback;
        capture: OnboardingCapture;
        retry?: FriendVoiceInput['retry'];
      }
  > => {
    const empty = acceptOnboardingCapture(null);
    try {
      const composed = await withTimeout(composer.compose(input, { prompt }), timeoutMs);
      const limits = scheduleLimits(input);
      // A message Hale sends on its own (a card, a receipt) answers nothing:
      // there are no parent words to read a yes or a fact from.
      const capture =
        input.parentWords.trim().length > 0
          ? settleSchedule(
              withGroupMode(
                withReading(
                  noYesInAQuestion(
                    ownNameOnly(acceptOnboardingCapture(composed.capture, limits), input),
                    input,
                  ),
                  input,
                ),
                input,
              ),
            )
          : empty;
      const draft = composed.reply.trim();
      if (options.replyDiscardedWhen?.(capture)) {
        return { prose: '', bubbles: [], capture, step: input.step };
      }
      // A refused add means the reply may confirm a reminder that was never written.
      const refusedAdds = countRejectedScheduleAdds(composed.capture, limits);
      if (refusedAdds > 0) {
        console.error(
          {
            reason: 'schedule_add_refused',
            refusedAdds,
            step: input.step,
            prompt,
          },
          'onboarding-friend: unusable reply',
        );
        return {
          fail: 'unusable',
          capture,
          retry: { draft, problem: retryProblem('schedule') },
        };
      }
      const judgeInput = judgeInputFor(input, capture);
      // After a yes, the link is the next step: the reply points at it and asks nothing.
      // A turn that records reminders confirms them and asks nothing; the
      // parent's next message closes the schedule (see settleSchedule).
      const tidied = tidyProse(
        composed.reply,
        input,
        judgeInput.step,
        yesToLink(input, capture) || capture.scheduleAdds.length > 0,
      );
      // The number and phrase ride below: a sentence that ends "send this phrase: Hale"
      // points at them and stops there.
      const prose =
        input.coparentJoin != null && capture.coparentGroup === true
          ? tidied.replace(/:\s*[^.?!:\n]{0,24}$/u, '.')
          : tidied;
      // Under a yes to the group, code adds the number and phrase: the reply says they are below.
      const joinBelow = input.coparentJoin != null && capture.coparentGroup === true;
      // The number below is Hale's, never the other parent's.
      const wrongOwner =
        /\b(?:her|his|their|(?:mom|mum|dad|mother|father)['’]?s) (?:number|phone)\b/i;
      if (
        joinBelow &&
        (!/\bbelow\b|\bhere\b|\bnumber\b|ci-dessous|en dessous|plus bas|num[ée]ro/i.test(prose) ||
          wrongOwner.test(prose) ||
          // A placeholder where the number or phrase would go ("this number: Hale's number").
          /\b(?:number|phrase)\s*:?\s+(?:hale['’]s|the) (?:number|phrase)\b/i.test(prose) ||
          // They start the group; Hale does not.
          /\bI(?:['’]ll| will) (?:set up|start|create|make)\b[^.?!]{0,15}\bgroup\b|\bI(?:['’]ll| will) set (?:that|it|this) up\b/i.test(
            prose,
          ))
      ) {
        console.error(
          { reason: 'join_not_pointed', step: input.step, prompt },
          'onboarding-friend: unusable reply',
        );
        return {
          fail: 'unusable',
          capture,
          retry: { draft, problem: retryProblem('join') },
        };
      }
      if (input.coparentJoin && carriesJoin(prose, input.coparentJoin)) {
        console.error(
          { reason: 'join_in_prose', step: input.step, prompt },
          'onboarding-friend: unusable reply',
        );
        return {
          fail: 'unusable',
          capture,
          retry: { draft, problem: retryProblem('join') },
        };
      }
      if (
        prose.length > MAX_PROSE_CHARS &&
        repairedProse(prose, judgeInput.step, input.children).length === 0
      ) {
        console.error(
          { reason: 'long', chars: prose.length, step: input.step, prompt },
          'onboarding-friend: unusable reply',
        );
        return {
          fail: 'unusable',
          capture,
          retry: { draft, problem: retryProblem('long') },
        };
      }
      const { linkFollows, ...rest } = options;
      const judgeOptions = {
        ...rest,
        linkFollows:
          typeof linkFollows === 'function' ? linkFollows(judgeInput.step) : linkFollows === true,
        ahaMention: composed.ahaMention ?? null,
        yesToLink: yesToLink(input, capture),
        scheduleRecorded: capture.scheduleAdds.length > 0,
      };
      const bubblesFor = (text: string): { bubbles: string[]; judgedText: string } | null => {
        if (input.step === 'find_show') {
          const groups = input.findGroups ?? [];
          const leads = tidyLeads(composed.groupLeads ?? null, groups);
          const bubbles = assembleFindShowBubbles(text, groups, leads);
          return bubbles.length === 0 ? null : { bubbles, judgedText: bubbles.join('\n\n') };
        }
        if (text.length === 0) return null;
        return {
          bubbles: [],
          judgedText: assembleFriendBody(text, input, options.link, options.trailer),
        };
      };
      // A good draft with one fixable slip (a second question mark, a line too
      // many) is repaired by code and judged again rather than dropped.
      if (prose.length <= MAX_PROSE_CHARS) {
        const assembled = bubblesFor(prose);
        if (!assembled) return { fail: 'unusable', capture };
        const judged = judgeFriendReply(assembled.judgedText, judgeInput, judgeOptions);
        if (judged.ok) return { prose, bubbles: assembled.bubbles, capture, step: judgeInput.step };
        const repaired = repairedProse(prose, judgeInput.step, input.children);
        const again = repaired.length > 0 ? bubblesFor(repaired) : null;
        if (
          again &&
          (judged.reason === 'question' || judged.reason === 'link') &&
          judgeFriendReply(again.judgedText, judgeInput, judgeOptions).ok
        ) {
          console.error(
            { repaired: judged.reason, step: input.step, prompt },
            'onboarding-friend: draft repaired',
          );
          return { prose: repaired, bubbles: again.bubbles, capture, step: judgeInput.step };
        }
        return reject(judged);
      }
      const repaired = repairedProse(prose, judgeInput.step, input.children);
      const again = bubblesFor(repaired);
      if (!again) return { fail: 'unusable', capture };
      const judged = judgeFriendReply(again.judgedText, judgeInput, judgeOptions);
      if (judged.ok) {
        console.error(
          { repaired: 'long', step: input.step, prompt },
          'onboarding-friend: draft repaired',
        );
        return { prose: repaired, bubbles: again.bubbles, capture, step: judgeInput.step };
      }
      return reject(judged);

      function reject(judged: { ok: false; reason: FriendJudgeFailure; detail?: string }) {
        console.error(
          {
            reason: judged.reason,
            ...(judged.detail ? { detail: judged.detail } : {}),
            step: input.step,
            judgedAs: judgeInput.step,
            prompt,
          },
          'onboarding-friend: unusable reply',
        );
        return {
          fail: 'unusable' as const,
          capture,
          retry: {
            draft,
            problem: retryProblem(judged.reason, judged.detail, judgeInput),
          },
        };
      }
    } catch (err) {
      console.error(
        {
          err: err instanceof Error ? err.name : 'unknown',
          ...(err instanceof z.ZodError
            ? {
                issues: err.issues
                  .slice(0, 5)
                  .map((issue) => `${issue.path.join('.')}:${issue.code}`),
              }
            : {}),
          step: input.step,
          prompt,
        },
        'onboarding-friend: compose failed',
      );
      return { fail: 'model_failed', capture: empty };
    }
  };

  // Only the reply that goes out carries its capture. A refused draft's
  // decisions (a no to the co-parent, a schedule add) were never confirmed to
  // the parent; when nothing goes out, only plain facts they gave are kept.
  const failed = async (reason: FriendFallback, capture: OnboardingCapture) => {
    await page(reason);
    const result =
      input.step === 'find_show' ? linesOnly(input, reason) : unsent(reason, input.step);
    return { ...result, capture: factsOnly(withPre(capture)) };
  };

  const firstPrompt = options.prompt === 'short' ? 'short' : 'full';
  const first = await attempt(firstPrompt);
  if ('prose' in first) {
    return finish(
      first.prose,
      first.bubbles,
      firstPrompt === 'short' ? 'retry' : 'composed',
      first.capture,
      first.step,
    );
  }
  if (firstPrompt === 'short') return failed(first.fail, first.capture);

  // The parent's message settled the current item (a name, a yes) but the
  // reply was off: the retry writes from where the walk now is, so the model
  // is not left asking for what it was just told.
  const advanced = first.fail === 'unusable' ? advancedInput(input, first.capture) : null;
  const retryBase = advanced?.input ?? input;
  const nextStep = judgeInputFor(retryBase, first.capture).step;
  const askNote =
    ZERO_QUESTION_STEPS.has(nextStep) ||
    FLEX_QUESTION_STEPS.has(nextStep) ||
    yesToLink(retryBase, first.capture)
      ? ''
      : ` This message should ${askInWords(nextStep)}.`;
  const retryInput = {
    ...retryBase,
    retry: first.retry ? { ...first.retry, problem: `${first.retry.problem}${askNote}` } : null,
  };
  const second = await attempt('short', retryInput);
  if ('prose' in second) {
    const capture = advanced ? mergeCaptures(advanced.settled, second.capture) : second.capture;
    return finish(second.prose, second.bubbles, 'retry', capture, second.step);
  }
  return failed(second.fail, mergeCaptures(first.capture, second.capture));
}

/**
 * The parent's name comes from their own words, never from a kid's name or a
 * name elsewhere in the facts (the founder's, a sender's).
 */
function ownNameOnly(capture: OnboardingCapture, input: FriendVoiceInput): OnboardingCapture {
  const name = capture.parentName?.trim();
  if (!name) return capture;
  const fold = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const first = fold(name).split(/\s+/u)[0] ?? '';
  const words = new Set(fold(input.parentWords).split(/[^\p{L}'’-]+/u));
  const kids = [...(input.children ?? []), ...capture.children].map((kid) => fold(kid.name ?? ''));
  if (words.has(first) && !kids.includes(fold(name)) && !kids.includes(first)) return capture;
  return { ...capture, parentName: null };
}

/** The join number or phrase, written into the prose instead of riding below it. */
function carriesJoin(prose: string, join: { line: string; phrase: string }): boolean {
  const digits = join.line.replace(/\D/g, '');
  const proseDigits = prose.replace(/\D/g, '');
  return (
    (digits.length >= 7 && proseDigits.includes(digits.slice(-7))) ||
    prose.toLowerCase().includes(join.phrase.toLowerCase())
  );
}

/** What the retry is told about the draft that was not sent. Plain words for the model. */
function retryProblem(
  reason: FriendJudgeFailure | 'long' | 'schedule' | 'join',
  detail?: string,
  input?: FriendVoiceInput,
): string {
  switch (reason) {
    case 'long':
      return `Too long. Keep the reply under ${MAX_PROSE_CHARS} characters.`;
    case 'join':
      return "Under their yes, code puts Hale's number, and the sentence or the phrase, on their own lines right below. Say they are below and how to use them (coparentJoin.how for the group they chose), without writing them. Hale does not start or join the group; they add it.";
    case 'schedule':
      return 'A scheduleAdd pointed at a line that does not fit that child or is not on the map. Use the n of the line that matches, for a child its ages suit.';
    case 'question':
      return input && ZERO_QUESTION_STEPS.has(input.step)
        ? 'This message asks nothing. No question mark.'
        : `Exactly one question: ${askInWords(input?.step)}. Never ask for something already known.`;
    case 'privacy':
      return 'It made a privacy claim that is not true. Google shares the whole inbox or calendar with Hale; Hale keeps and uses only what is about the kids. Do not say Hale only reads, only sees, or never sees some of it.';
    case 'invented':
      return `It named something not in facts${detail ? ` (${detail})` : ''}. Name only what facts or the parent gave.`;
    case 'premature':
      return 'It says the connector is already on. It is not until they tap the link: on a yes, point them to the link above; on the ask, just ask.';
    case 'topic':
      return input?.step === 'calendar'
        ? 'This message asks to connect their Google Calendar: a trust line from facts.access, then that question.'
        : 'This message asks to connect their Gmail: a trust line from facts.access, then that question.';
    case 'link':
      return 'It mentioned a link that does not go with this message. Do not mention a link.';
    case 'identity':
      return detail === 'price'
        ? 'They asked about price: say in a clause that villagehale.com has the details, including price. Never say it is free or quote a price.'
        : 'You are Hale; talk to the parent, never about them by name, and never call yourself by their name. When they asked who this is, name the company from facts.identity.';
    default:
      return `It broke a rule (${reason}). Write it again, plainly, keeping every rule.`;
  }
}

function askInWords(step: FriendStep | undefined): string {
  switch (step) {
    case 'email':
      return 'ask whether they want to connect their Gmail (one trust line from facts.access first)';
    case 'calendar':
      return 'ask whether they want to connect their Google Calendar (one trust line from facts.access first)';
    case 'schedule':
      return 'ask which of the map activities they want reminders for (suggest one per kid first)';
    case 'coparent':
      return 'ask whether a group chat with the other parent would help';
    case 'names':
    case 'name_confirm':
      return 'ask what to call them';
    case 'kids_names':
      return "ask the kids' first names";
    case 'ages':
      return 'ask how old each kid is';
    case 'place':
      return 'ask their postal code';
    default:
      return 'ask the open item';
  }
}

/** The capture fields a retry may build on: facts and a yes or no to a connector. */
function settledFacts(capture: OnboardingCapture): OnboardingCapture {
  return {
    ...factsOnly(capture),
    nameConfirmed: capture.nameConfirmed,
    connectGmail: capture.connectGmail,
    connectCalendar: capture.connectCalendar,
  };
}

/**
 * The input as it stands after a capture that moved the walk on, or null when
 * the capture did not. Only facts and a yes or no to a connector carry over:
 * a decision read from a refused draft (the group chat, a schedule add) does not.
 */
function advancedInput(
  input: FriendVoiceInput,
  capture: OnboardingCapture,
): { input: FriendVoiceInput; settled: OnboardingCapture } | null {
  if (!input.checklist || input.step === 'find_show' || input.step === 'connected') return null;
  const settled = settledFacts(capture);
  const judged = judgeInputFor(input, settled);
  if (judged.step === input.step) return null;
  return {
    input: { ...judged, checklist: checklistAfter(input.checklist, settled) },
    settled,
  };
}

/** The facts a parent stated, without the decisions a refused draft read into them. */
function factsOnly(capture: OnboardingCapture): OnboardingCapture {
  return {
    ...acceptOnboardingCapture(null),
    postalCode: capture.postalCode,
    city: capture.city,
    children: capture.children,
    parentName: capture.parentName,
    parentRole: capture.parentRole,
  };
}

/** Sentences, split after . ! ? or at a line break. Each keeps its punctuation. */
/** Opens a question: "Which of these…?", "Would you…?". */
const QUESTION_OPENER =
  /^(?:which|what|who|when|where|how|would|could|can|do|does|did|is|are|want|should|shall|will)\b/i;
/** A question that only points at the options a later one names: "Which of these would help?" */
const OPTIONS_OPENER =
  /^(?:which|what)\b[^?]{0,40}\b(?:these|those|ones?|options?|activities|programs)\b[^?]{0,40}\?$/i;
const COPARENT_WORDS = /\b(?:group (?:chat|text)|other parent|co-?parent)\b/i;

/**
 * Code's repair of a draft that broke one countable rule. Two or three
 * questions offering choices become one: an earlier question that only opens
 * ("Which of these would help?") is dropped, any other earlier one becomes a
 * statement. A draft over the length limit loses its leading statements until
 * it fits. Empty when there is nothing safe to repair.
 */
export function repairedProse(
  prose: string,
  step: FriendStep,
  children?: readonly { name?: string | null }[],
): string {
  if (ZERO_QUESTION_STEPS.has(step)) return '';
  let sentences = sentencesOf(prose);
  const asks = sentences.filter((sentence) => sentence.includes('?'));
  // Never fold in an ask that belongs to another step.
  if (step !== 'coparent' && asks.some((sentence) => COPARENT_WORDS.test(sentence))) return '';
  if (asks.length > 1) {
    const last = sentences.lastIndexOf(asks[asks.length - 1] ?? '');
    sentences = sentences.flatMap((sentence, index) => {
      if (index === last || !sentence.includes('?')) return [sentence];
      if (OPTIONS_OPENER.test(sentence)) return [];
      // "Do you have kids? If so, …": the later question leans on it. No safe repair.
      if (QUESTION_OPENER.test(sentence)) return ['\u0000'];
      return [sentence.replace(/\?+/g, '.')];
    });
    if (sentences.includes('\u0000')) return '';
  }
  // Too long: filler goes first; who Hale is and the trust line stay longest.
  // A sentence naming a kid is content (the schedule ask's per-kid picks), never filler.
  const keeps = /village ?hale|google shares|\bkeep|disconnect/i;
  const kids = (children ?? [])
    .map((kid) => kid.name?.trim().split(/\s+/u)[0]?.toLowerCase() ?? '')
    .filter((name) => name.length > 1);
  const namesKid = (sentence: string) =>
    kids.some((name) => sentence.toLowerCase().includes(name.slice(0, 3)));
  while (sentences.join(' ').length > MAX_PROSE_CHARS && sentences.length > 1) {
    const drop = sentences.findIndex(
      (sentence) => !sentence.includes('?') && !keeps.test(sentence) && !namesKid(sentence),
    );
    if (drop < 0) break;
    sentences.splice(drop, 1);
  }
  const repaired = sentences.join(' ');
  if (repaired === prose.trim() || repaired.length > MAX_PROSE_CHARS) return '';
  return repaired.includes('?') ? repaired : '';
}

function sentencesOf(text: string): string[] {
  // "Village Hale Technologies Inc. made Hale" is one sentence.
  return text
    .split(/(?<!\b(?:Inc|Ltd|Co|Corp|Mr|Mrs|Ms|Dr|St|Jr|Sr|vs|e\.g|i\.e)\.)(?<=[.!?])\s+|\n+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Code may take words out of a model reply, never put any in. On a step that
 * asks nothing (the map, a wow line, a receipt) a question the model added is
 * dropped rather than failing the whole reply; on a wow line a sentence about
 * the other connector (the next step rides its own bubble) goes too; a map
 * opener or wow line that runs long keeps its leading sentences.
 */
export function tidyProse(
  reply: string,
  input: FriendVoiceInput,
  judgedStep: FriendStep,
  asksNothing = false,
): string {
  let sentences = sentencesOf(reply.trim());
  if (ZERO_QUESTION_STEPS.has(judgedStep) || asksNothing) {
    sentences = sentences.filter((sentence) => !sentence.includes('?'));
  }
  // A wow line, or the reply to a yes whose link is out, is about that one
  // connector: a sentence about the other one goes (its ask comes later).
  const about =
    input.step === 'connected'
      ? input.connector
      : asksNothing && judgedStep === 'email'
        ? 'gmail'
        : asksNothing && judgedStep === 'calendar'
          ? 'gcal'
          : null;
  if (about) {
    const other = about === 'gmail' ? /\b(calendars?|calendrier|agenda)\b/i : /\bgmail\b/i;
    sentences = sentences.filter((sentence) => !other.test(sentence));
  }
  // The map opener is one short framing sentence; the group leads say the rest.
  // A long one that tries to summarise the map goes, and the leads carry it.
  if (input.step === 'find_show') {
    const opener = sentences.find(
      (sentence) =>
        !sentence.includes('?') &&
        sentence.length <= MAP_OPENER_CHARS &&
        sentence.split(/\s+/u).length >= 3,
    );
    sentences = opener ? [opener] : [];
  }
  // A wow line over the limit keeps the sentence with the item (it has its
  // date or time) and loses the filler around it ("I'm watching your inbox.").
  if (input.step === 'connected' && sentences.join(' ').length > MAX_PROSE_CHARS) {
    const facts = sentences.filter((sentence) => /\d/u.test(sentence));
    if (facts.length > 0) sentences = facts;
  }
  if (input.step === 'find_show' || input.step === 'connected') {
    const kept: string[] = [];
    for (const sentence of sentences) {
      if ([...kept, sentence].join(' ').length > MAX_PROSE_CHARS) break;
      kept.push(sentence);
    }
    sentences = kept;
  }
  return ZERO_QUESTION_STEPS.has(judgedStep) || input.step === 'connected' || asksNothing
    ? sentences.join(' ')
    : reply.trim();
}

/** A lead is the model's words over a group. A copied line, a question or a letter is dropped. */
function tidyLeads(
  leads: readonly string[] | null,
  groups: readonly FriendFindGroup[],
): string[] | null {
  if (!leads) return null;
  // One lead per group or none: a lead that sums up every group sits over the
  // wrong lines. One string with a sentence per group is split back into leads.
  let perGroup = leads;
  if (leads.length === 1 && groups.length > 1) {
    const parts = sentencesOf(leads[0] ?? '');
    if (parts.length === groups.length) perGroup = parts;
  }
  if (perGroup.length !== groups.length) return null;
  return groups.map((group, index) => {
    const raw = (perGroup[index] ?? '').trim();
    const lead = sentencesOf(raw)
      .filter((sentence) => !sentence.includes('?'))
      .join(' ');
    // Ages, times and counts are the lines' to state: a lead that restates one can only get it wrong.
    if (lead.length === 0 || lead.length > MAX_LEAD_CHARS || /\d/u.test(lead)) return '';
    // A lead names only what its own lines hold ("swim and Scouts" over two swims is wrong).
    if (activitiesOutsideSlots(lead, group.lines).length > 0) return '';
    const copied = group.lines.some((line) => {
      const a = looseText(line);
      const b = looseText(lead);
      return a.includes(b) || b.includes(a);
    });
    return copied ? '' : lead;
  });
}

export function createFriendVoiceComposer(client: AgentClient | null): FriendVoiceComposer {
  return {
    async compose(input, options) {
      if (!client) throw new Error('onboarding-friend: voice_unavailable');
      const short = options?.prompt === 'short';
      const skill = short
        ? await loadOnboardingFriendShortSkill()
        : await loadOnboardingFriendSkill();
      const { value } = await forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: JSON.stringify(friendVoiceContext(input)),
        toolName: 'reply',
        toolDescription: 'Return the onboarding reply and any facts the parent just gave.',
        inputJsonSchema: replyJsonSchema,
        schema: replySchema,
        maxTokens: short ? SHORT_MAX_TOKENS : MAX_TOKENS,
        transport: llmTransport(),
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
          coparentGroupMode: value.coparentGroupMode,
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
