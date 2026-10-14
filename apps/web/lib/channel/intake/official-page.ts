import { nameAnywhere } from '~/lib/channel/coach/reply';
import type { LiveRegistrationReading } from '~/lib/registration/live-reading';
import {
  registrationDate,
  registrationWhen,
  unclassifiedRegistrationDate,
} from '~/lib/registration/read';
import type { ExtractedChild } from './extract';

export const NOT_POSTED_YET = "I couldn't verify the current date.";
export const OFFICIAL_PAGE_RETURN_ASK = "Kids' names, ages, and a postal when you have them?";
export const OFFICIAL_PAGE_WATCH_ASK = 'Still want me watching?';
export function isOfficialPageAsk(body: string): boolean {
  const text = body.toLowerCase().replace(/\s+/g, ' ').trim();
  const aboutPrograms =
    /\b(rec|recreation|swim|skate|aquatics?|camps?|registration|waitlists?|winter-?break|lessons?)\b/.test(
      text,
    );
  const askingWhen =
    /\b(when|what (day|date|time)|opens?|opening|posted|hours?|deadline|dates?)\b/.test(text) ||
    (/\?/.test(text) && /\b(registration|register|sign[- ]?up)\b/.test(text));
  return aboutPrograms && askingWhen;
}

export function officialPageReturnLine(pendingAsk: string): string {
  void pendingAsk;
  return '';
}

function withSource(answer: string, pendingAsk: string, sourceUrl?: string): string {
  const body = `${answer}${sourceUrl ? ` ${sourceUrl}` : ''}`;
  const joined = `${body} ${officialPageReturnLine(pendingAsk)}`;
  // Preserve the source intact; a long link may use another SMS segment.
  return joined.length <= 300 ? joined : body;
}

export function officialPageFallbackReply(pendingAsk: string, sourceUrl?: string): string {
  return withSource(NOT_POSTED_YET, pendingAsk, sourceUrl);
}

export function officialPageReply(reading: LiveRegistrationReading, pendingAsk: string): string {
  const date = registrationDate(reading, false);
  const unclassified = unclassifiedRegistrationDate(reading);
  if (unclassified)
    return withSource(
      `The page lists registration ${registrationWhen(reading, unclassified)}; resident/non-resident eligibility is unconfirmed. I can't confirm this applies to you.`,
      pendingAsk,
      reading.sourceUrl,
    );
  return date
    ? withSource(`The page says ${registrationWhen(reading, date)}.`, pendingAsk, reading.sourceUrl)
    : officialPageFallbackReply(pendingAsk, reading.sourceUrl);
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
      query = query.replace(nameAnywhere(child.name), (_match, before: string) => before);
    }
  }
  query = query
    .replace(/\b[A-Za-z]\d[A-Za-z]\s*\d[A-Za-z]\d\b/g, '')
    .replace(/\b[A-Za-z]\d[A-Za-z]\b/g, '')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '')
    .replace(/\+?\d[\d\s.-]{7,}\d/g, (value) => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ''))
    .replace(/\s+/g, ' ')
    .trim();
  if (query === '') return 'municipal recreation registration dates official page';
  return query;
}
