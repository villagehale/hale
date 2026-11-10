import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { type AhaSnapshot, ahaClockLabel, ahaWhenLabel } from '~/lib/channel/connect/aha-read';
import { type ParentRoleGuess, likelyCoParentRole } from '~/lib/channel/identity/parent-role';
import { friendVoiceLeftoverMarksEnabled } from '~/lib/channel/intake/friend-voice-flag';
import {
  type ReplyLanguage,
  acceptReplyLanguage,
  certainLanguageHint,
  copyLanguage,
  localeFor,
} from '~/lib/channel/language';
import { linqGroupOnboardingV2Enabled } from '~/lib/channel/linq/config';
import { modelReadSweepEnabled } from '~/lib/channel/meaning-screen/flag';
import {
  type CopyFriendViolation,
  sharedMeaningScreen,
} from '~/lib/channel/meaning-screen/read';
import { inProactiveQuietHours } from '~/lib/channel/outbound-gate';
import { claimsNoLedgerCanBack } from '~/lib/channel/reconcile/claims';
import {
  loadCronSkill,
  loadOnboardingFriendShortSkill,
  loadOnboardingFriendSkill,
} from '~/lib/cron/skill';
import { asHandsetReads, linksOutside } from '~/lib/format/link-shape';
import { findInventedFacts } from '~/lib/loop/voice/facts-lint';
import { postOpsSlack } from '~/lib/monitoring/ops-slack';
import { StructuredOutputError, forceToolJson, llmTransport } from '~/lib/pipeline/structured';
import { addDaysToKey, dayKeyIn } from '~/lib/plan/spine';
import type { RateLimiter } from '~/lib/rate-limit/limiter';
import { ageFitCorrectionEnabled } from './age-fit-correction';
import type { HouseholdGroupFact } from './household-group';
import { HALE_IDENTITY, NAMES_HALE_COMPANY } from './identity-challenge';
import {
  ONBOARDING_ORDER,
  type OnboardingCapture,
  type OnboardingChecklist,
  type OnboardingItem,
  type ScheduleLimits,
  acceptOnboardingCapture,
  checklistAfter,
  countRejectedScheduleAdds,
  dropTakeBackName,
  foldMessage,
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
 * (packages/agent/skills/onboarding-friend-short.md). A first attempt that
 * the retry recovers is not a page: the recovery is logged. If the retry
 * also fails, nothing goes out: the miss is logged, #ops is paged, and the
 * next inbound or the morning nudge tries again. That includes the map: the
 * model writes each group bubble from that group's lines, a group it cannot
 * write is not sent, and code never numbers or joins the lines itself.
 * Length is not a reason to refuse a reply; the skill's "short" is tone, not
 * a character cap.
 */

/**
 * The reply plus the capture fields, as one forced tool call. The map turn
 * returns an opener, a bubble per group (up to three) and the kids; a cut-off at max_tokens
 * is a failed attempt, so the budget is well over what a good reply uses. The short
 * retry has the same budget: its prompt is smaller, its answer is not. A reply that
 * fills every optional field ran past 600 tokens live (VIL-617).
 */
const MAX_TOKENS = 1000;

export const ONBOARDING_REPLY_MAX_TOKENS = MAX_TOKENS;
export const ONBOARDING_REPLY_TOOL = 'reply';
export const ONBOARDING_REPLY_TOOL_DESCRIPTION =
  'Return the onboarding reply and any facts the parent just gave.';

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
  /**
   * The model set `asks` on the outbound that produced this turn. Absent on
   * older rows: a question mark in `body` is not a substitute.
   */
  asked?: boolean;
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
  language: ReplyLanguage | null;
  /** 1:1 is tu. A group thread is vous. */
  address: 'tu' | 'vous';
  introduce: boolean;
  /** The turn reader read this inbound as "who is this / is this real" (#868). */
  identityAsked?: boolean;
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
  /**
   * The model already read this message as taking the name back. The reply
   * must not address them by it. Absent means the message may be their name.
   */
  nameTakenBack?: boolean;
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
  /** The reference instant for today, used on the schedule step. Needs {@link timeZone}. */
  now?: Date;
  /**
   * The family's own IANA zone, from their place. Today, the dates the model may
   * name, and every synced time are read in it. Required with `now` or synced items:
   * without it they would be said on someone else's clock.
   */
  timeZone?: string;
  /** What is already on the calendar from this onboarding. */
  scheduled?: readonly FriendScheduled[];
  /** Hale's iMessage line and the group trigger phrase, when the co-parent ask is on iMessage. */
  coparentJoin?: { line: string; phrase: string } | null;
  /** Their answer on the co-parent step, for the closing receipt. */
  coparentGroup?: boolean | null;
  /**
   * VIL-566 — the household group: claimed, pending (a yes and no group yet), or
   * unclaimed (the ask is open and no group exists). Absent when not in play.
   */
  householdGroup?: HouseholdGroupFact | null;
  /**
   * What is already stored, in onboarding order. Absent on older callers.
   * The model uses it as guidance. Code computes it from stored facts.
   */
  checklist?: OnboardingChecklist;
  /**
   * Checklist items code could not read for this family. They are true in
   * `checklist`, so nothing asks for them, and the model sees them as unknown.
   */
  unread?: readonly OnboardingItem[];
  /** On the retry only: the draft that was not sent and why, so the second try fixes that. */
  retry?: { draft: string; problem: string } | null;
  /**
   * VIL-641. Code's record that an earlier reply asked for the coarse code after a
   * first no, so a no now is the second one. Absent when it did not.
   */
  coarseCodeAsked?: boolean;
  /**
   * The place is declined for good. Code refuses a reply that asks for one. Not
   * handed to the model: `checklist` already counts the place as answered.
   */
  placeDeclined?: boolean;
  /**
   * How long ago the parent's last inbound was, when this reply is picking it up
   * after a real wait. Absent when that text just arrived. Facts only.
   */
  lastInbound?: LastInboundFact | null;
}

/**
 * Facts about the parent's last inbound, for a reply that is no longer instant.
 * `minutesAgo` is the wait. `overnight` means that text landed inside proactive
 * quiet hours. `yesterday` means its calendar day is already over. Both are read on
 * the family's own clock, and are null when no zone is known: none is guessed.
 */
export interface LastInboundFact {
  minutesAgo: number;
  overnight: boolean | null;
  yesterday: boolean | null;
}

export interface FriendVoiceResult {
  body: string;
  prose: string;
  /** The bubbles to send, in order. One for most steps; two or three on find_show. */
  bubbles: string[];
  /** `unsent` means both attempts failed: nothing goes to the parent. */
  source: 'composed' | 'retry' | 'unsent';
  fallback: FriendFallback | null;
  /** The step the reply was judged for, once this message's facts were counted. */
  step: FriendStep;
  /** Shape-checked fields from the model. Empty when nothing was stored. */
  capture: OnboardingCapture;
  /** The model's `asks` on the reply that went out. False when nothing was sent. */
  asks: boolean;
  /** The model's `placeAsk` on the reply that went out, when the place was in play. */
  placeAsk?: PlaceAsk | null;
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
  /** This reply asks the parent something. Omitted means the model did not say. */
  asks?: boolean;
  /** Their message is a question, not a yes to Gmail, the calendar, or the group. */
  parentQuestion?: boolean;
  /** Every connector this reply asks, offers, or agrees to connect. */
  connectorsOffered?: readonly OfferedConnector[];
  /** How a co-parent yes points at the number and phrase code places under the reply. */
  joinPointer?: JoinPointer | null;
  /** This reply tells the parent something was saved, added or set this turn. */
  claimsSaved?: boolean;
  /** What this reply asks for about where they live. Null or omitted: the model did not say. */
  placeAsk?: PlaceAsk | null;
  /** How many questions this reply asks. Used when leftover marks are on. */
  asksCount?: number;
  /** This reply asks what to call them. */
  asksName?: boolean;
  /** This reply calls itself by the parent's name, or talks about them by name. */
  speaksAsParent?: boolean;
  /** This reply writes the join number or phrase that code places under it. */
  joinInProse?: boolean;
  /** Their message is a yes to the open item. */
  parentPlainYes?: boolean;
  /** Their message is only their own name, answering the name ask. */
  parentLoneName?: string | null;
}

