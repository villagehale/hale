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

const NUMBER_WORDS_TENS = [
  '',
  '',
  'twenty',
  'thirty',
] as const;

const NUMBER_WORDS_ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
] as const;

function spelledDay(day: number): string {
  if (day < 20) {
    return NUMBER_WORDS_ONES[day] ?? String(day);
  }
  const tens = Math.floor(day / 10);
  const ones = day % 10;
  if (ones === 0) return NUMBER_WORDS_TENS[tens] ?? String(day);
  return `${NUMBER_WORDS_TENS[tens] ?? ''}-${NUMBER_WORDS_ONES[ones] ?? ''}`;
}

function spelledYear(year: number): string {
  // "two thousand twenty-six" — supports 2020–2099 cleanly.
  const thousands = Math.floor(year / 1000);
  const remainder = year - thousands * 1000;
  const thousandsWord = NUMBER_WORDS_ONES[thousands] ?? String(thousands);
  if (remainder === 0) return `${thousandsWord} thousand`;
  if (remainder < 100) {
    return `${thousandsWord} thousand ${spelledDay(remainder)}`;
  }
  const hundreds = Math.floor(remainder / 100);
  const rest = remainder - hundreds * 100;
  const hundredsPart = `${NUMBER_WORDS_ONES[hundreds] ?? ''} hundred`;
  if (rest === 0) return `${thousandsWord} ${hundredsPart}`;
  return `${thousandsWord} ${hundredsPart} ${spelledDay(rest)}`;
}

/**
 * "thursday · may twenty-eighth · two thousand twenty-six"
 * Anchors every page as correspondence rather than data.
 */
export function LongDate({ date = new Date() }: { date?: Date }) {
  const dayName = DAY_NAMES[date.getDay()];
  const monthName = MONTH_NAMES[date.getMonth()];
  const dayOfMonth = date.getDate();
  const year = date.getFullYear();
  return (
    <span className="meta">
      {dayName} · {monthName} {spelledDay(dayOfMonth)} · {spelledYear(year)}
    </span>
  );
}
