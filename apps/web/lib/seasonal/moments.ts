/**
 * HOLIDAYS AND SEASONAL MOMENTS ARE THE MODEL'S CALL, NOT A LIST.
 *
 * There is deliberately no holiday table and no keyword rule here (Barton, 2026-10-25:
 * Halloween, Christmas, pumpkin fests, fairs, Easter, Mother's/Father's Day, "all of
 * them"). The live activity search is handed today's local date and asked, in plain
 * words, to work out which holidays or seasonal moments fall in or near the window,
 * across cultures (Lunar New Year, Diwali, Eid and so on), and to look for local family
 * events for them. The town rides on the query already (deidentify.ts). Whether a find
 * is worth a text, and when, stays with the model downstream: no caps, no fixed copy.
 */
function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** The live-search subject for a proactive find. `language` is the family's own, when
 * known, so the model can weigh the holidays that household is likely to keep. */
export function proactiveSearchSubject(
  now: Date,
  timeZone: string,
  language?: string | null,
): string {
  const culture = language ? ` (the family's language is ${language})` : '';
  return [
    `local activities and events for kids. Today is ${localDate(now, timeZone)}.`,
    'Consider which holidays and seasonal moments fall in or near this window,',
    `including ones the family may celebrate across cultures${culture}, and include`,
    'dated local family events for them when the page lists them',
  ].join(' ');
}