export type OfferedConnector = 'gmail' | 'calendar';

/** `full` is the postal code or ZIP; `coarse` is the smaller ask after a first no. */
export type PlaceAsk = 'full' | 'coarse' | 'none';

const PLACE_ASKS = ['full', 'coarse', 'none'] as const;

/**
 * The place is in play: its step, or a turn after the coarse code was asked or the
 * place was declined. Only then does the turn carry the place skill and `placeAsk`,
 * so every other turn keeps its bytes.
 */
function placeInPlay(
  input: Pick<FriendVoiceInput, 'step' | 'coarseCodeAsked' | 'placeDeclined'>,
): boolean {
  return (
    input.step === 'place' ||
    input.step === 'place_card' ||
    input.coarseCodeAsked === true ||
    input.placeDeclined === true
  );
}

/** What the model says a co-parent yes does with the number code places under the reply. */
export type JoinPointer = 'below' | 'wrong_owner' | 'placeholder' | 'hale_starts' | 'missing';

const JOIN_POINTERS = new Set<JoinPointer>([
  'below',
  'wrong_owner',
  'placeholder',
  'hale_starts',
  'missing',
]);

/** The connector a card on this step is not for. The link under the reply connects only its own. */
const OTHER_CONNECTOR: Partial<Record<FriendStep, OfferedConnector>> = {
  email: 'calendar',
  calendar: 'gmail',
};

/** The four decisions the model makes instead of a text match. Omitted is "did not say". */
function replyMarks(composed: FriendComposed): {
  asks: boolean;
  parentQuestion: boolean;
  offered: readonly OfferedConnector[];
  joinPointer: JoinPointer | null;
  claimsSaved: boolean;
  placeAsk: PlaceAsk | null;
} {
  const pointer = composed.joinPointer;
  return {
    placeAsk: composed.placeAsk ?? null,
    asks: composed.asks === true,
    parentQuestion: composed.parentQuestion === true,
    offered: composed.connectorsOffered ?? [],
    joinPointer: pointer != null && JOIN_POINTERS.has(pointer) ? pointer : null,
    claimsSaved: composed.claimsSaved === true,
  };
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
  /** Leftover marks: question count the model reported, not a '?' count. */
  asksCount?: number;
  asksName?: boolean;
  speaksAsParent?: boolean;
  /** Skip the five meaning checks the Haiku screen owns when the sweep is on. */
  skipMeaning?: boolean;
};

const childSchema = z.object({
  name: z.string().nullable().optional().default(null),
  ageMonths: z.number().nullable().optional().default(null),
  agePrecision: z.enum(['years', 'months']).nullable().optional().default(null),
  dateOfBirth: z.string().nullable().optional().default(null),
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

/** A list the model wrote as JSON text inside one string, read back as its elements. */
function splitLeadString(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((item) => leadText(item).trim());
    } catch {
      // Not JSON after all: the string is one bubble.
    }
  }
  return [trimmed];
}

/**
 * The model's group bubbles, one per element. A bubble may hold line breaks
 * (one line per program): those stay inside it and are never split into
 * separate bubbles.
 */
export function readGroupLeads(value: unknown): string[] | null {
  if (value == null) return null;
  if (typeof value === 'string') return splitLeadString(value);
  if (Array.isArray(value)) return value.map((item) => leadText(item).trim());
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).map((item) => leadText(item).trim());
  }
  return null;
}

const replyFields = z.object({
  reply: z
    .string()
    .nullish()
    .transform((value) => value ?? ''),
  // Group bubbles come back in more than one shape (a list, a JSON list inside
  // a string, the group objects they were written for); each element is one bubble.
  groupLeads: z
    .unknown()
    .optional()
    .transform((value) => readGroupLeads(value)),
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
  nameTakenBack: z.boolean().optional().default(false).catch(false),
  kidsNamesDeclined: z.boolean().optional().default(false).catch(false),
  placeDeclined: z.boolean().optional().default(false).catch(false),
  calendarLater: z.boolean().optional().default(false).catch(false),
  gmailLater: z.boolean().optional().default(false).catch(false),
  stopAsking: z.boolean().optional().default(false).catch(false),
  asks: z.boolean().optional().default(false).catch(false),
  // Read with the rest of the turn below: whether a missing value is a question
  // depends on whether the turn holds a yes.
  parentQuestion: z.unknown(),
  claimsSaved: z.boolean().optional().default(false).catch(false),
  connectorsOffered: z
    .array(z.enum(['gmail', 'calendar']))
    .optional()
    .default([])
    .catch([]),
  joinPointer: z
    .enum(['below', 'wrong_owner', 'placeholder', 'hale_starts', 'missing'])
    .nullable()
    .optional()
    .default(null)
    .catch(null),
  ahaMention: z.string().nullable().optional().default(null).catch(null),
  placeAsk: z.enum(PLACE_ASKS).nullable().optional().default(null).catch(null),
  asksCount: z.number().optional(),
  asksName: z.boolean().optional(),
  speaksAsParent: z.boolean().optional(),
  joinInProse: z.boolean().optional(),
  parentPlainYes: z.boolean().optional(),
  parentLoneName: z.string().nullable().optional().default(null).catch(null),
  // BCP-47, or null when the model omits it. A sentence is not a tag.
  language: z.string().nullable().optional().default(null).catch(null),
});

const replySchema = replyFields.transform((value) => ({
  ...value,
  parentQuestion: readParentQuestion(value),
}));

/**
 * Fails closed: a value that is there but not a boolean may hide a question, and a
 * question must never stand as a yes. A missing value is a question too when the turn
 * holds a yes, because a consent turn the model did not mark must not keep one.
 */
function readParentQuestion(value: {
  parentQuestion?: unknown;
  connectGmail: boolean | null;
  connectCalendar: boolean | null;
  coparentGroup: boolean | null;
}): boolean {
  if (value.parentQuestion === undefined) {
    return (
      value.connectGmail === true || value.connectCalendar === true || value.coparentGroup === true
    );
  }
  return value.parentQuestion !== false;
}

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
          dateOfBirth: { type: ['string', 'null'] },
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
    nameTakenBack: { type: 'boolean' },
    kidsNamesDeclined: { type: 'boolean' },
    placeDeclined: { type: 'boolean' },
    calendarLater: { type: 'boolean' },
    gmailLater: { type: 'boolean' },
    stopAsking: { type: 'boolean' },
    asks: { type: 'boolean' },
    parentQuestion: { type: 'boolean' },
    connectorsOffered: { type: 'array', items: { type: 'string', enum: ['gmail', 'calendar'] } },
    joinPointer: {
      type: ['string', 'null'],
      enum: ['below', 'wrong_owner', 'placeholder', 'hale_starts', 'missing', null],
    },
    ahaMention: { type: ['string', 'null'] },
    language: { type: ['string', 'null'] },
    claimsSaved: { type: 'boolean' },
  },
  // Code reads these instead of the reply's words, so the model always says.
  required: ['reply', 'asks', 'parentQuestion', 'connectorsOffered', 'joinPointer', 'claimsSaved'],
} as const;

const LEFTOVER_MARK_PROPERTIES = {
  asksCount: { type: 'number' },
  asksName: { type: 'boolean' },
  speaksAsParent: { type: 'boolean' },
  joinInProse: { type: 'boolean' },
  parentPlainYes: { type: 'boolean' },
  parentLoneName: { type: ['string', 'null'] },
} as const;

/**
 * Flag off omits the choice field, so the tool the model fills is today's. `placeAsk`
 * rides only while the place is in play; without a turn it is not.
 */
