import { scrubContactTokens, scrubPlaceTokens } from '@hale/types';
import { type ChildNameScrub, scrubChildNames } from '~/lib/channel/child-name-scrub';
import { smsEncoding } from '~/lib/channel/sms-segments';
import type { ExtractedChild } from './extract';

/**
 * VIL-326 — official-page intake answers.
 *
 * Rec-morning pins (544 / 548 / 555) still win when they match. This module is
 * everything else that is a real rec / camp / registration question (the
 * `program_dates` read of the intake-answer model, VIL-555, in any language): search
 * official pages, or say the date is not posted yet. Never invent a clock, and
 * never fall back to the pending ask alone.
 */

const INTAKE_MAX_REPLY_CHARS = 300;

const DATE_OR_CLOCK =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}\b|\b\d{1,2}:\d{2}\b/i;

export function notesGroundADate(notes: string): boolean {
  return DATE_OR_CLOCK.test(notes);
}

export function officialPageReturnLine(pendingAsk: string): string {
  // #868: the fixed watch / cold-start asks are gone as pending-ask text. The one
  // live caller passes no pending ask; the friend voice asks the next thing itself.
  void pendingAsk;
  return '';
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!])\s+/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** One or two date-bearing sentences from official notes, or null when none. */
export function extractOfficialAnswer(notes: string): string | null {
  const cleaned = notes
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const hits = sentences(cleaned).filter(
    (sentence) => DATE_OR_CLOCK.test(sentence) && !sentence.includes('?'),
  );
  if (hits.length === 0) return null;
  let answer = hits[0] as string;
  const next = hits[1];
  if (next !== undefined && `${answer} ${next}`.length <= 200) {
    answer = `${answer} ${next}`;
  }
  return answer;
}

/** Null when the grounded answer cannot go out as one plain SMS: the caller has the
 * model say the date is not posted (#868: no fixed fallback line). */
export function joinOfficialAnswer(answer: string, pendingAsk: string): string | null {
  const ask = officialPageReturnLine(pendingAsk);
  const joined = [answer, ask].filter((part) => part.length > 0).join(' ');
  if (joined.length === 0 || joined.length > INTAKE_MAX_REPLY_CHARS) return null;
  if (smsEncoding(joined) !== 'gsm7') return null;
  if (/https?:\/\/|www\./i.test(joined)) return null;
  return joined;
}

export function officialPageReplyFromNotes(notes: string, pendingAsk: string): string | null {
  const answer = extractOfficialAnswer(notes);
  return answer === null ? null : joinOfficialAnswer(answer, pendingAsk);
}

/**
 * What may cross the border to Anthropic's US web_search (rule #1): the rec
 * question with household names, postal codes and ZIPs stripped. Dates stay — they
 * are the thing being looked up. A child name the scrub cannot remove is a
 * refusal, and the caller does not search.
 */
export function deidentifyOfficialQuery(
  parentWords: string,
  children: readonly ExtractedChild[],
): ChildNameScrub {
  const names = children.flatMap((child) => (child.name ? [child.name] : []));
  const scrub = scrubChildNames(parentWords.replace(/\s+/g, ' ').trim(), names);
  if (!scrub.ok) return scrub;
  const query = scrubPlaceTokens(scrubContactTokens(scrub.text, ' '), ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    ok: true,
    text: query === '' ? 'municipal recreation registration dates official page' : query,
  };
}
