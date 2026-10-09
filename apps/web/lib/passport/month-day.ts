const MONTH_DAY = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})\b/g;

/** Keep "Sep 14" on one line. A normal space is the only thing this replaces. */
export function glueMonthDay(text: string): string {
  return text.replace(MONTH_DAY, '$1\u00A0$2');
}