export function onboardingReplyToolSchema(
  input?: Pick<FriendVoiceInput, 'step' | 'coarseCodeAsked' | 'placeDeclined'>,
): {
  type: 'object';
  properties: Record<string, unknown>;
  required: readonly string[];
} {
  const { coparentGroupMode: _choice, ...flagOff } = replyJsonSchema.properties;
  const schema = linqGroupOnboardingV2Enabled()
    ? replyJsonSchema
    : { ...replyJsonSchema, properties: flagOff };
  const leftover = friendVoiceLeftoverMarksEnabled()
    ? {
        ...schema,
        properties: { ...schema.properties, ...LEFTOVER_MARK_PROPERTIES },
        required: [...schema.required, ...Object.keys(LEFTOVER_MARK_PROPERTIES)],
      }
    : schema;
  if (!input || !placeInPlay(input)) return leftover;
  return {
    ...leftover,
    properties: { ...leftover.properties, placeAsk: { type: 'string', enum: PLACE_ASKS } },
    required: [...leftover.required, 'placeAsk'],
  };
}

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
  transcript: readonly { direction: 'in' | 'out'; body: string; asked?: boolean }[],
): FriendTurn[] {
  return transcript.slice(-8).map((entry) => ({
    role: entry.direction === 'in' ? 'parent' : 'hale',
    body: entry.body,
    ...(entry.asked === true ? { asked: true } : {}),
  }));
}

interface DayLabel {
  date: string;
  label: string;
}

