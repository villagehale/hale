import type { ActivityPick } from '~/lib/channel/activity/lane';
import { AGE_TOLERANCE_MONTHS } from '~/lib/registration/match-registration-windows';
import { type AgeBand, type RadarChild, parseAgeRange } from './radar-decide';

const GRADE_LABEL = /\b(grades?|kindergarten)\b/i;
const NUMBER = /\d+(?:\.\d+)?/g;
const AGE_WORD = /\b(ages?|years?|yrs?|months?|mos?)\b/i;

/**
 * School years as numbers: junior kindergarten is -1, kindergarten 0 (a bare
 * "kindergarten" or "K" spans junior and senior, so -1 to 0), then grade N.
 */
const GRADE_TOKEN = String.raw`(junior kindergarten|senior kindergarten|kindergarten|jk|sk|k|\d{1,2})(?:st|nd|rd|th)?`;
const GRADE_RANGE = new RegExp(
  String.raw`\b${GRADE_TOKEN}\s*(?:[-–—]|to|through)\s*(?:grades?\s*)?${GRADE_TOKEN}\b`,
  'i',
);
const GRADE_OPEN_MIN = new RegExp(
  String.raw`\bgrades?\s*${GRADE_TOKEN}\s*(?:\+|and up|and older|and over)`,
  'i',
);
const GRADE_SINGLE = new RegExp(
  String.raw`\bgrades?\s*${GRADE_TOKEN}\b|\b${GRADE_TOKEN}\s*grade\b|\b(kindergarten)\b`,
  'i',
);

/**
 * A child in grade N is roughly N+5 to N+7 years old across Canadian and US
 * school-entry cutoffs. The band opens a year earlier than that so an early
 * birthday or a junior start is never the reason a fitting class is left out.
 */
const GRADE_FIRST_AGE_YEARS = 4;
const GRADE_LAST_AGE_YEARS = 7;

function gradeSpan(token: string): [number, number] {
  const word = token.toLowerCase();
  if (word === 'jk' || word === 'junior kindergarten') return [-1, -1];
  if (word === 'sk' || word === 'senior kindergarten') return [0, 0];
  if (word === 'k' || word === 'kindergarten') return [-1, 0];
  const grade = Number(word);
  return [grade, grade];
}

function gradeBand(label: string): AgeBand | null {
  if (AGE_WORD.test(label)) return null;
  const toBand = (low: number, high: number | null): AgeBand => ({
    minMonths: (low + GRADE_FIRST_AGE_YEARS) * 12,
    maxMonths: high === null ? null : (high + GRADE_LAST_AGE_YEARS) * 12,
  });
  const range = GRADE_RANGE.exec(label);
  if (range) return toBand(gradeSpan(range[1] as string)[0], gradeSpan(range[2] as string)[1]);
  const open = GRADE_OPEN_MIN.exec(label);
  if (open) return toBand(gradeSpan(open[1] as string)[0], null);
  const single = GRADE_SINGLE.exec(label);
  const token = single?.slice(1).find((group) => group !== undefined);
  if (!token) return null;
  const [low, high] = gradeSpan(token);
  return toBand(low, high);
}

/**
 * The band a label reads as, or null when parseAgeRange's single-unit read would misstate
 * it: a label with more numbers than the band used ("2-5 years (under 18 months free)")
 * holds a second age statement whose unit the parser applies to the whole label. A school
 * grade is read as school ages, and a label that states both grades and ages is unread.
 */
function readableBand(ageFit: string | null): AgeBand | null {
  if (ageFit && GRADE_LABEL.test(ageFit)) return gradeBand(ageFit);
  const band = parseAgeRange(ageFit);
  if (!band || !ageFit) return null;
  const used = Number(band.minMonths !== null) + Number(band.maxMonths !== null);
  return [...ageFit.matchAll(NUMBER)].length > used ? null : band;
}

/**
 * Whether a found pick is for at least one of these children, read against their ages
 * in months, never their stages. A label we cannot read, an all-ages label, and a band
 * whose bounds read inverted are kept: there is no fact to leave them out on. A derived
 * DOB widens the band by the registration matcher's tolerance.
 */
