import { hasLinkShape } from '../../format/link-shape';

/**
 * VIL-630 · the one check a class's schedule passes before it can reach a spot-open text.
 *
 * Both spot readers take the schedule from a page a third party writes — PerfectMind's
 * serialised StartDay/StartTime and the model-quoted line of any other program page — and
 * its digits are what back the numbers the writer may print (copy.ts). So the value must
 * read, token by token, as days or dates and a clock time, or it is null: "Call 555 0100
 * to claim" is null, "Tuesdays 4:30 PM" passes. A real schedule this cannot read costs
 * only the parenthetical; the seat is still worth the text.
 *
 * English and French, the languages the portals Hale reads publish in.
 */

export const SCHEDULE_MAX = 60;

/** Words, digits, a colon, a comma and a dash. No '.' and no '/', so no host or path. */
const SCHEDULE_CHARS = /^[\p{L}\p{N} :,-]+$/u;

const WEEKDAYS = new Set([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'mon',
  'tue',
  'tues',
  'wed',
  'thu',
  'thur',
  'thurs',
  'fri',
  'sat',
  'sun',
  'lundi',
  'mardi',
  'mercredi',
  'jeudi',
  'vendredi',
  'samedi',
  'dimanche',
]);

const MONTHS = new Set([
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
  'jan',
  'feb',
  'mar',
  'apr',
  'jun',
  'jul',
  'aug',
  'sep',
  'sept',
  'oct',
  'nov',
  'dec',
  'janvier',
  'février',
  'fevrier',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'aout',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
  'decembre',
  'janv',
  'févr',
  'fevr',
  'avr',
  'juil',
  'déc',
]);

const CONNECTORS = new Set([
  '-',
  'to',
  'from',
  'at',
  'and',
  'until',
  'through',
  'thru',
  'every',
  'each',
  'à',
  'au',
  'de',
  'du',
  'et',
  'le',
  'les',
]);

const RANGE = new Set(['-', 'to', 'à', 'au']);
const MERIDIEM = /^(am|pm)$/;
const CLOCK = /^(\d{1,2}):(\d{2})(am|pm)?$/;
const HOUR_MERIDIEM = /^(\d{1,2})(am|pm)$/;
const FRENCH_CLOCK = /^(\d{1,2})h(\d{2})?$/;
const BARE = /^\d{1,2}$/;
const DAY_OF_MONTH = /^(\d{1,2})(st|nd|rd|th|er)?$/;
const YEAR = /^20\d{2}$/;

const isWeekday = (token: string) =>
  WEEKDAYS.has(token) || (token.endsWith('s') && WEEKDAYS.has(token.slice(0, -1)));
const hourOk = (hour: number, meridiem: boolean) =>
  meridiem ? hour >= 1 && hour <= 12 : hour <= 23;

/** How many tokens from `i` make one clock time, or 0 when they do not make one. */
function clockLength(tokens: readonly string[], i: number): number {
  const token = tokens[i] ?? '';
  const clock = CLOCK.exec(token);
  if (clock) {
    const meridiem = clock[3] !== undefined || MERIDIEM.test(tokens[i + 1] ?? '');
    if (!hourOk(Number(clock[1]), meridiem) || Number(clock[2]) > 59) return 0;
    return clock[3] === undefined && MERIDIEM.test(tokens[i + 1] ?? '') ? 2 : 1;
  }
  const hourMeridiem = HOUR_MERIDIEM.exec(token);
  if (hourMeridiem) return hourOk(Number(hourMeridiem[1]), true) ? 1 : 0;
  const french = FRENCH_CLOCK.exec(token);
  if (french) {
    return hourOk(Number(french[1]), false) && Number(french[2] ?? 0) <= 59 ? 1 : 0;
  }
  if (!BARE.test(token)) return 0;
  const hour = Number(token);
  const next = tokens[i + 1] ?? '';
  if (MERIDIEM.test(next)) return hourOk(hour, true) ? 2 : 0;
  if (next === 'h') {
    if (!hourOk(hour, false)) return 0;
    const minutes = tokens[i + 2] ?? '';
    return /^\d{2}$/.test(minutes) && Number(minutes) <= 59 ? 3 : 2;
  }
  // "9-10am": a bare hour opening a range whose other end carries the meridiem.
  if (RANGE.has(next)) {
    const end = tokens[i + 2] ?? '';
    const endHasMeridiem =
      HOUR_MERIDIEM.test(end) ||
      /^\d{1,2}:\d{2}(am|pm)$/.test(end) ||
      (/^\d{1,2}(:\d{2})?$/.test(end) && MERIDIEM.test(tokens[i + 3] ?? ''));
    return endHasMeridiem && hourOk(hour, true) ? 1 : 0;
  }
  return 0;
}

/**
 * The schedule, whitespace collapsed, when every token is a day, a date, a clock time or a
 * word joining them, with at least one clock time and one day or date. Otherwise null.
 */
export function checkedSchedule(raw: string): string | null {
  const phrase = raw.replace(/\s+/g, ' ').trim();
  if (phrase === '' || phrase.length > SCHEDULE_MAX) return null;
  if (!SCHEDULE_CHARS.test(phrase) || hasLinkShape(phrase)) return null;

  const tokens = phrase
    .toLowerCase()
    .replace(/-/g, ' - ')
    .split(/[\s,]+/)
    .filter((token) => token !== '');
  const nearMonth = (i: number) =>
    MONTHS.has(tokens[i - 1] ?? '') || MONTHS.has(tokens[i + 1] ?? '');
  let clocks = 0;
  let days = 0;
  let months = 0;
  let datedNumbers = 0;
  for (let i = 0; i < tokens.length; ) {
    const token = tokens[i] as string;
    const clock = clockLength(tokens, i);
    if (clock > 0) {
      clocks += 1;
      i += clock;
      continue;
    }
    if (isWeekday(token)) days += 1;
    else if (MONTHS.has(token)) months += 1;
    else if (DAY_OF_MONTH.test(token) && nearMonth(i)) {
      const day = Number(DAY_OF_MONTH.exec(token)?.[1]);
      if (day < 1 || day > 31) return null;
      datedNumbers += 1;
    } else if (YEAR.test(token) && tokens.some((other) => MONTHS.has(other))) datedNumbers += 1;
    else if (!CONNECTORS.has(token)) return null;
    i += 1;
  }
  const dated = months > 0 && datedNumbers > 0;
  return clocks > 0 && (days > 0 || dated) ? phrase : null;
}
