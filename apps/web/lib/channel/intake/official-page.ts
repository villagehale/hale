import { smsEncoding } from '~/lib/channel/sms-segments';
import { COLD_START_ASK, WATCH_OFFER_ASK } from './copy';
import type { ExtractedChild } from './extract';

/**
 * VIL-326 — official-page intake answers.
 *
 * Rec-morning pins (544 / 548 / 555) still win when they match. This module is
 * everything else that is a real rec / camp / registration question: search
 * official pages, or say the date is not posted yet. Never invent a clock, and
 * never fall back to the pending ask alone.
 */

const INTAKE_MAX_REPLY_CHARS = 300;

export const NOT_POSTED_YET = "That date isn't posted yet.";

/** Paraphrase of COLD_START_ASK — names, ages, and postal, never the verbatim lock. */
export const OFFICIAL_PAGE_RETURN_ASK = "Kids' names, ages, and a postal when you have them?";

export const OFFICIAL_PAGE_WATCH_ASK = 'Still want me watching?';

const DATE_OR_CLOCK =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}\b|\b\d{1,2}:\d{2}\b/i;

function fold(body: string): string {
  return body.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * A rec / camp / registration clock question — the ones that miss the city pins
 * and used to invent a time or return empty. Not a Hale-itself question, not a
 * hedge, not names/ages/postal, not adult-learn (checked earlier).
 */
export function isOfficialPageAsk(body: string): boolean {
  const text = fold(body);
  if (text === '') return false;
  const aboutPrograms =
    /\b(rec|recreation|swim|skate|aquatics?|camps?|registration|waitlists?|winter-?break|lessons?)\b/.test(
      text,
    );
  const askingWhen =
    /\b(when|what (day|date|time)|opens?|opening|posted|hours?|deadline|dates?)\b/.test(text) ||
    (/\?/.test(text) && /\b(registration|register|sign[- ]?up)\b/.test(text));
  return aboutPrograms && askingWhen;
}

export function notesGroundADate(notes: string): boolean {
  return DATE_OR_CLOCK.test(notes);
}

export function officialPageReturnLine(pendingAsk: string): string {
  const ask = pendingAsk.trim();
  if (ask === WATCH_OFFER_ASK || /keep an eye/i.test(ask)) {
    return OFFICIAL_PAGE_WATCH_ASK;
  }
  if (ask === COLD_START_ASK || /postal/i.test(ask)) {
    return OFFICIAL_PAGE_RETURN_ASK;
  }
  return 'What did you want to tell me first?';
}

export function officialPageFallbackReply(pendingAsk: string): string {
  return joinOfficialAnswer(NOT_POSTED_YET, pendingAsk);
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

export function joinOfficialAnswer(answer: string, pendingAsk: string): string {
  const ask = officialPageReturnLine(pendingAsk);
  const fallback = `${NOT_POSTED_YET} ${ask}`;
  const joined = `${answer} ${ask}`;
  if (joined.length > INTAKE_MAX_REPLY_CHARS) return fallback;
  if (smsEncoding(joined) !== 'gsm7') return fallback;
  if (/https?:\/\/|www\./i.test(joined)) return fallback;
  return joined;
}

export function officialPageReplyFromNotes(notes: string, pendingAsk: string): string {
  const answer = extractOfficialAnswer(notes);
  return joinOfficialAnswer(answer ?? NOT_POSTED_YET, pendingAsk);
}

/**
 * What may cross the border to Anthropic's US web_search (rule #1): the rec
 * question with household names and postal codes stripped. Dates stay — they
 * are the thing being looked up.
 */
export function deidentifyOfficialQuery(
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
  if (query === '') return 'municipal recreation registration dates official page';
  return query;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