export function fitsHouseholdAges(
  pick: Pick<ActivityPick, 'ageFit'>,
  children: readonly Pick<RadarChild, 'ageMonths' | 'dobPrecision'>[],
): boolean {
  const band = readableBand(pick.ageFit);
  if (!band) return true;
  const { minMonths, maxMonths } = band;
  if (minMonths === null && maxMonths === null) return true;
  if (minMonths !== null && maxMonths !== null && minMonths > maxMonths) return true;
  return children.some((child) => {
    if (child.ageMonths === null) return false;
    const slack = child.dobPrecision === 'derived' ? AGE_TOLERANCE_MONTHS : 0;
    if (minMonths !== null && child.ageMonths < minMonths - slack) return false;
    if (maxMonths !== null && child.ageMonths > maxMonths + slack) return false;
    return true;
  });
}

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
const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;
const ISO_DATE = /\b(20\d{2})-(\d{2})-(\d{2})\b/g;
const MONTH_DAY_YEAR = new RegExp(
  String.raw`\b${MONTH}\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b`,
  'gi',
);
const DAY_MONTH_YEAR = new RegExp(String.raw`\b(\d{1,2})\s+${MONTH},?\s+(20\d{2})\b`, 'gi');
const MONTH_YEAR = new RegExp(String.raw`\b${MONTH},?\s+(20\d{2})\b`, 'gi');
const SCHOOL_YEAR = /\b20\d{2}\s*[-–/]\s*(\d{2})\b/g;
const BARE_YEAR = /\b(20\d{2})\b/g;
const YEARLESS_DATE = new RegExp(String.raw`\b${MONTH}\s+\d{1,2}\b`, 'gi');
const OPEN_START = /\b(starting|starts|started|since|begins|beginning|ongoing|year[- ]round)\b/i;

function dayKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function monthIndex(name: string): number {
  return MONTH_NAMES.indexOf(name.slice(0, 3).toLowerCase() as (typeof MONTH_NAMES)[number]) + 1;
}

function lastDayOf(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Every calendar day the text pins to a year, each read as the last day it could
 * mean ("March 2026" is the 31st, "Fall 2025" the end of 2025), and how many date
 * mentions it carries in all, counting the ones without a year.
 */
function datedDays(text: string): { days: string[]; mentions: number } {
  const days: string[] = [];
  let rest = text;
  const take = (pattern: RegExp, read: (groups: string[]) => string) => {
    rest = rest.replace(pattern, (...groups: string[]) => {
      days.push(read(groups));
      return ' ';
    });
  };
  take(ISO_DATE, (m) => dayKey(Number(m[1]), Number(m[2]), Number(m[3])));
  take(MONTH_DAY_YEAR, (m) => dayKey(Number(m[3]), monthIndex(m[1] as string), Number(m[2])));
  take(DAY_MONTH_YEAR, (m) => dayKey(Number(m[3]), monthIndex(m[2] as string), Number(m[1])));
  take(MONTH_YEAR, (m) => {
    const year = Number(m[2]);
    const month = monthIndex(m[1] as string);
    return dayKey(year, month, lastDayOf(year, month));
  });
  take(SCHOOL_YEAR, (m) => dayKey(2000 + Number(m[1]), 12, 31));
  take(BARE_YEAR, (m) => dayKey(Number(m[1]), 12, 31));
  const yearless = rest.match(YEARLESS_DATE)?.length ?? 0;
  return { days, mentions: days.length + yearless };
}

/**
 * Whether a found pick's only dates are behind `today` (a YYYY-MM-DD day in the
 * family's zone). A date without a year, a when with no date, and a single start
 * date with nothing after it ("starting Sept 13, 2025") are kept: none of them says
 * the thing is over.
 */
export function onlyDatedBefore(
  pick: Pick<ActivityPick, 'when' | 'eventDate'>,
  today: string,
): boolean {
  if (pick.eventDate) return pick.eventDate < today;
  if (!pick.when) return false;
  const { days, mentions } = datedDays(pick.when);
  if (days.length === 0) return false;
  if (mentions === 1 && OPEN_START.test(pick.when)) return false;
  return days.every((day) => day < today);
}
