import { type AgentClient, pickModel } from '@hale/agent';
import { readEvidence } from '~/lib/channel/activity/evidence';
import { namesAMentalCrisis } from '~/lib/channel/off-domain/copy';
import { smsEncoding } from '~/lib/channel/sms-segments';
import { loadCronSkill } from '~/lib/cron/skill';
import type { ExtractedChild } from './extract';
import { officialPageReturnLine } from './official-page';

export { namesAMentalCrisis };

/**
 * VIL-327 — live lookup for the questions official-page pins do not cover.
 *
 * Rec-morning reviewed pins still win when they match. Official-page rec/camp
 * clocks stay on `intake-official-ground`. This module is everything else that
 * is a real question: raising-kids, leftover current-source facts, and a
 * caregiver looking for care. Search first. The SMS may only restate what
 * search returned. Framework-only / model memory is not a path.
 */

const INTAKE_MAX_REPLY_CHARS = 300;
const MAX_SEARCHES = 2;
const GROUND_MAX_TOKENS = 2048;

export const NO_CURRENT_SOURCE_YET = 'I do not have a current source yet.';

/** After provision: one line back to Hale's job, never more trivia. */
export const AFTER_PROVISION_RETURN_ASK = 'Anything I can watch for the kids this week?';

/**
 * Warm parent, not a clinician. Reviewed copy — a model does not write a
 * method, a diagnosis, or "I'm a therapist."
 */
export const CHEER_UP_REPLY = "That's a lot to carry. You're doing the hard part by showing up.";

const NO_CURRENT_SOURCE_MARK = /no current source/i;

