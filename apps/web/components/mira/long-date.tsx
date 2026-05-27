const DAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

const MONTH_NAMES = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
] as const;

/**
 * Compact long date stamp, used as the right-side of the page corner and
 * in section headers. Lower-case typographic style throughout.
 */
export function LongDate({ date = new Date() }: { date?: Date }) {
  const dayName = DAY_NAMES[date.getDay()];
  const monthName = MONTH_NAMES[date.getMonth()];
  const day = date.getDate();
  const year = date.getFullYear();
  return (
    <span className="eyebrow tabular">
      {dayName} · {monthName} {day} · {year}
    </span>
  );
}
