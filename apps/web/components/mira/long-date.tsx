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
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

/**
 * Compact long date used as eyebrow above page headlines. Plain numerics
 * (Editorial Cabin uses size + position for emphasis, not spelled-out
 * dates — that was the previous pass).
 */
export function LongDate({ date = new Date() }: { date?: Date }) {
  const dayName = DAY_NAMES[date.getDay()];
  const monthName = MONTH_NAMES[date.getMonth()];
  const day = date.getDate();
  const year = date.getFullYear();
  return (
    <span className="eyebrow">
      {dayName} · {monthName} {day} · {year}
    </span>
  );
}
