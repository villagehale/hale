import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import type { ReplyLanguage } from '~/lib/channel/language';
import { loadOnboardingFriendSkill } from '~/lib/cron/skill';
import { findInventedFacts } from '~/lib/loop/voice/facts-lint';
import { forceToolJson } from '~/lib/pipeline/structured';
import { YEAR_OPEN_LEAD, YEAR_OPEN_LEAD_FR } from './year-open';

/**
 * VIL-413. The onboarding reply, written from a per-step direction.
 *
 * The skill (packages/agent/skills/onboarding-friend.md) holds the directions.
 * This module holds the rules that must not be left to the model: one question,
 * no invented find facts, no compliance wording, no link without a URL, French
 * accents. A failed compose is logged and named, then a short fallback question
 * goes out. The parent is not left in silence (rule #11).
 */

const MAX_TOKENS = 500;
const MAX_PROSE_CHARS = 360;
const MAX_BODY_CHARS = 1200;

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
}

export interface FriendVoiceResult {
  body: string;
  prose: string;
  source: 'composed' | 'fallback';
  fallback: FriendFallback | null;
}

export interface FriendVoiceComposer {
  compose(input: FriendVoiceInput): Promise<{ reply: string }>;
}

export interface SpeakOptions {
  /** Minted connector URL. Appended by code, never written by the model. */
  link?: string | null;
  /** The connector card will append the URL after this prose is judged. */
  linkFollows?: boolean;
}

const replySchema = z.object({ reply: z.string() }).strict();

