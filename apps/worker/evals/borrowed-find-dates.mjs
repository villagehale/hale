/**
 * A date grounded only on find A cannot excuse the same date on find B.
 *
 * The global hay is one bag: story time's "Aug 8" and the farm's "Sun" are both
 * in it, so "Riverdale Farm on Sun Aug 8" used to pass while the farm's own when
 * is Sun, Aug 9. Each month-day is checked against the nearest named source in
 * the SAME clause — that find, that calendar row, or that registration window.
 *
 * A compound sentence is not one clause. "Story time is Sat, Aug 8, and the farm
 * is Sun, Aug 9" names both dates correctly, and the farm's name sits closer to
 * Aug 8 than story time's does. The comma-and boundary keeps each date with the
 * find it was written beside. A comma inside a date ("Sat, Aug 8", "Aug 8, 2026")
 * is not that boundary.
 */

const DATE_ANCHOR_GENERIC = new Set([
  'time',
  'practice',
  'lesson',
  'class',
  'visit',
  'with',
  'from',
  'this',
  'that',
  'your',
  'fall',
  'open',
  'free',
  'week',
  'park',
]);

const MONTH =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';

function monthDayToken(month, day) {
  return `${month.toLowerCase().slice(0, 3)} ${Number(day)}`;
}

function monthDaysIn(text) {
  const pattern = new RegExp(`\\b(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi');
  return [...String(text).matchAll(pattern)].map((match) => ({
    token: monthDayToken(match[1], match[2]),
    index: match.index ?? 0,
  }));
}

export function dateSource(label, when) {
  const words = [
    ...new Set(
      label
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 4 && !DATE_ANCHOR_GENERIC.has(word)),
    ),
  ];
  return { label, words, dates: new Set(monthDaysIn(when).map((mention) => mention.token)) };
}

/** Clauses of one sentence. Date-internal commas stay; "and" / "but" / other commas split. */
export function clausesOf(sentence) {
  const protectedText = String(sentence)
    .replace(new RegExp(`,(?=\\s*(?:${MONTH})\\b)`, 'gi'), '\u0000')
    .replace(/,(?=\s*\d{4}\b)/g, '\u0000')
    .replace(/,(?=\s*\d{1,2}:\d{2})/g, '\u0000');
  return protectedText
    .split(/,\s+\b(?:and|but)\b\s+|\s+\b(?:and|but)\b\s+|[;,]|\n+/gi)
    .map((part) => part.replaceAll('\u0000', ',').trim())
    .filter((part) => part.length > 0);
}

function borrowedInClause(clause, sources) {
  const hay = clause.toLowerCase();
  const offenders = [];
  for (const mention of monthDaysIn(clause)) {
    const distances = sources.map((source) => {
      let best = Number.POSITIVE_INFINITY;
      for (const word of source.words) {
        const found = hay.matchAll(new RegExp(`\\b${word}\\b`, 'g'));
        for (const match of found) {
          best = Math.min(best, Math.abs((match.index ?? 0) - mention.index));
        }
      }
      return { source, best };
    });
    const nearestAt = Math.min(...distances.map((row) => row.best));
    if (!Number.isFinite(nearestAt) || nearestAt > 80) continue;
    const tied = distances.filter((row) => row.best === nearestAt).map((row) => row.source);
    if (tied.some((source) => source.dates.has(mention.token))) continue;
    const owned = tied
      .map((source) => `${source.label}: ${[...source.dates].join(', ') || 'no calendar date'}`)
      .join('; ');
    offenders.push(
      `date "${mention.token}" is not on the nearest find (${owned}); a date from another find does not count`,
    );
  }
  return offenders;
}

export function borrowedFindDates(reply, sources) {
  const offenders = [];
  for (const sentence of String(reply).split(/(?<=[.!?])\s+|\n+/)) {
    for (const clause of clausesOf(sentence)) {
      offenders.push(...borrowedInClause(clause, sources));
    }
  }
  return [...new Set(offenders)];
}
