import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import type { ReplyLanguage } from '~/lib/channel/language';
import { loadOnboardingFriendSkill } from '~/lib/cron/skill';
import { findInventedFacts } from '~/lib/loop/voice/facts-lint';
import { postOpsSlack } from '~/lib/monitoring/ops-slack';
import { forceToolJson } from '~/lib/pipeline/structured';
import {
  type OnboardingCapture,
  type OnboardingChecklist,
  acceptOnboardingCapture,
  checklistAfter,
  confirmActivityPick,
  mergeCaptures,
  onboardingMissing,
} from './onboarding-turn';

/**
 * VIL-413 / VIL-417. The onboarding reply, written from a per-step direction.
 *
 * The skill (packages/agent/skills/onboarding-friend.md) holds the directions.
 * This module holds the rules that must not be left to the model: one question,
 * no invented find facts, no compliance wording, no link without a URL, French
 * accents. A failed, judged-bad, or timed-out compose is retried once on a
 * smaller prompt. If that also fails, nothing canned goes out: the miss is
 * logged, #ops is paged, and the next inbound or the morning nudge tries again.
 */

const MAX_TOKENS = 500;
const SHORT_MAX_TOKENS = 180;
const MAX_PROSE_CHARS = 360;
const MAX_BODY_CHARS = 1200;

/** One model attempt. A hang past this retries on the smaller prompt. */
export const FRIEND_ATTEMPT_TIMEOUT_MS = 12_000;

/**
 * Model instruction for the retry. Not a parent-facing message: the parent
 * only ever sees what the model returns.
 */
const SHORT_FRIEND_SYSTEM = [
  'You are Hale, texting one parent. Write one short warm reply in their language.',
  'Read known, missing, and parentWords. Extract every onboarding item this message gives.',
  'Answer anything that is not one of those items, then ask only the first item still missing. The question is your last sentence.',
  'If nothing is missing, or they asked you to stop, no question mark.',
  'Do not number a list and do not write a URL. Use only facts in the JSON.',
  'Do not invent an activity, a date, a weekday, a time, or a price.',
  'No STOP, unsubscribe, or compliance wording. No emoji.',
].join(' ');

export const FRIEND_STEPS = [
  'place',
  'place_card',
  'ages',
  'find_pick',
  'find_empty',
  'names',
  'kids_names',
  'name_confirm',
  'calendar',
  'email',
  'signup',
  'age_correction',
  'legacy_hello',
  'nudge_place',
  'nudge_ages',
  'link_retry',
  'stop_asking',
  'coparent',
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
  activity: string | null;
  day: string | null;
  parentName: string | null;
  /** Which connector just landed. Set only on the connected step. */
  connector?: 'gcal' | 'gmail' | null;
  /** Whether they agreed to be watched. Set only on the ack step. */
  granted?: boolean | null;
  /**
   * What is already stored, in onboarding order. Absent on older callers.
   * The model uses it as guidance. Code computes it from stored facts.
   */
  checklist?: OnboardingChecklist;
}

export interface FriendVoiceResult {
  body: string;
  prose: string;
  source: 'composed' | 'retry' | 'unsent';
  fallback: FriendFallback | null;
  /** Shape-checked fields from the model. Empty when nothing was stored. */
  capture: OnboardingCapture;
}

export interface FriendComposeOptions {
  /** `short` skips the skill and uses the smaller retry prompt. */
  prompt?: 'full' | 'short';
}

export interface FriendVoiceComposer {
  compose(
    input: FriendVoiceInput,
    options?: FriendComposeOptions,
  ): Promise<{ reply: string; capture?: unknown }>;
}

export interface SpeakOptions {
  /** Minted connector URL. Appended by code, never written by the model. */
  link?: string | null;
  /** The connector card will append the URL after this prose is judged. */
  linkFollows?: boolean;
  /** `short` is the one smaller retry, used when a list has to be rewritten. */
  prompt?: 'full' | 'short';
  /** Test hook. Production pages Slack #ops. */
  page?: (text: string) => Promise<unknown>;
  /** Test hook. Production uses {@link FRIEND_ATTEMPT_TIMEOUT_MS}. */
  attemptTimeoutMs?: number;
}

const childSchema = z
  .object({
    name: z.string().nullable().optional().default(null),
    ageMonths: z.number().nullable().optional().default(null),
    agePrecision: z.enum(['years', 'months']).nullable().optional().default(null),
  })
  .strict();

const replySchema = z
  .object({
    reply: z.string(),
    postalCode: z.string().nullable().optional().default(null),
    city: z.string().nullable().optional().default(null),
    children: z.array(childSchema).optional().default([]),
    parentName: z.string().nullable().optional().default(null),
    activityPick: z.number().nullable().optional().default(null),
    connectCalendar: z.boolean().nullable().optional().default(null),
    connectGmail: z.boolean().nullable().optional().default(null),
    stopAsking: z.boolean().optional().default(false),
  })
  .strict();

const replyJsonSchema = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
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
    activityPick: { type: ['number', 'null'] },
    connectCalendar: { type: ['boolean', 'null'] },
    connectGmail: { type: ['boolean', 'null'] },
    stopAsking: { type: 'boolean' },
  },
  required: ['reply'],
} as const;