const replyJsonSchema = {
  type: 'object',
  properties: { reply: { type: 'string' } },
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
const FRENCH_ASCII_GAP =
  /\b(?:pres|age|adapt|prenoms?|ecole|ca|numero|reponds)(?![\p{L}])/iu;

const DANGLING_LINK = /\bthis link\b|\bce lien\b/i;

const ZERO_QUESTION_STEPS = new Set<FriendStep>(['stop_asking']);

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
  return {
    step: input.step,
    language: input.language,
    address: input.address,
    introduce: input.introduce,
    parentWords: input.parentWords,
    recentTurns: input.recentTurns,
    facts: {
      placeLabel: input.placeLabel,
      agesLabel: input.agesLabel,
      ageMonths: input.ageMonths,
      findLines: input.findLines,
      activity: input.activity,
      day: input.day,
      parentName: input.parentName,
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
  if (link) slots.push(link);
  return slots.filter((slot) => slot.length > 0);
}

/**
 * Empty week find is not sent. A week list is sent only while ages are still
 * missing. Once ages are known, the year list is the one find.
 */
export function friendWeekAction(
  agesKnown: boolean,
  lineCount: number,
): 'skip' | 'ask_ages' | 'ask_ages_with_lines' {
  if (agesKnown) return 'skip';
  return lineCount > 0 ? 'ask_ages_with_lines' : 'ask_ages';
}

export function numberedFindLines(lines: readonly string[]): string {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 3)
    .map((line, index) => `${index + 1}. ${line}`)
    .join('\n');
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
    const numbered = numberedFindLines(lines);
    if (input.listKind === 'year') {
      const lead = input.language === 'fr' ? YEAR_OPEN_LEAD_FR : YEAR_OPEN_LEAD;
      body = `${trimmed}\n${lead}\n${numbered}`;
    } else {
      body = `${trimmed}\n${numbered}`;
    }
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

export type FriendJudgeFailure =
  | 'empty'
  | 'long'
  | 'question'
  | 'banned'
  | 'compliance'
  | 'invented'
  | 'french'
  | 'link'
  | 'header';

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
  if (
    input.step !== 'email' &&
    mentionsOutsideSlots(trimmed, ACTIVITY_WORD, slots).length > 0
  ) {
    return { ok: false, reason: 'invented' };
  }
  if (/https?:\/\//i.test(trimmed)) {
    const allowed = options.link && trimmed.includes(options.link);
    if (!allowed) return { ok: false, reason: 'invented' };
  }

  if (input.language === 'fr') {
    if (FRENCH_ASCII_GAP.test(trimmed)) return { ok: false, reason: 'french' };
    if (
      (input.step === 'find_pick' || input.step === 'find_empty') &&
      !/près|âge|adapté|noté|année/i.test(trimmed)
    ) {
      return { ok: false, reason: 'french' };
    }
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

  if (input.listKind === 'year' && input.findLines.length > 0) {
    const lead = input.language === 'fr' ? YEAR_OPEN_LEAD_FR : YEAR_OPEN_LEAD;
    if (!trimmed.includes(lead)) return { ok: false, reason: 'header' };
  }
  if (input.step === 'find_empty' && /^\s*\d+\.\s/m.test(trimmed)) {
    return { ok: false, reason: 'invented' };
  }
  return { ok: true };
}

/** Prose only. The shell appends lines and the link, then judges the whole text. */
export function fallbackFriendProse(input: FriendVoiceInput): string {
  const fr = input.language === 'fr';
  const place = input.placeLabel?.trim() || null;
  const activity = input.activity?.trim() || null;
  const day = input.day?.trim() || null;
  const name = input.parentName?.trim() || null;
  switch (input.step) {
    case 'place':
    case 'legacy_hello':
      if (input.step === 'legacy_hello' && place) {
        return fr ? 'Quel âge ont les enfants?' : 'How old are the kids?';
      }
      if (fr && input.address === 'vous') {
        return "Bonjour, c'est Hale. Quel est votre code postal?";
      }
      return fr
        ? "Salut, c'est Hale. Quel est ton code postal?"
        : "Hey, it's Hale. What's your postal code?";
    case 'place_card':
      return fr
        ? "Salut, c'est Hale. Tu peux partager ta position?"
        : "Hey, it's Hale. Can you tap to share where you are?";
    case 'ages':
    case 'nudge_ages':
      return fr ? 'Quel âge ont les enfants?' : 'How old are the kids?';
    case 'nudge_place':
      return fr ? 'Je suis là. Quel est ton code postal?' : "Still here. What's your postal code?";
    case 'find_pick':
      if (fr) {
        return place
          ? `C'est noté, près de ${place}. Lequel te tente?`
          : "C'est noté. Lequel te tente?";
      }
      return 'Which of these looks good?';
    case 'find_empty':
      return fr
        ? "Rien d'adapté près de toi pour l'instant. Comment je t'appelle?"
        : 'Nothing age-fit nearby yet. What should I call you?';
    case 'names':
      return fr ? "Comment je t'appelle?" : 'What should I call you?';
    case 'kids_names':
      return fr
        ? "Quels sont les prénoms des enfants, si tu veux que je m'en serve?"
        : "What are the kids' first names, if you want me to use them?";
    case 'name_confirm':
      if (name) {
        return fr ? `Ça te va si je t'appelle ${name}?` : `Can I call you ${name}?`;
      }
      return fr ? "Comment je t'appelle?" : 'What should I call you?';
    case 'calendar':
      if (fr) {
        return activity
          ? `Tu veux que je compare ${activity} à ton calendrier?`
          : 'Tu veux que je regarde ton calendrier?';
      }
      return activity
        ? `Want me to check ${activity} against your calendar?`
        : 'Want me to check your calendar?';
    case 'email':
      return fr
        ? "Tu veux que je surveille les courriels d'école et de camp pour les dates?"
        : 'Want me to watch school and camp email for the dates?';
    case 'signup':
      if (fr) {
        return activity
          ? `Tu veux que je t'écrive quand les inscriptions ouvrent pour ${activity}?`
          : "Tu veux que je t'écrive quand les inscriptions ouvrent?";
      }
      if (activity) return `Want me to text you when sign-ups open for ${activity}?`;
      if (day) return `Want me to text you after ${day} and ask how it went?`;
      return 'Want me to text you when sign-ups open?';
    case 'age_correction':
      if (input.findLines.length > 0) {
        return fr ? "C'est noté. Lequel te tente?" : 'Which of these should I look at?';
      }
      return fr ? "C'est noté. Comment je t'appelle?" : 'What should I call you?';
    case 'link_retry':
      return fr
        ? "Je n'arrive pas à ouvrir ça. Je réessaie?"
        : 'I could not open that connect just now. Want me to try again?';
    case 'stop_asking':
      return fr ? "D'accord. Je m'arrête là." : "Okay. I'll leave it there.";
    default:
      return fr ? "Comment je t'appelle?" : 'What should I call you?';
  }
}

function proseForJudge(prose: string, input: FriendVoiceInput, options: SpeakOptions): string {
  return assembleFriendBody(prose, input, options.link);
}

export async function speakFriend(
  composer: FriendVoiceComposer | undefined,
  input: FriendVoiceInput,
  options: SpeakOptions = {},
): Promise<FriendVoiceResult> {
  const finish = (prose: string, source: FriendVoiceResult['source'], fallback: FriendFallback | null) => {
    const body = assembleFriendBody(prose, input, options.link);
    return { body, prose: prose.trim(), source, fallback };
  };

  const fallback = (reason: FriendFallback): FriendVoiceResult => {
    console.error({ fallback: reason, step: input.step }, 'onboarding-friend: fallback reply');
    return finish(fallbackFriendProse(input), 'fallback', reason);
  };

  if (!composer) return fallback('voice_unavailable');

  let prose = '';
  try {
    const composed = await composer.compose(input);
    prose = composed.reply.trim();
  } catch (err) {
    console.error(
      { err: err instanceof Error ? err.name : 'unknown', step: input.step },
      'onboarding-friend: compose failed',
    );
    return fallback('model_failed');
  }

  if (prose.length === 0 || prose.length > MAX_PROSE_CHARS) return fallback('unusable');
  const judged = judgeFriendReply(proseForJudge(prose, input, options), input, options);
  if (!judged.ok) {
    console.error({ reason: judged.reason, step: input.step }, 'onboarding-friend: unusable reply');
    return fallback('unusable');
  }
  return finish(prose, 'composed', null);
}

export function createFriendVoiceComposer(client: AgentClient | null): FriendVoiceComposer {
  return {
    async compose(input) {
      if (!client) throw new Error('onboarding-friend: voice_unavailable');
      const skill = await loadOnboardingFriendSkill();
      const { value } = await forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: JSON.stringify(friendVoiceContext(input)),
        toolName: 'reply',
        toolDescription: 'Return the onboarding text.',
        inputJsonSchema: replyJsonSchema,
        schema: replySchema,
        maxTokens: MAX_TOKENS,
      });
      return { reply: value.reply };
    },
  };
}
