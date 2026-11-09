/**
 * VIL-581 · a refusal-only cross-check on a booking the reader cited to a calendar row.
 *
 * It reads HALE'S OUTBOUND sentence, never a parent's text. The sentence conflicts
 * with the row if it names a weekday and none is the row's family-local weekday, or
 * names a clock time and none is the row's family-local start time. It can only refuse,
 * so a gap in it fails open:
 *  - weekday names come from ICU for the family language plus English (long forms,
 *    and short forms only when they hold no ASCII letter, so `Sat` never matches "sat");
 *  - clock times are digit forms only (`9:00`, `9h00`, `15h`, `3pm`, `7 a.m.`, `9点`,
 *    `9点30分`, `9点半`);
 *  - NOT read (named gaps): relative days (tomorrow, demain, 明天), spelled-out times,
 *    non-ASCII digits;
 *  - NAMED RESIDUAL (fails closed): the check is per sentence, so a compound sentence
 *    whose other clause names another time or weekday is refused.
 */

/** 2026-11-01 is a Sunday; i days later is weekday i. */
const SUNDAY = Date.UTC(2026, 10, 1, 12);
const DAY_MS = 86_400_000;
const SUBSTRING_SCRIPTS =
  /[\p{Script=Han}\p{Script=Arabic}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const ASCII_LETTER = /[A-Za-z]/;

interface DayName {
  day: number;
  name: string;
}

const namesCache = new Map<string, readonly DayName[]>();

function dayNames(lang: string): readonly DayName[] {
  const known = namesCache.get(lang);
  if (known) return known;
  const long = new Intl.DateTimeFormat(lang, { weekday: 'long', timeZone: 'UTC' });
  const short = new Intl.DateTimeFormat(lang, { weekday: 'short', timeZone: 'UTC' });
  const names: DayName[] = [];
  for (let day = 0; day < 7; day += 1) {
    const at = new Date(SUNDAY + day * DAY_MS);
    names.push({ day, name: long.format(at) });
    const brief = short.format(at);
    if (!ASCII_LETTER.test(brief)) names.push({ day, name: brief });
  }
  namesCache.set(lang, names);
  return names;
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function namedDays(sentence: string, locale: string | undefined): Set<number> {
  const found = new Set<number>();
  for (const lang of new Set([locale, 'en'].filter((l): l is string => l !== undefined))) {
    for (const { day, name } of dayNames(lang)) {
      const hit = SUBSTRING_SCRIPTS.test(name)
        ? sentence.includes(name)
        : new RegExp(`(?<![\\p{L}\\p{N}])${escaped(name)}(?![\\p{L}\\p{N}])`, 'iu').test(sentence);
      if (hit) found.add(day);
    }
  }
  return found;
}

interface ClockTime {
  /** The hours this time can mean: one with a meridiem or past 12, two without. */
  hours: number[];
  minute: number;
}

const CLOCK_FORMS: ReadonlyArray<{
  pattern: RegExp;
  read: (m: RegExpMatchArray) => { hour: number; minute: number; meridiem?: string };
}> = [
  {
    pattern: /(?<!\d)(\d{1,2}):(\d{2})(?!\d)(?:\s?([ap])\.?\s?m\.?(?!\p{L}))?/giu,
    read: (m) => ({ hour: Number(m[1]), minute: Number(m[2]), meridiem: m[3] }),
  },
  {
    pattern: /(?<![\p{L}\d])(\d{1,2})h(\d{2})?(?![\p{L}\d])/gu,
    read: (m) => ({ hour: Number(m[1]), minute: Number(m[2] ?? 0) }),
  },
  {
    pattern: /(?<![\d:])(\d{1,2})\s?([ap])\.?\s?m\.?(?!\p{L})/giu,
    read: (m) => ({ hour: Number(m[1]), minute: 0, meridiem: m[2] }),
  },
  {
    pattern: /(?<!\d)(\d{1,2})点(?:(\d{1,2})分?(?!\d)|(半))?/gu,
    read: (m) => ({ hour: Number(m[1]), minute: m[3] ? 30 : Number(m[2] ?? 0) }),
  },
];

function hoursFor(hour: number, meridiem: string | undefined): number[] {
  if (meridiem) {
    const pm = meridiem.toLowerCase() === 'p';
    return [(hour % 12) + (pm ? 12 : 0)];
  }
  if (hour >= 13) return [hour];
  return hour === 12 ? [12, 0] : [hour, hour + 12];
}

function namedTimes(sentence: string): ClockTime[] {
  const times: ClockTime[] = [];
  let rest = sentence;
  for (const { pattern, read } of CLOCK_FORMS) {
    rest = rest.replace(pattern, (...args) => {
      const match = args.slice(0, -2) as unknown as RegExpMatchArray;
      const { hour, minute, meridiem } = read(match);
      if (hour <= 24 && minute < 60) times.push({ hours: hoursFor(hour, meridiem), minute });
      return ' '.repeat(String(args[0]).length);
    });
  }
  return times;
}

const EN_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function rowLocal(startsAt: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(startsAt);
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return {
    day: EN_DAYS.indexOf(part('weekday') ?? ''),
    hour: Number(part('hour')),
    minute: Number(part('minute')),
  };
}

export function dayTimeConflict(
  sentence: string,
  startsAt: Date,
  timeZone: string,
  locale: string | undefined,
): boolean {
  const row = rowLocal(startsAt, timeZone);
  const days = namedDays(sentence, locale);
  if (days.size > 0 && !days.has(row.day)) return true;
  const times = namedTimes(sentence);
  return (
    times.length > 0 && !times.some((t) => t.minute === row.minute && t.hours.includes(row.hour))
  );
}
