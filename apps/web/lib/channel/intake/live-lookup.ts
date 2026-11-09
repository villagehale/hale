import { type AgentClient, cachedSystem, pickModel } from '@hale/agent';
import { scrubContactTokens, scrubPlaceTokens } from '@hale/types';
import { readEvidence } from '~/lib/channel/activity/evidence';
import { type ChildNameScrub, scrubChildNames } from '~/lib/channel/child-name-scrub';
import { regionOfPostal } from '~/lib/channel/off-domain/place';
import { smsEncoding } from '~/lib/channel/sms-segments';
import { loadCronSkill } from '~/lib/cron/skill';
import type { ExtractedChild } from './extract';
import { type GroundPlace, groundUserMessage } from './ground-message';
import { officialPageReturnLine } from './official-page';

/**
 * VIL-327 — live lookup for the questions official-page pins do not cover.
 *
 * Rec-morning reviewed pins still win when they match. Official-page rec/camp
 * clocks stay on `intake-official-ground`. This module is everything else that
 * is a real question: raising-kids, leftover current-source facts, and a
 * caregiver looking for care — the `current_source` read of the intake-answer
 * model (VIL-555), never a word list. Search first. The SMS may only restate what
 * search returned. Framework-only / model memory is not a path.
 */

const INTAKE_MAX_REPLY_CHARS = 300;
const MAX_SEARCHES = 2;
const GROUND_MAX_TOKENS = 2048;

const NO_CURRENT_SOURCE_MARK = /no current source/i;

export function liveLookupReturnLine(pendingAsk: string): string {
  return officialPageReturnLine(pendingAsk);
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

/** Null when the grounded text cannot go out as one plain SMS; the caller has the
 * model say it has no current source (#868: no fixed fallback line). */
function sendableJoined(joined: string): string | null {
  if (joined.length === 0 || joined.length > INTAKE_MAX_REPLY_CHARS) return null;
  if (smsEncoding(joined) !== 'gsm7') return null;
  if (/https?:\/\/|www\./i.test(joined)) return null;
  if (/\bi('?m| am) a therapists?\b/i.test(joined)) return null;
  return joined;
}

export function joinLiveLookupAnswer(answer: string, pendingAsk: string): string | null {
  const ask = liveLookupReturnLine(pendingAsk);
  return sendableJoined([answer, ask].filter((part) => part.length > 0).join(' '));
}

export function joinAfterProvisionAnswer(answer: string): string | null {
  // #868: no fixed return ask after the answer; the next turn asks in the model's words.
  return sendableJoined(answer);
}

export function liveLookupReplyFromNotes(notes: string, pendingAsk: string): string | null {
  const answer = extractLiveLookupAnswer(notes);
  return answer === null ? null : joinLiveLookupAnswer(answer, pendingAsk);
}

export function afterProvisionReplyFromNotes(notes: string): string | null {
  const answer = extractLiveLookupAnswer(notes);
  return answer === null ? null : joinAfterProvisionAnswer(answer);
}

/**
 * What may cross the border to Anthropic's US web_search (rule #1): the
 * question with household names, postal codes and ZIPs stripped. A child name
 * the scrub cannot remove is a refusal, and the caller does not search.
 */
export function deidentifyLiveQuery(
  parentWords: string,
  children: readonly ExtractedChild[],
): ChildNameScrub {
  const names = children.flatMap((child) => (child.name ? [child.name] : []));
  const scrub = scrubChildNames(parentWords.replace(/\s+/g, ' ').trim(), names);
  if (!scrub.ok) return scrub;
  const query = scrubPlaceTokens(scrubContactTokens(scrub.text, ' '), ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { ok: true, text: query === '' ? 'current official reputable source' : query };
}

export type LiveGround =
  | { status: 'grounded'; notes: string }
  | { status: 'ungrounded'; reason: string };

function message(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

/** Where the intake searches look: the country and province or state of the session's
 * first Canadian or US code, or null when it holds none. */
export async function groundPlaceOf(regionToken: string | null): Promise<GroundPlace | null> {
  return regionToken === null ? null : regionOfPostal(regionToken);
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
  children: readonly ExtractedChild[],
  regionToken: string | null,
): Promise<LiveGround> {
  let skill: Awaited<ReturnType<typeof loadCronSkill>>;
  try {
    skill = await loadCronSkill('intake-live-ground');
  } catch (err) {
    return { status: 'ungrounded', reason: `skill_unavailable:${message(err)}` };
  }

  const query = deidentifyLiveQuery(parentWords, children);
  if (!query.ok) return { status: 'ungrounded', reason: query.refusal };
  try {
    const place = await groundPlaceOf(regionToken);
    const research = await client.messages.create({
      model: pickModel(skill.meta.task),
      max_tokens: GROUND_MAX_TOKENS,
      system: cachedSystem(skill.instructions),
      tools: [{ name: 'web_search', type: 'web_search_20250305', max_uses: MAX_SEARCHES }],
      messages: [{ role: 'user', content: groundUserMessage(query.text, place) }],
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