function fold(body: string): string {
  return body.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Nap / solids / potty / tantrum and the rest of raising-kids. */
export function isRaisingKidsAsk(body: string): boolean {
  const text = fold(body);
  if (text === '') return false;
  if (namesAMentalCrisis(text)) return false;
  return /\b(naps?|napping|sleep(?:ing|s)?|bedtime|solids?|potty|toilet|tantrums?|teething|formula|breastfeed(?:ing)?|weaning|colic|reflux|tummy time|picky eater|night wak(?:e|ing)|co-?sleep)\b/.test(
    text,
  );
}

/**
 * Current-source leftover facts. Office holders and results that change —
 * not "who is the GOAT" and not the capital of Peru.
 */
export function isLeftoverFactAsk(body: string): boolean {
  const text = fold(body);
  if (text === '') return false;
  if (namesAMentalCrisis(text)) return false;
  const office =
    /\b(presidents?|prime ministers?|premiers?|mayors?)\b/.test(text) &&
    /\b(who(?:'s| is| was)|current|today)\b/.test(text);
  const result =
    /\bwho won\b/.test(text) && /\b(world cup|election|championship|finals?)\b/.test(text);
  return office || result || /\bworld cup\b/.test(text);
}

/** They asked Hale to find care — live lookup for Canadian resources. */
export function isTherapistFindAsk(body: string): boolean {
  const text = fold(body);
  if (text === '') return false;
  if (namesAMentalCrisis(text)) return false;
  const care = /\b(therapists?|therapy|counsell?ors?|counsell?ing|psychologists?)\b/.test(text);
  if (!care) return false;
  return /\b(find|finding|need|need a|looking for|get|want|where)\b/.test(text);
}

/**
 * Cheer-up / burnout / a hard day. Not a fact, not a care-find, not a crisis.
 * Reviewed warmth, then (if not crisis) one return ask.
 */
export function isCheerUpAsk(body: string): boolean {
  const text = fold(body);
  if (text === '') return false;
  if (namesAMentalCrisis(text)) return false;
  if (isTherapistFindAsk(text) || isRaisingKidsAsk(text)) return false;
  return (
    /\bcheer(?: me)? up\b/.test(text) ||
    /\b(burnt? out|burnout)\b/.test(text) ||
    /\bi(?:'m| am) (?:so )?(?:exhausted|tired|overwhelmed)\b/.test(text) ||
    /\bhaving a hard (?:day|time)\b/.test(text) ||
    /\bpep talk\b/.test(text)
  );
}

export function isLiveLookupAsk(body: string): boolean {
  return isRaisingKidsAsk(body) || isLeftoverFactAsk(body) || isTherapistFindAsk(body);
}

export function liveLookupReturnLine(pendingAsk: string): string {
  return officialPageReturnLine(pendingAsk);
}

export function liveLookupFallbackReply(pendingAsk: string): string {
  return joinLiveLookupAnswer(NO_CURRENT_SOURCE_YET, pendingAsk);
}

export function afterProvisionFallbackReply(): string {
  return joinAfterProvisionAnswer(NO_CURRENT_SOURCE_YET);
}

export function cheerUpIntakeReply(pendingAsk: string): string {
  return joinLiveLookupAnswer(CHEER_UP_REPLY, pendingAsk);
}

export function cheerUpAfterProvisionReply(): string {
  return joinAfterProvisionAnswer(CHEER_UP_REPLY);
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!])\s+/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** One or two sentences from the lookup notes, or null when search did not ground. */
export function extractLiveLookupAnswer(notes: string): string | null {
  const cleaned = notes
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '' || NO_CURRENT_SOURCE_MARK.test(cleaned)) return null;
  const hits = sentences(cleaned).filter(
    (sentence) => !sentence.includes('?') && !NO_CURRENT_SOURCE_MARK.test(sentence),
  );
  if (hits.length === 0) return null;
  let answer = hits[0] as string;
  const next = hits[1];
  if (next !== undefined && `${answer} ${next}`.length <= 200) {
    answer = `${answer} ${next}`;
  }
  return answer;
}

export function notesGroundACurrentSource(notes: string): boolean {
  return extractLiveLookupAnswer(notes) !== null;
}

function sendableJoined(joined: string, fallback: string): string {
  if (joined.length > INTAKE_MAX_REPLY_CHARS) return fallback;
  if (smsEncoding(joined) !== 'gsm7') return fallback;
  if (/https?:\/\/|www\./i.test(joined)) return fallback;
  if (/\bi('?m| am) a therapists?\b/i.test(joined)) return fallback;
  return joined;
}

export function joinLiveLookupAnswer(answer: string, pendingAsk: string): string {
  const ask = liveLookupReturnLine(pendingAsk);
  const fallback = `${NO_CURRENT_SOURCE_YET} ${ask}`;
  return sendableJoined(`${answer} ${ask}`, fallback);
}

export function joinAfterProvisionAnswer(answer: string): string {
  const fallback = `${NO_CURRENT_SOURCE_YET} ${AFTER_PROVISION_RETURN_ASK}`;
  return sendableJoined(`${answer} ${AFTER_PROVISION_RETURN_ASK}`, fallback);
}

export function liveLookupReplyFromNotes(notes: string, pendingAsk: string): string {
  return joinLiveLookupAnswer(extractLiveLookupAnswer(notes) ?? NO_CURRENT_SOURCE_YET, pendingAsk);
}

export function afterProvisionReplyFromNotes(notes: string): string {
  return joinAfterProvisionAnswer(extractLiveLookupAnswer(notes) ?? NO_CURRENT_SOURCE_YET);
}

/**
 * What may cross the border to Anthropic's US web_search (rule #1): the
 * question with household names and postal codes stripped.
 */
export function deidentifyLiveQuery(
  parentWords: string,
  children: readonly ExtractedChild[],
): string {
  let query = parentWords.replace(/\s+/g, ' ').trim();
  for (const child of children) {
    if (child.name) {
      query = query.replace(new RegExp(`\\b${escapeRegExp(child.name)}\\b`, 'gi'), '');
    }
  }
  query = query
    .replace(/\b[A-Za-z]\d[A-Za-z]\s*\d[A-Za-z]\d\b/g, '')
    .replace(/\b[A-Za-z]\d[A-Za-z]\b/g, '')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '')
    .replace(/\+?\d[\d\s.-]{7,}\d/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (query === '') return 'current official reputable source';
  return query;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type LiveGround =
  | { status: 'grounded'; notes: string }
  | { status: 'ungrounded'; reason: string };

function message(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

/**
 * GROUND a raising-kids, leftover-fact, or therapist-find ask against a
 * current official / reputable page. Zero searches, empty notes, or notes
 * that do not restate a source are the same parent-facing sentence — no
 * current source yet — and each reason is named in the log (rule #11).
 */
export async function groundCurrentSource(
  client: AgentClient,
  parentWords: string,
  children: readonly ExtractedChild[] = [],
): Promise<LiveGround> {
  let skill: Awaited<ReturnType<typeof loadCronSkill>>;
  try {
    skill = await loadCronSkill('intake-live-ground');
  } catch (err) {
    return { status: 'ungrounded', reason: `skill_unavailable:${message(err)}` };
  }

  const query = deidentifyLiveQuery(parentWords, children);
  try {
    const research = await client.messages.create({
      model: pickModel(skill.meta.task),
      max_tokens: GROUND_MAX_TOKENS,
      system: skill.instructions,
      tools: [{ name: 'web_search', type: 'web_search_20250305', max_uses: MAX_SEARCHES }],
      messages: [{ role: 'user', content: query }],
    });
    const evidence = readEvidence(new Date(), research.content);
    if (evidence.searchResults === 0) return { status: 'ungrounded', reason: 'not_grounded' };
    if (evidence.notes === '') return { status: 'ungrounded', reason: 'empty_research' };
    if (!notesGroundACurrentSource(evidence.notes)) {
      return { status: 'ungrounded', reason: 'no_source' };
    }
    return { status: 'grounded', notes: evidence.notes };
  } catch (err) {
    return { status: 'ungrounded', reason: `ground_failed:${message(err)}` };
  }
}