function dayLabel(dayKey: string, language: ReplyLanguage | null): string {
  const [year, month, day] = dayKey.split('-').map((part) => Number(part));
  if (!year || !month || !day) return dayKey;
  return new Intl.DateTimeFormat(localeFor(language), {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

/** Today and the next three weeks, as the only dates the model may name. */
export function upcomingDays(
  now: Date,
  timeZone: string,
  language: ReplyLanguage | null,
): DayLabel[] {
  const today = dayKeyIn(now, timeZone);
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
  timeZone: string | null,
): LastInboundFact | null {
  const elapsedMs = now.getTime() - inboundAt.getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  const minutesAgo = Math.floor(elapsedMs / 60_000);
  if (minutesAgo < LAST_INBOUND_MARK_MINUTES) return null;
  if (timeZone === null) return { minutesAgo, overnight: null, yesterday: null };
  return {
    minutesAgo,
    overnight: inProactiveQuietHours(inboundAt, timeZone),
    yesterday: dayKeyIn(inboundAt, timeZone) < dayKeyIn(now, timeZone),
  };
}

/** An item code could not read is unknown to the model, never false. */
function knownForModel(
  checklist: OnboardingChecklist | null,
  unread: readonly OnboardingItem[] | undefined,
): Record<OnboardingItem, boolean | null> | null {
  if (!checklist || !unread || unread.length === 0) return checklist;
  return Object.fromEntries(
    ONBOARDING_ORDER.map((item) => [item, unread.includes(item) ? null : checklist[item]]),
  ) as Record<OnboardingItem, boolean | null>;
}

/** What the model is handed. No link, no family id, no phone. */
export function friendVoiceContext(input: FriendVoiceInput): unknown {
  const checklist = input.checklist ?? null;
  const now = input.now ?? null;
  const today = now ? dayKeyIn(now, familyZone(input)) : null;
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
  // The parent's words decide the reply's language (#868). A stored tag is for a
  // message Hale sends on its own; beside their words it only pulled the retry
  // into French for an English parent (VIL-538).
  const theirWords = input.parentWords.trim().length > 0;
  const french = copyLanguage(input.language) === 'fr';
  return {
    step: input.step,
    languageHint: theirWords ? null : certainLanguageHint(input.language),
    // tu/vous is French-only; sent bare it pulled English and Chinese hellos into French.
    // A group's vous is the thread's, so it stays beside their words.
    ...(french && (!theirWords || input.address === 'vous') ? { address: input.address } : {}),
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
    known: knownForModel(checklist, input.unread),
    missing,
    answering: ASKS_NOTHING.has(input.step) ? null : (missing?.[0] ?? null),
    reading: readingForModel(input),
    next: ASKS_NOTHING.has(input.step) ? null : (missing?.[1] ?? null),
    facts: {
      placeLabel: input.placeLabel,
      // Absent unless set, so a turn without it keeps its prompt bytes.
      ...(input.coarseCodeAsked === true ? { coarseCodeAsked: true } : {}),
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
      upcomingDays:
        input.step === 'schedule' && now
          ? upcomingDays(now, familyZone(input), input.language)
          : null,
      scheduled: input.scheduled ?? [],
      // Code puts the join data under the reply; the model only knows it is there.
      // Flag off is today's phrase. Flag on names the choice and never a phrase to text.
      coparentJoin: input.coparentJoin
        ? linqGroupOnboardingV2Enabled()
          ? {
              below:
                'when coparentGroupMode is existing, the number on its own line under the reply',
              how: 'they add Hale to the iMessage group they already have, or Hale starts a new one. A plain yes names neither. An MMS, Android, or green-bubble group cannot add this number.',
            }
          : {
              below: 'the number and a short phrase, on their own lines',
              how: 'start a group text with the other parent and the number below, then send the phrase below in it',
            }
        : null,
      coparentGroup: input.coparentGroup ?? null,
      // Absent when not in play, so a turn with no group in it keeps its prompt bytes.
      ...(input.householdGroup ? { householdGroup: input.householdGroup } : {}),
      // Who runs Hale is for when they ask; otherwise the founder's name is
      // one more name the model could take for the parent's.
      identity: input.introduce || input.identityAsked ? HALE_IDENTITY : null,
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
 * The open name ask, as the name-capture reader hands it to the model. The ask
 * is the structured `answering` fact; no Hale turn is written here. `stored` is
 * the family's onboarding checklist; null when it cannot be read, and then every
 * item but the name is unknown and nothing else is asked.
 */
export function nameAskVoiceInput(
  parentWords: string,
  language: ReplyLanguage | null,
  stored: OnboardingChecklist | null,
): FriendVoiceInput {
  const unread = stored ? [] : ONBOARDING_ORDER.filter((item) => item !== 'name');
  const checklist = stored
    ? { ...stored, name: false }
    : (Object.fromEntries(
        ONBOARDING_ORDER.map((item) => [item, item !== 'name']),
      ) as OnboardingChecklist);
  return {
    step: 'names',
    language,
    address: 'tu',
    introduce: false,
    parentWords,
    recentTurns: [],
    placeLabel: null,
    agesLabel: null,
    ageMonths: [],
    children: [],
    findLines: [],
    listKind: 'none',
    activity: null,
    day: null,
    parentName: null,
    checklist,
    ...(unread.length > 0 ? { unread } : {}),
  };
}

/**
 * What code can read from the parent's words without the model: a lone name
 * after the name ask, or a plain yes to a connector or the group chat. The
 * model is told, and the capture is held to it. A model `nameDeclined` is not
 * replaced by that lone name.
 */
export function parentReading(
  input: FriendVoiceInput,
): { kind: 'name'; name: string } | { kind: 'yes'; item: OnboardingItem } | null {
  // Flag on: the model names a yes or a lone name. EN/FR word lists are not the signal.
  if (friendVoiceLeftoverMarksEnabled()) return null;
  const words = input.parentWords.trim();
  const item = answeringItem(input);
  if (!item) return null;
  // A plain "ok" answers only when the previous reply's model field said it asked.
  // A question mark in that text, in any script, is not the signal.
  const lastHale = [...input.recentTurns].reverse().find((turn) => turn.role === 'hale');
  if (lastHale?.asked !== true) return null;
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
  const reading = parentReading(input);
  if (!reading) return null;
  return reading.kind === 'name'
    ? `parentWords is their name (${reading.name}): it answers the name ask`
    : `parentWords is a yes to ${reading.item}`;
}

/**
 * The group the model read. Flag off clears it, so a yes stays today's new-group
 * claim. Flag on keeps the model's enum and never a regex, and never defaults a
 * plain yes to the group they already have. An existing group only counts when
 * this chat can hold the iMessage number. MMS and a green bubble cannot, so an
 * existing-group reading becomes a new group Hale starts.
 */
function withGroupMode(capture: OnboardingCapture, input: FriendVoiceInput): OnboardingCapture {
  if (!linqGroupOnboardingV2Enabled() || capture.coparentGroup !== true) {
    return { ...capture, coparentGroupMode: null };
  }
  const mode =
    capture.coparentGroupMode === 'existing' || capture.coparentGroupMode === 'new'
      ? capture.coparentGroupMode
      : null;
  if (mode === 'existing' && input.coparentJoin == null) {
    return { ...capture, coparentGroupMode: 'new' };
  }
  return { ...capture, coparentGroupMode: mode };
}

/**
 * A question is not a yes. The model says so with `parentQuestion`; a question
 * mark in the parent's words, in any script, is not the signal.
 */
function noYesInAQuestion(capture: OnboardingCapture, parentQuestion: boolean): OnboardingCapture {
  if (!parentQuestion) return capture;
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
function withReading(
  capture: OnboardingCapture,
  input: FriendVoiceInput,
  composed?: FriendComposed,
): OnboardingCapture {
  if (friendVoiceLeftoverMarksEnabled()) {
    return withModelReading(capture, input, composed);
  }
  const reading = parentReading(input);
  if (!reading) return capture;
  if (reading.kind === 'name') {
    // A take-back or a lasting no is the model's. A lone capital word does not replace it.
    if (capture.nameDeclined || capture.nameTakenBack) return capture;
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

/**
 * The hold, from the model's leftover fields. A missing field is not a yes
 * and not a name: code never fills one from the parent's words.
 */
function withModelReading(
  capture: OnboardingCapture,
  input: FriendVoiceInput,
  composed?: FriendComposed,
): OnboardingCapture {
  const item = answeringItem(input);
  if (!item) return capture;
  const lastHale = [...input.recentTurns].reverse().find((turn) => turn.role === 'hale');
  if (lastHale?.asked !== true) return capture;
  const lone = composed?.parentLoneName?.trim() ?? '';
  if (item === 'name' && lone.length > 0) {
    if (capture.nameDeclined || capture.nameTakenBack) return capture;
    const kids = (input.children ?? []).map((kid) => (kid.name ?? '').toLowerCase());
    if (capture.parentName || kids.includes(lone.toLowerCase())) return capture;
    return { ...capture, parentName: lone };
  }
  if (composed?.parentPlainYes !== true) return capture;
  if (item === 'gmail') return { ...capture, connectGmail: true, gmailLater: false };
  if (item === 'calendar') return { ...capture, connectCalendar: true, calendarLater: false };
  if (item === 'schedule') return { ...capture, scheduleDone: true };
  if (item === 'coparent') return { ...capture, coparentGroup: true };
  return capture;
}

/**
 * The family's zone, for a dated fact. A dated fact with no zone would be said on
 * someone else's clock: a caller bug, not a reply to write.
 */
function familyZone(input: FriendVoiceInput): string {
  if (!input.timeZone) throw new Error('friend voice: dated facts need the family time zone');
  return input.timeZone;
}

/** Labels the model may quote. Both languages are slots, so a French reply can name samedi. */
function syncedForModel(input: FriendVoiceInput): unknown {
  const synced = input.synced;
  if (!synced) return null;
  return {
    read: synced.read,
    calendar: synced.calendar.map((item) => ({
      title: item.title,
      when: ahaWhenLabel(item.start, item.allDay, familyZone(input), input.language),
      clock: item.allDay ? null : ahaClockLabel(item.start, familyZone(input)),
      location: item.location,
      declined: item.declined,
    })),
    email: synced.email.map((item) => ({
      subject: item.subject,
      fromName: item.fromName,
      when: item.receivedAt
        ? ahaWhenLabel(item.receivedAt, false, familyZone(input), input.language)
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
    const zone = familyZone(input);
    for (const day of upcomingDays(input.now, zone, 'en')) slots.push(day.label);
    for (const day of upcomingDays(input.now, zone, 'fr')) slots.push(day.label);
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
export function instantFactSlots(start: string, allDay: boolean, timeZone: string): string[] {
  const slots: string[] = [];
  const instant = allDay ? new Date(`${start}T12:00:00Z`) : new Date(start);
  if (Number.isNaN(instant.getTime())) return slots;
  const zone = allDay ? 'UTC' : timeZone;
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
      timeZone,
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
    const zone = familyZone(input);
    slots.push(item.title);
    if (item.location) slots.push(item.location);
    slots.push(ahaWhenLabel(item.start, item.allDay, zone, 'en'));
    slots.push(ahaWhenLabel(item.start, item.allDay, zone, 'fr'));
    const clock = item.allDay ? null : ahaClockLabel(item.start, zone);
    if (clock) slots.push(clock);
    slots.push(...instantFactSlots(item.start, item.allDay, zone));
  }
  for (const item of synced.email) {
    slots.push(item.subject);
    if (item.fromName) slots.push(item.fromName);
    if (item.snippet) slots.push(item.snippet);
    if (item.receivedAt) {
      const zone = familyZone(input);
      slots.push(ahaWhenLabel(item.receivedAt, false, zone, 'en'));
      slots.push(ahaWhenLabel(item.receivedAt, false, zone, 'fr'));
      const clock = ahaClockLabel(item.receivedAt, zone);
      if (clock) slots.push(clock);
      slots.push(...instantFactSlots(item.receivedAt, false, zone));
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
 * The activity map as bubbles, every one written by the model: the opener,
 * then the bubble it wrote for each group, in group order. A group with no
 * lines has no bubble; speakFriend refuses a map short of any other group.
 * Code adds no numbers and no lines.
 */
export function assembleFindShowBubbles(
  opener: string,
  groups: readonly FriendFindGroup[],
  leads: readonly string[] | null | undefined,
): string[] {
  const bubbles: string[] = [];
  const lead = opener.trim();
  if (lead.length > 0) bubbles.push(lead);
  groups.forEach((group, index) => {
    if (!group.lines.some((line) => line.trim().length > 0)) return;
    const written = (leads?.[index] ?? '').trim();
    if (written.length > 0) bubbles.push(written);
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

/** Question marks in every script the parent may write in: ? (Latin), ？ (CJK full-width), ؟ (Arabic). */
const QUESTION_MARKS = new Set(['?', '\uFF1F', '\u061F']);

function questionMarks(text: string): number {
  const prose = text.replace(/https?:\/\/\S+/g, '');
  return [...prose].filter((char) => QUESTION_MARKS.has(char)).length;
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
 * postal code is a guess, and a guess said as fact.
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

/**
 * A fact check on Hale's draft, not a reading of the parent: the model has
 * already marked this message as a take-back or a turned-down name
 * (`nameTakenBack`), and the draft still uses that whole message as a name
 * (quoted, capitalised, or ending a sentence). The parent's words are only the
 * literal compared against; nothing here decides what they meant.
 */
function replyAddressesByOtherName(reply: string, input: FriendVoiceInput): boolean {
  if (!input.nameTakenBack) return false;
  const message = input.parentWords.trim().replace(/[.!]+$/u, '');
  const folded = foldMessage(message);
  if (folded.length === 0) return false;
  for (const match of reply.matchAll(/["“«']\s*([^"”»']+?)\s*["”»']/gu)) {
    if (foldMessage(match[1] ?? '') === folded) return true;
  }
  const title = message.replace(/(^|\s)(\p{L})/gu, (_gap, space: string, letter: string) => {
    return `${space}${letter.toUpperCase()}`;
  });
  if (new RegExp(`(?<![\\p{L}\\p{M}])${escapeRegExp(title)}(?![\\p{L}\\p{M}])`, 'u').test(reply)) {
    return true;
  }
  const sentences = reply.split(/(?<=[.!?])\s+|\n+/u);
  for (const sentence of sentences) {
    const token =
      sentence
        .replace(/[.!?]+$/u, '')
        .trim()
        .split(/\s+/u)
        .at(-1) ?? '';
    if (foldMessage(token) === folded) return true;
  }
  return false;
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
  | 'question'
  | 'banned'
  | 'compliance'
  | 'invented'
  | 'link'
  | 'registration_claim'
  | 'identity'
  | 'topic'
  | 'premature';

function trailerFacts(options: JudgeOptions): string[] {
  return options.trailer ? [options.trailer] : [];
}

/**
 * The link allow-list: the only words a reply's links may be. The fact slots ground names,
 * dates and places, but they hold third-party text (synced calendar titles and locations,
 * email subjects and snippets, listing lines, Hale's own earlier turns that repeated
 * them), so a link is never grounded by one. A link may be the one code handed this
 * bubble, Hale's own site, a line code appends under the prose, or a bare domain the
 * parent wrote. A scheme link from the parent's words is still refused: scheme words are
 * found in the handset reading, so a full-width ':' or '/' is a scheme too.
 */
function linkAllowList(input: FriendVoiceInput, options: JudgeOptions): string[] {
  const theirs = [
    input.parentWords,
    ...input.recentTurns.filter((turn) => turn.role === 'parent').map((turn) => turn.body),
  ].map((words) =>
    asHandsetReads(words)
      .split(/\s+/)
      .filter((word) => !word.includes('://'))
      .join(' '),
  );
  return [
    ...theirs,
    ...(options.link ? [options.link] : []),
    ...trailerFacts(options),
    HALE_IDENTITY.site,
    `https://${HALE_IDENTITY.site}`,
    HALE_IDENTITY.contact,
  ];
}

/**
 * `detail` is for the retry and may quote the draft. `kinds` is what a log may
 * carry: fixed codes, never the draft's words.
 */
export type FriendJudgeRefusal = {
  ok: false;
  reason: FriendJudgeFailure;
  detail?: string;
  kinds?: readonly string[];
  /** How many draft strings the judge matched. */
  count?: number;
};

export function judgeFriendReply(
  body: string,
  input: FriendVoiceInput,
  options: JudgeOptions = {},
): { ok: true } | FriendJudgeRefusal {
  const trimmed = body.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };
  const needed = ZERO_QUESTION_STEPS.has(input.step) ? 0 : 1;
  const leftover = friendVoiceLeftoverMarksEnabled();
  const groupLines = (input.findGroups ?? []).flatMap((group) => group.lines);
  const asked = leftover
    ? typeof options.asksCount === 'number'
      ? options.asksCount
      : null
    : questionsBeyondFacts(trimmed, [...input.findLines, ...groupLines, ...trailerFacts(options)]);
  const flex =
    FLEX_QUESTION_STEPS.has(input.step) ||
    (options.yesToLink === true && LINK_STEPS.has(input.step)) ||
    options.scheduleRecorded === true;
  if (asked == null) return { ok: false, reason: 'question' };
  if (flex) {
    if (asked > 1) return { ok: false, reason: 'question' };
  } else if (asked !== needed) {
    return { ok: false, reason: 'question' };
  }
  // The question may sit anywhere in the prose, but never above a list it asks about.
  if (!leftover && asked === 1 && /[?\uFF1F\u061F][\s\S]*\n\s*\d+\.\s/u.test(trimmed))
    return { ok: false, reason: 'question' };
  if (leftover ? options.asksName === true : NAME_ASK.test(trimmed)) {
    if (!NAME_STEPS.has(input.step)) return { ok: false, reason: 'question' };
  }
  // Hale is Hale. A reply that answers "Barton" with "I'm Barton" has the roles backwards.
  if (leftover ? options.speaksAsParent === true : speaksAsParent(trimmed, input.parentName)) {
    return { ok: false, reason: 'identity' };
  }
  if (replyAddressesByOtherName(trimmed, input)) {
    return { ok: false, reason: 'identity', detail: 'unknown_name', kinds: ['unknown_name'] };
  }
  const skipMeaning = options.skipMeaning === true;
  if (!skipMeaning) {
    if (FALSE_PRIVACY.test(trimmed)) return { ok: false, reason: 'privacy' };
    if (BANNED_PHRASE.test(trimmed)) return { ok: false, reason: 'banned' };
    if (COMPLIANCE.test(trimmed)) return { ok: false, reason: 'compliance' };
    if (REGISTRATION_CLAIM.test(trimmed)) return { ok: false, reason: 'registration_claim' };
  }
  // Who is behind this number is a disclosure: when they asked, the company is named.
  if (input.identityAsked && !NAMES_HALE_COMPANY.test(trimmed)) {
    return { ok: false, reason: 'identity' };
  }
  // Asked about price: Hale does not quote one, it points to the site.
  if (
    !ASKS_NOTHING.has(input.step) &&
    /\b(?:free|cost|costs|price|pricing|pay|charge|gratuit|co[uû]te?)\b/i.test(input.parentWords) &&
    !/villagehale\.com|\b(?:the|our) (?:web)?site\b|\bsite web\b/i.test(trimmed)
  ) {
    return { ok: false, reason: 'identity', detail: 'price', kinds: ['price'] };
  }

  const slots = friendFactSlots(input, options.link);
  for (const fact of trailerFacts(options)) slots.push(fact);
  const found: [kind: string, matched: string[]][] = skipMeaning
    ? [
        ['phone', PHONE.test(trimmed) ? ['phone number'] : []],
        ['domain', linksOutside(trimmed, linkAllowList(input, options))],
        ['price', mentionsOutsideSlots(trimmed, PRICE, slots)],
      ]
    : [
        ['fact', findInventedFacts(trimmed, slots)],
        ['price', mentionsOutsideSlots(trimmed, PRICE, slots)],
        ['weekday', weekdaysOutsideSlots(trimmed, [...slots, ...weekdaysOfDates(slots, input.now)])],
        ['price_talk', priceTalk(trimmed, input)],
        ['quote', quotesOutsideSlots(trimmed, slots)],
        ['name', namesOutsideSlots(trimmed, slots)],
        ['phone', PHONE.test(trimmed) ? ['phone number'] : []],
        ['domain', linksOutside(trimmed, linkAllowList(input, options))],
        ['activity', input.step !== 'email' ? activitiesOutsideSlots(trimmed, slots) : []],
      ];
  const invented = found.flatMap(([, matched]) => matched);
  if (invented.length > 0) {
    return {
      ok: false,
      reason: 'invented',
      detail: invented.join(','),
      count: invented.length,
      kinds: found.filter(([, matched]) => matched.length > 0).map(([kind]) => kind),
    };
  }

  // "The link" is true only when a link rides this bubble, or when the card is
  // already on the thread and the reply points back at it.
  if (DANGLING_LINK.test(trimmed)) {
    const attached = Boolean(options.link && trimmed.includes(options.link));
    const above = options.linkAbove === true && LINK_ABOVE.test(trimmed);
    const follows = options.linkFollows === true && LINK_STEPS.has(input.step);
    if (!attached && !follows && !above) return { ok: false, reason: 'link' };
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
      return {
        ok: false,
        reason: 'invented',
        detail: 'gmail on calendar wow',
        kinds: ['other_connector'],
      };
    }
    if (input.connector === 'gmail' && namesCalendar) {
      return {
        ok: false,
        reason: 'invented',
        detail: 'calendar on gmail wow',
        kinds: ['other_connector'],
      };
    }
    const grounded = ahaGrounding(trimmed, input, named);
    if (grounded) return { ok: false, reason: 'invented', detail: grounded, kinds: ['aha'] };
  }
  return { ok: true };
}

const COPY_FRIEND_REASON: Record<CopyFriendViolation, FriendJudgeFailure> = {
  privacy: 'privacy',
  banned: 'banned',
  compliance: 'compliance',
  registration: 'registration_claim',
  invented: 'invented',
};

/**
 * The production judge. Off, the regex path. On, the five meaning checks are a
 * Haiku read; unread fails closed (nothing is sent). Shape checks still run in
 * code either way.
 */
export async function judgeFriendReplySweep(
  body: string,
  input: FriendVoiceInput,
  options: JudgeOptions = {},
): Promise<{ ok: true } | FriendJudgeRefusal> {
  if (!modelReadSweepEnabled()) return judgeFriendReply(body, input, options);
  const shaped = judgeFriendReply(body, input, { ...options, skipMeaning: true });
  if (!shaped.ok) return shaped;
  const facts = friendFactSlots(input, options.link);
  for (const fact of trailerFacts(options)) facts.push(fact);
  const reading = await sharedMeaningScreen().read({
    screen: 'copy_friend',
    text: body,
    facts,
  });
  if (!reading) return { ok: false, reason: 'banned', kinds: ['unjudged'] };
  if (reading.hit && reading.violations.length === 0) return { ok: true };
  const codes = reading.violations.filter((code): code is CopyFriendViolation =>
    code in COPY_FRIEND_REASON,
  );
  const first = codes[0] ?? 'banned';
  const reason = COPY_FRIEND_REASON[first] ?? 'banned';
  return {
    ok: false,
    reason,
    kinds: codes.length > 0 ? codes : ['unjudged'],
    count: Math.max(codes.length, 1),
  };
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
    asks: false,
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
    today: input.now ? dayKeyIn(input.now, familyZone(input)) : null,
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
  const withPre = (capture: OnboardingCapture): OnboardingCapture => {
    if (!pre) return capture;
    const merged = mergeCaptures(pre.settled, capture);
    if (!capture.nameDeclined && !capture.nameTakenBack) return merged;
    return {
      ...merged,
      parentName: capture.parentName,
      // A later take-back must not wipe a refusal an earlier pass already settled.
      nameDeclined: merged.nameDeclined || capture.nameDeclined,
      nameTakenBack: capture.nameTakenBack,
    };
  };
  const finish = (
    prose: string,
    bubbles: string[],
    source: FriendVoiceResult['source'],
    turnCapture: OnboardingCapture,
    step: FriendStep,
    asks: boolean,
    placeAsk: PlaceAsk | null,
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
      asks,
      placeAsk,
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
    return unsent('voice_unavailable', input.step);
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
        asks: boolean;
        placeAsk: PlaceAsk | null;
      }
    | {
        fail: FriendFallback;
        capture: OnboardingCapture;
        retry?: FriendVoiceInput['retry'];
      }
  > => {
    // The full attempt still has the short retry, so a refusal that can still
    // recover is a warning. The short attempt is the last one: its refusal is the
    // error, and failed() pages #ops through page() (a log alone pages nobody).
    const terminal = prompt === 'short';
    const noteRefusal = (fields: Record<string, unknown>, kind: 'unusable' | 'compose'): void => {
      if (terminal) {
        console.error(
          fields,
          kind === 'compose'
            ? 'onboarding-friend: compose failed'
            : 'onboarding-friend: unusable reply',
        );
        return;
      }
      console.warn(fields, 'onboarding-friend: attempt refused');
    };
    const empty = acceptOnboardingCapture(null);
    try {
      const composed = await withTimeout(composer.compose(input, { prompt }), timeoutMs);
      const marks = replyMarks(composed);
      const limits = scheduleLimits(input);
      // A message Hale sends on its own (a card, a receipt) answers nothing:
      // there are no parent words to read a yes or a fact from.
      const capture =
        input.parentWords.trim().length > 0
          ? placeOpenUntilCoarseAsked(
              dropTakeBackName(
                input.parentWords,
                settleSchedule(
                  withGroupMode(
                    withReading(
                      noYesInAQuestion(
                        ownNameOnly(acceptOnboardingCapture(composed.capture, limits), input),
                        marks.parentQuestion,
                      ),
                      input,
                      composed,
                    ),
                    input,
                  ),
                ),
              ),
              input,
            )
          : empty;
      const draft = composed.reply.trim();
      if (options.replyDiscardedWhen?.(capture)) {
        return {
          prose: '',
          bubbles: [],
          capture,
          step: input.step,
          asks: marks.asks,
          placeAsk: marks.placeAsk,
        };
      }
      // A refused add means the reply may confirm a reminder that was never written.
      const refusedAdds = countRejectedScheduleAdds(composed.capture, limits);
      if (refusedAdds > 0) {
        noteRefusal(
          {
            reason: 'schedule_add_refused',
            refusedAdds,
            step: input.step,
            prompt,
          },
          'unusable',
        );
        return {
          fail: 'unusable',
          capture,
          retry: { draft, problem: retryProblem('schedule') },
        };
      }
      // The claim gate, onboarding's half (VIL-538): this lane sends straight to the
      // transport, past the dispatch choke point. The only calendar write onboarding
      // makes is this turn's accepted adds, so a reply that says something was saved
      // is checked against them, in any language, by the model's own field.
      if (marks.claimsSaved && capture.scheduleAdds.length === 0) {
        noteRefusal({ reason: 'unbacked_save', step: input.step, prompt }, 'unusable');
        return {
          fail: 'unusable',
          capture,
          retry: { draft, problem: retryProblem('unbacked_save') },
        };
      }
      // VIL-641: once the place is declined, a reply that asks for one goes back to
      // the model, read from its own field. An omitted field is not a refusal.
      const placeClosed = capture.placeDeclined || input.placeDeclined === true;
      if (placeClosed && (marks.placeAsk === 'full' || marks.placeAsk === 'coarse')) {
        noteRefusal({ reason: 'place_closed', step: input.step, prompt }, 'unusable');
        return {
          fail: 'unusable',
          capture,
          retry: { draft, problem: retryProblem('place_closed') },
        };
      }
      const judgeInput = {
        ...judgeInputFor(input, capture),
        nameTakenBack:
          capture.nameTakenBack ||
          capture.nameDeclined ||
          (capture.nameConfirmed === false && capture.parentName === null),
      };
      // A stop closes intake and tidyProse would strip its question, so a stop
      // that still asks goes back to the model rather than out with the ask cut.
      const stopStillAsks = friendVoiceLeftoverMarksEnabled()
        ? typeof composed.asksCount === 'number'
          ? composed.asksCount > 0
          : marks.asks
        : marks.asks || draft.normalize('NFKC').includes('?');
      if (capture.stopAsking && stopStillAsks) {
        noteRefusal({ reason: 'stop_still_asking', step: input.step, prompt }, 'unusable');
        return {
          fail: 'unusable',
          capture,
          retry: { draft, problem: retryProblem('stop_still_asking') },
        };
      }
      // After a yes, the link is the next step: the reply points at it and asks nothing.
      // A turn that records reminders confirms them and asks nothing; the
      // parent's next message closes the schedule (see settleSchedule).
      const prose = tidyProse(
        composed.reply,
        input,
        judgeInput.step,
        yesToLink(input, capture) || capture.scheduleAdds.length > 0,
      );
      // Under a yes to the group, code adds the number and phrase. The model
      // says whether the reply points at them. Words are not the signal.
      const v2 = linqGroupOnboardingV2Enabled();
      const joinBelow = !v2 && input.coparentJoin != null && capture.coparentGroup === true;
      if (joinBelow && marks.joinPointer !== 'below') {
        noteRefusal(
          { reason: 'join_not_pointed', joinPointer: marks.joinPointer, step: input.step, prompt },
          'unusable',
        );
        return {
          fail: 'unusable',
          capture,
          retry: { draft, problem: retryProblem('join') },
        };
      }
      const joinWritten = friendVoiceLeftoverMarksEnabled()
        ? composed.joinInProse === true
        : Boolean(input.coparentJoin && carriesJoin(prose, input.coparentJoin));
      if (input.coparentJoin && joinWritten) {
        noteRefusal({ reason: 'join_in_prose', step: input.step, prompt }, 'unusable');
        return {
          fail: 'unusable',
          capture,
          retry: { draft, problem: retryProblem('join') },
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
        ...(friendVoiceLeftoverMarksEnabled()
          ? {
              asksCount: composed.asksCount,
              asksName: composed.asksName === true,
              speaksAsParent: composed.speaksAsParent === true,
            }
          : {}),
      };
      // A card is for one connector. The model lists what the reply offers to connect.
      const linkInPlay = judgeOptions.linkFollows === true || Boolean(judgeOptions.link);
      const other = OTHER_CONNECTOR[judgeInput.step];
      if (linkInPlay && other && marks.offered.includes(other)) {
        noteRefusal({ reason: 'other_connector', step: input.step, prompt }, 'unusable');
        return {
          fail: 'unusable',
          capture,
          retry: { draft, problem: retryProblem('other_connector') },
        };
      }
      const bubblesFor = (text: string): { bubbles: string[]; judgedText: string } | null => {
        if (input.step === 'find_show') {
          const groups = input.findGroups ?? [];
          const leads = findShowGroupBubbles(composed.groupLeads ?? null, groups, input);
          // A map short of a group would go out as the whole map, and the
          // missing group would no longer be owed. Every group with lines needs
          // its own usable bubble, or nothing goes.
          const short = groups.some(
            (group, index) => group.lines.some((line) => line.trim().length > 0) && !leads?.[index],
          );
          if (!leads || short) return null;
          const bubbles = assembleFindShowBubbles(text, groups, leads);
          return { bubbles, judgedText: bubbles.join('\n\n') };
        }
        if (text.length === 0) return null;
        return {
          bubbles: [],
          judgedText: assembleFriendBody(text, input, options.link, options.trailer),
        };
      };
      // A draft that fails the judge is not rewritten. The model is asked once
      // more; if that also fails, nothing is sent.
      const assembled = bubblesFor(prose);
      if (!assembled && input.step === 'find_show') {
        noteRefusal({ reason: 'no_group_bubble', step: input.step, prompt }, 'unusable');
        return {
          fail: 'unusable',
          capture,
          retry: { draft, problem: retryProblem('no_group_bubble') },
        };
      }
      if (!assembled) return { fail: 'unusable', capture };
      const judged = await judgeFriendReplySweep(assembled.judgedText, judgeInput, judgeOptions);
      // The promises no row can ever back, refused here as dispatch refuses them.
      if (judged.ok && claimsNoLedgerCanBack(assembled.judgedText).length > 0) {
        noteRefusal({ reason: 'unbacked_claim', step: input.step, prompt }, 'unusable');
        return {
          fail: 'unusable',
          capture,
          retry: { draft, problem: retryProblem('unbacked_claim') },
        };
      }
      if (judged.ok) {
        return {
          prose,
          bubbles: assembled.bubbles,
          capture,
          step: judgeInput.step,
          asks: marks.asks,
          placeAsk: marks.placeAsk,
        };
      }
      return reject(judged);

      function reject(judged: FriendJudgeRefusal) {
        noteRefusal(
          {
            reason: judged.reason,
            ...(judged.kinds ? { kinds: judged.kinds } : {}),
            ...(judged.count ? { count: judged.count } : {}),
            step: input.step,
            judgedAs: judgeInput.step,
            prompt,
          },
          'unusable',
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
      noteRefusal(
        {
          err: err instanceof Error ? err.name : 'unknown',
          ...(err instanceof StructuredOutputError
            ? { outcome: err.outcome, stopReason: err.stopReason }
            : {}),
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
        'compose',
      );
      return { fail: 'model_failed', capture: empty };
    }
  };

  // Only the reply that goes out carries its capture. A refused draft's
  // decisions (a no to the co-parent, a schedule add) were never confirmed to
  // the parent; when nothing goes out, only plain facts they gave are kept.
  const failed = async (reason: FriendFallback, capture: OnboardingCapture) => {
    await page(reason);
    const result = unsent(reason, input.step);
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
      first.asks,
      first.placeAsk,
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
      : ` This message should ${askInWords(nextStep, retryBase)}.`;
  const retryInput = {
    ...retryBase,
    retry: first.retry ? { ...first.retry, problem: `${first.retry.problem}${askNote}` } : null,
  };
  const second = await attempt('short', retryInput);
  if ('prose' in second) {
    console.info({ recovered: true, step: input.step }, 'onboarding-friend: retry recovered');
    const capture = advanced ? mergeCaptures(advanced.settled, second.capture) : second.capture;
    return finish(
      second.prose,
      second.bubbles,
      'retry',
      capture,
      second.step,
      second.asks,
      second.placeAsk,
    );
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
export function retryProblem(
  reason:
    | FriendJudgeFailure
    | 'schedule'
    | 'join'
    | 'other_connector'
    | 'unbacked_save'
    | 'unbacked_claim'
    | 'no_group_bubble'
    | 'stop_still_asking'
    | 'place_closed',
  detail?: string,
  input?: FriendVoiceInput,
): string {
  switch (reason) {
    case 'place_closed':
      return 'They turned the place down twice, so it is settled, and the draft asked for it again. Accept the no and ask `next`, with no code, ZIP or town in it.';
    case 'no_group_bubble':
      return "A group bubble could not be sent: it was missing, or named a time, day, price, name or activity that is not in that group's own lines. Write one bubble per group in findGroups, from that group's lines only.";
    case 'stop_still_asking':
      return 'It set stopAsking and still asked a question. stopAsking ends the conversation, so that question would never be answered. If the parent asked Hale to stop, write a close that asks nothing; if not, set stopAsking false and ask.';
    case 'join':
      return linqGroupOnboardingV2Enabled()
        ? 'When coparentGroupMode is existing, code places the number on its own line under the reply. Set joinPointer to below when the reply points at it. Do not write the digits or a phrase to text. When it is new, say you will start the group and set joinPointer to hale_starts. A plain yes leaves coparentGroupMode null and joinPointer null.'
        : "Under their yes, code puts Hale's number and the phrase on their own lines right below. Set joinPointer to below when the reply points at them, wrong_owner when that number is the other parent's, placeholder when a stand-in sits where they go, hale_starts when Hale starts the group, or missing when the reply does not point at them. Do not write the number or the phrase.";
    case 'other_connector':
      return "The draft offered to connect the connector this step is not (Gmail on the calendar step, the calendar on the Gmail step), but the link under it connects only this step's. Ask about this step's connector only; the other one comes later.";
    case 'schedule':
      return 'A scheduleAdd pointed at a line that does not fit that child or is not on the map, so nothing was saved. Use the n of a map line that matches, for a child its ages suit. When no line matches, nothing is saved: do not say it was, and do not confirm a day or time for it.';
    case 'unbacked_save':
      return 'It says something was saved, added or set, and nothing was saved this turn. Do not say it was or confirm a day or time for it; say plainly it is not saved.';
    case 'unbacked_claim':
      return 'It promised something Hale does not do from here (an invite, or a change to how Hale texts). Leave that promise out.';
    case 'question':
      return input && ZERO_QUESTION_STEPS.has(input.step)
        ? 'This message asks nothing. No question mark.'
        : `Exactly one question: ${askInWords(input?.step, input)}. Never ask for something already known.`;
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
        : detail === 'unknown_name'
          ? 'unknown_name'
          : 'You are Hale; talk to the parent, never about them by name, and never call yourself by their name. When they asked who this is, name the company from facts.identity.';
    default:
      return `It broke a rule (${reason}). Write it again, plainly, keeping every rule.`;
  }
}

export function askInWords(
  step: FriendStep | undefined,
  input?: Pick<FriendVoiceInput, 'coarseCodeAsked'>,
): string {
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
      return input?.coarseCodeAsked === true
        ? 'ask the coarse code, or, when they declined it again, ask `next` instead'
        : 'ask their postal code or ZIP, or, when they just declined it, the coarse code instead, with `placeDeclined` false';
    default:
      return 'ask the open item';
  }
}

/**
 * A first no to the place gets the coarse code, so only a no after that ask, or a
 * place already declined, closes it, whatever the draft marked.
 */
function placeOpenUntilCoarseAsked(
  capture: OnboardingCapture,
  input: Pick<FriendVoiceInput, 'coarseCodeAsked' | 'placeDeclined'>,
): OnboardingCapture {
  if (!capture.placeDeclined || input.coarseCodeAsked === true || input.placeDeclined === true)
    return capture;
  return { ...capture, placeDeclined: false };
}

/** The capture fields a retry may build on: facts, a yes or no to a connector, a declined place. */
function settledFacts(capture: OnboardingCapture): OnboardingCapture {
  return {
    ...factsOnly(capture),
    nameConfirmed: capture.nameConfirmed,
    connectGmail: capture.connectGmail,
    connectCalendar: capture.connectCalendar,
    // The parent's second no settles the place whatever the draft said next.
    placeDeclined: capture.placeDeclined,
  };
}

/**
 * The input as it stands after a capture that moved the walk on, or null when
 * the capture did not. Only facts, a yes or no to a connector and a declined place
 * carry over: a decision read from a refused draft (the group chat, a schedule add)
 * does not.
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
    input: {
      ...judged,
      checklist: checklistAfter(input.checklist, settled),
      ...(settled.placeDeclined ? { placeDeclined: true } : {}),
    },
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
 * the other connector (the next step rides its own bubble) goes too.
 */
export function tidyProse(
  reply: string,
  input: FriendVoiceInput,
  judgedStep: FriendStep,
  asksNothing = false,
): string {
  let sentences = sentencesOf(reply.trim());
  const leftover = friendVoiceLeftoverMarksEnabled();
  if (!leftover && (ZERO_QUESTION_STEPS.has(judgedStep) || asksNothing)) {
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
  // The map opener is one framing sentence; the group leads say the rest.
  // Length is not a reason to drop it.
  if (input.step === 'find_show') {
    const opener = sentences.find((sentence) => {
      if (sentence.split(/\s+/u).length < 3) return false;
      return leftover || !sentence.includes('?');
    });
    sentences = opener ? [opener] : [];
  }
  return ZERO_QUESTION_STEPS.has(judgedStep) || input.step === 'connected' || asksNothing
    ? sentences.join(' ')
    : reply.trim();
}

/**
 * What one group's bubble may say: that group's lines, plus what every bubble
 * shares (the parent's words, the place, the kids' ages and names, the
 * parent's name). Another group's lines are not in here.
 */
function groupBubbleSlots(group: FriendFindGroup, input: FriendVoiceInput): string[] {
  const slots = [input.parentWords, input.agesLabel ?? '', input.placeLabel ?? ''];
  for (const line of group.lines) slots.push(line, ...twelveHourTimes(line));
  for (const months of input.ageMonths) slots.push(String(months));
  for (const child of input.children ?? []) if (child.name) slots.push(child.name);
  if (input.parentName) slots.push(input.parentName);
  return slots.filter((slot) => slot.length > 0);
}

/** The facts in a group bubble that its own group's lines do not hold. */
function groupBubbleInventions(
  bubble: string,
  group: FriendFindGroup,
  input: FriendVoiceInput,
): string[] {
  const slots = groupBubbleSlots(group, input);
  const prose = bubble.replace(/\bfeel free\b/gi, '');
  return [
    ...findInventedFacts(bubble, slots),
    ...mentionsOutsideSlots(bubble, PRICE, slots),
    ...weekdaysOutsideSlots(bubble, [...slots, ...weekdaysOfDates(slots, input.now)]),
    ...(PRICE_WORD.test(prose) && !group.lines.some((line) => PRICE_WORD.test(line))
      ? ['price']
      : []),
    ...quotesOutsideSlots(bubble, slots),
    ...namesOutsideSlots(bubble, slots),
    ...activitiesOutsideSlots(bubble, group.lines),
  ];
}

/**
 * The model's bubble for each group, checked against that group's own lines.
 * A bubble that names a time, day, price, name or activity its group does not
 * hold (storytime's hour in the swim bubble) is dropped, and code writes
 * nothing in its place. Null when the model did not write one per group.
 */
export function findShowGroupBubbles(
  leads: readonly string[] | null,
  groups: readonly FriendFindGroup[],
  input: FriendVoiceInput,
): string[] | null {
  if (!leads || leads.length !== groups.length) return null;
  return groups.map((group, index) => {
    const bubble = (leads[index] ?? '').trim();
    if (bubble.length === 0) return '';
    return groupBubbleInventions(bubble, group, input).length > 0 ? '' : bubble;
  });
}

/**
 * The system text for one compose. The co-parent choice and the household-group
 * addendum ride only on the turns that need them, so every other turn keeps its bytes.
 */
export async function friendVoiceSystem(
  input: Pick<FriendVoiceInput, 'step' | 'householdGroup' | 'coarseCodeAsked' | 'placeDeclined'>,
  short: boolean,
) {
  const skill = short ? await loadOnboardingFriendShortSkill() : await loadOnboardingFriendSkill();
  const choice =
    linqGroupOnboardingV2Enabled() && input.step === 'coparent'
      ? await loadCronSkill('group-onboarding-voice')
      : null;
  const group = input.householdGroup ? await loadCronSkill('household-group') : null;
  const place = placeInPlay(input) ? await loadCronSkill('onboarding-friend-place') : null;
  // VIL-568: the age-fit correction addendum rides only when the flag is on, so
  // every other onboarding turn (and its eval cache key) keeps its bytes.
  const ageFit = ageFitCorrectionEnabled() ? await loadCronSkill('age-fit-correction') : null;
  const leftover = friendVoiceLeftoverMarksEnabled()
    ? await loadCronSkill('onboarding-friend-leftover-marks')
    : null;
  const system = [skill, choice, group, place, ageFit, leftover]
    .flatMap((part) => (part ? [part.instructions] : []))
    .join('\n\n');
  return { skill, system };
}

/** The parsed tool value as the composer hands it to speakFriend. */
function composedFromReply(value: z.infer<typeof replySchema>): FriendComposed {
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
      nameTakenBack: value.nameTakenBack,
      kidsNamesDeclined: value.kidsNamesDeclined,
      placeDeclined: value.placeDeclined,
      calendarLater: value.calendarLater,
      gmailLater: value.gmailLater,
      stopAsking: value.stopAsking,
      language: acceptReplyLanguage(value.language),
    },
    ahaMention: value.ahaMention,
    asks: value.asks,
    parentQuestion: value.parentQuestion,
    connectorsOffered: value.connectorsOffered,
    joinPointer: value.joinPointer,
    claimsSaved: value.claimsSaved,
    placeAsk: value.placeAsk,
    asksCount: value.asksCount,
    asksName: value.asksName,
    speaksAsParent: value.speaksAsParent,
    joinInProse: value.joinInProse,
    parentPlainYes: value.parentPlainYes,
    parentLoneName: value.parentLoneName,
  };
}

/** A recorded tool value, read as the live composer reads it. For the eval harness. */
export function parseReplyTool(raw: unknown): FriendComposed {
  return composedFromReply(replySchema.parse(raw));
}

export function createFriendVoiceComposer(client: AgentClient | null): FriendVoiceComposer {
  return {
    async compose(input, options) {
      if (!client) throw new Error('onboarding-friend: voice_unavailable');
      const short = options?.prompt === 'short';
      const { skill, system } = await friendVoiceSystem(input, short);
      const { value } = await forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system,
        userMessage: JSON.stringify(friendVoiceContext(input)),
        toolName: 'reply',
        toolDescription: 'Return the onboarding reply and any facts the parent just gave.',
        inputJsonSchema: onboardingReplyToolSchema(input),
        schema: replySchema,
        maxTokens: MAX_TOKENS,
        transport: llmTransport(),
      });
      return composedFromReply(value);
    },
  };
}