const BANNED_PHRASE =
  /reply with the number you want|text me if that changes|i['’]ll note it|i['’]ll keep track|je le note|reponds avec le numero|réponds avec le numéro/i;

const COMPLIANCE =
  /unsubscribe|d[ée]sabonner|reply stop|r[ée]pondez arret|r[ée]pondez stop|\bSTOP\b/;

const ACTIVITY_WORD =
  /\b(swims?|swimming|soccer|gym|gymnastics|librar(?:y|ies)|zoo|museum|hockey|dance|ballet|music|storytime|story time|camps?|daycare|earlyon|farm|natation)\b/gi;

const WEEKDAY =
  /\b(mon|tues|wednes|thurs|fri|satur|sun)days?\b|\b(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b/gi;

const PRICE = /\$\s?\d+(?:\.\d{2})?/g;

/** ASCII stand-ins for accented words. A following letter (é in adapté) is not a gap. */
const FRENCH_ASCII_GAP = /\b(?:pres|age|adapt|prenoms?|ecole|ca|numero|reponds)(?![\p{L}])/iu;

const DANGLING_LINK = /\bthis link\b|\bce lien\b/i;

const ZERO_QUESTION_STEPS = new Set<FriendStep>(['stop_asking', 'connected', 'ack']);

export function turnsFromTranscript(
  transcript: readonly { direction: 'in' | 'out'; body: string }[],
): FriendTurn[] {
  return transcript.slice(-8).map((entry) => ({
    role: entry.direction === 'in' ? 'parent' : 'hale',
    body: entry.body,
  }));
}

/** What the model is handed. No link, no family id, no phone. */
export function friendVoiceContext(input: FriendVoiceInput): unknown {
  const checklist = input.checklist ?? null;
  return {
    step: input.step,
    language: input.language,
    address: input.address,
    introduce: input.introduce,
    parentWords: input.parentWords,
    recentTurns: input.recentTurns,
    order: ['postal', 'ages', 'pick', 'name', 'calendar', 'gmail'],
    known: checklist,
    missing: checklist ? onboardingMissing(checklist) : null,
    facts: {
      placeLabel: input.placeLabel,
      agesLabel: input.agesLabel,
      ageMonths: input.ageMonths,
      findLines: input.findLines,
      activity: input.activity,
      day: input.day,
      parentName: input.parentName,
      connector: input.connector ?? null,
      granted: input.granted ?? null,
    },
  };
}

export function friendFactSlots(input: FriendVoiceInput, link?: string | null): string[] {
  const slots = [input.parentWords, input.agesLabel ?? '', input.placeLabel ?? ''];
  for (const turn of input.recentTurns) slots.push(turn.body);
  for (const line of input.findLines) slots.push(line);
  for (const months of input.ageMonths) slots.push(String(months));
  if (input.activity) slots.push(input.activity);
  if (input.day) slots.push(input.day);
  if (input.parentName) slots.push(input.parentName);
  if (input.connector === 'gcal') slots.push('calendar', 'calendrier');
  if (input.connector === 'gmail') slots.push('gmail', 'Gmail');
  if (link) slots.push(link);
  return slots.filter((slot) => slot.length > 0);
}

/**
 * Activities wait until ages are known. A week list is never the ages ask.
 */
export function friendWeekAction(agesKnown: boolean, _lineCount: number): 'skip' | 'ask_ages' {
  return agesKnown ? 'skip' : 'ask_ages';
}

export function numberedFindLines(lines: readonly string[]): string {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 3)
    .map((line, index) => `${index + 1}. ${line}`)
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

export function assembleFriendBody(
  prose: string,
  input: Pick<FriendVoiceInput, 'language' | 'findLines' | 'listKind'>,
  link?: string | null,
): string {
  const trimmed = prose.trim();
  const lines = input.findLines.map((line) => line.trim()).filter((line) => line.length > 0);
  let body = trimmed;
  if (lines.length > 0 && input.listKind !== 'none') {
    const { lead, ask } = peelFriendAsk(trimmed);
    const parts: string[] = [];
    if (lead.length > 0) parts.push(lead);
    const numbered = numberedFindLines(lines);
    if (numbered.length > 0) parts.push(numbered);
    if (ask.length > 0) parts.push(ask);
    body = parts.join('\n');
  }
  if (typeof link === 'string' && link.startsWith('https://')) body = `${body}\n${link}`;
  return body;
}

function questionMarks(text: string): number {
  const prose = text.replace(/https?:\/\/\S+/g, '');
  return [...prose].filter((char) => char === '?').length;
}

function questionsBeyondFacts(body: string, findLines: readonly string[]): number {
  const inFacts = findLines.reduce((count, line) => count + questionMarks(line), 0);
  return questionMarks(body) - inFacts;
}

function mentionsOutsideSlots(text: string, pattern: RegExp, slots: readonly string[]): string[] {
  const found = text.match(pattern) ?? [];
  const unique = [...new Set(found.map((token) => token.toLowerCase()))];
  return unique.filter((token) => !slots.some((slot) => slot.toLowerCase().includes(token)));
}

/** The one question ends the message. A URL code appended after it does not count. */
export function questionIsLast(body: string): boolean {
  const withoutUrl = body.replace(/\nhttps:\/\/\S+\s*$/u, '').trim();
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
  | 'link';

export function judgeFriendReply(
  body: string,
  input: FriendVoiceInput,
  options: SpeakOptions = {},
): { ok: true } | { ok: false; reason: FriendJudgeFailure } {
  const trimmed = body.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };
  if (trimmed.length > MAX_BODY_CHARS) return { ok: false, reason: 'long' };
  const needed = ZERO_QUESTION_STEPS.has(input.step) ? 0 : 1;
  if (questionsBeyondFacts(trimmed, input.findLines) !== needed) {
    return { ok: false, reason: 'question' };
  }
  if (needed === 1 && !questionIsLast(trimmed)) return { ok: false, reason: 'question' };
  if (BANNED_PHRASE.test(trimmed)) return { ok: false, reason: 'banned' };
  if (COMPLIANCE.test(trimmed)) return { ok: false, reason: 'compliance' };

  const slots = friendFactSlots(input, options.link);
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
  }

  if (input.step === 'find_empty' && /^\s*\d+\.\s/m.test(trimmed)) {
    return { ok: false, reason: 'invented' };
  }
  if (input.step === 'connected') {
    const namesGmail = /\bgmail\b/i.test(trimmed);
    const namesCalendar = /\b(calendar|calendrier|agenda)\b/i.test(trimmed);
    if (input.connector === 'gcal' && namesGmail) return { ok: false, reason: 'invented' };
    if (input.connector === 'gmail' && namesCalendar) return { ok: false, reason: 'invented' };
  }
  return { ok: true };
}

function proseForJudge(prose: string, input: FriendVoiceInput, options: SpeakOptions): string {
  return assembleFriendBody(prose, input, options.link);
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
    source: 'unsent',
    fallback: reason,
    capture: acceptOnboardingCapture(null),
  };
}

/**
 * The judge sees the step the reply was written for. Once a checklist is
 * present, a turn that finished the ladder or a stop is a receipt: no question.
 */
function judgeInputFor(
  input: FriendVoiceInput,
  capture: OnboardingCapture,
): FriendVoiceInput {
  if (!input.checklist && !capture.stopAsking) return input;
  const remaining = input.checklist
    ? onboardingMissing(
        checklistAfter(input.checklist, capture, {
          pickConfirmed:
            confirmActivityPick(capture.activityPick, input.findLines.length) != null,
        }),
      )
    : [];
  if (capture.stopAsking || (input.checklist != null && remaining.length === 0)) {
    return { ...input, step: capture.stopAsking ? 'stop_asking' : 'ack' };
  }
  return input;
}

/** Step and reason only. Parent words stay out of #ops. */
function unsentPage(step: FriendStep, reason: FriendFallback): string {
  return `onboarding friend voice unsent step=${step} reason=${reason}`;
}

export async function speakFriend(
  composer: FriendVoiceComposer | undefined,
  input: FriendVoiceInput,
  options: SpeakOptions = {},
): Promise<FriendVoiceResult> {
  const finish = (
    prose: string,
    source: FriendVoiceResult['source'],
    capture: OnboardingCapture,
  ): FriendVoiceResult => {
    const body = assembleFriendBody(prose, input, options.link);
    return { body, prose: prose.trim(), source, fallback: null, capture };
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
  ): Promise<{ prose: string; capture: OnboardingCapture } | { fail: FriendFallback; capture: OnboardingCapture }> => {
    const empty = acceptOnboardingCapture(null);
    try {
      const composed = await withTimeout(composer.compose(input, { prompt }), timeoutMs);
      const capture = acceptOnboardingCapture(composed.capture, {
        findLineCount: input.findLines.length,
      });
      const prose = composed.reply.trim();
      if (prose.length === 0 || prose.length > MAX_PROSE_CHARS) return { fail: 'unusable', capture };
      const judged = judgeFriendReply(
        proseForJudge(prose, input, options),
        judgeInputFor(input, capture),
        options,
      );
      if (!judged.ok) {
        console.error(
          { reason: judged.reason, step: input.step, prompt },
          'onboarding-friend: unusable reply',
        );
        return { fail: 'unusable', capture };
      }
      return { prose, capture };
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
    return finish(first.prose, firstPrompt === 'short' ? 'retry' : 'composed', first.capture);
  }

  if (firstPrompt === 'short') {
    await page(first.fail);
    return unsent(first.fail);
  }

  const second = await attempt('short');
  const capture = 'capture' in second ? mergeCaptures(first.capture, second.capture) : first.capture;
  if ('prose' in second) return finish(second.prose, 'retry', capture);
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
        capture: {
          postalCode: value.postalCode,
          city: value.city,
          children: value.children,
          parentName: value.parentName,
          activityPick: value.activityPick,
          connectCalendar: value.connectCalendar,
          connectGmail: value.connectGmail,
          stopAsking: value.stopAsking,
        },
      };
    },
  };
}
