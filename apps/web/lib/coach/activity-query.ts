import { dayKeyOf } from '~/lib/format/datetime';

/**
 * A parent's time words, read as a calendar window rather than as text to match
 * against a title.
 *
 * "weekend" does not appear in "Fanous Lantern Craft", so a substring filter on
 * the phrase returns nothing even when Saturday is full of dated finds. The
 * phrase is a range. Whatever text is left is the needle. When that needle
 * matches nothing, the dated window (or the whole list, when they named no
 * time) is what we hand back — an empty text match is not an empty week.
 */
export interface ResolvedActivityQuery {
  needle: string | null;
  fromDay: string | null;
  toDay: string | null;
}

interface DayWindow {
  fromDay: string;
  toDay: string;
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function addDays(dayKey: string, days: number): string {
  const date = new Date(`${dayKey}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function weekdayIndex(dayKey: string): number {
  return new Date(`${dayKey}T12:00:00.000Z`).getUTCDay();
}

function thisWeekend(today: string): DayWindow {
  const dow = weekdayIndex(today);
  if (dow === 6) return { fromDay: today, toDay: addDays(today, 1) };
  if (dow === 0) return { fromDay: today, toDay: today };
  const saturday = addDays(today, 6 - dow);
  return { fromDay: saturday, toDay: addDays(saturday, 1) };
}

function nextWeekend(today: string): DayWindow {
  const current = thisWeekend(today);
  const saturday = addDays(current.toDay, weekdayIndex(current.toDay) === 6 ? 0 : 6);
  const nextSaturday = weekdayIndex(saturday) === 6 ? saturday : addDays(saturday, 6);
  return { fromDay: nextSaturday, toDay: addDays(nextSaturday, 1) };
}

function thisWeek(today: string): DayWindow {
  const dow = weekdayIndex(today);
  const sunday = dow === 0 ? today : addDays(today, 7 - dow);
  return { fromDay: today, toDay: sunday };
}

function nextWeek(today: string): DayWindow {
  const end = thisWeek(today).toDay;
  const monday = addDays(end, 1);
  return { fromDay: monday, toDay: addDays(monday, 6) };
}

function namedWeekday(today: string, index: number): DayWindow {
  const dow = weekdayIndex(today);
  const delta = (index - dow + 7) % 7;
  const day = addDays(today, delta);
  return { fromDay: day, toDay: day };
}

/** Longest first, so "this weekend" is not read as the bare word inside it. */
const TIME_PHRASES: ReadonlyArray<{
  phrase: string;
  window: (today: string) => DayWindow;
}> = [
  { phrase: 'this weekend', window: thisWeekend },
  { phrase: 'next weekend', window: nextWeekend },
  { phrase: 'the weekend', window: thisWeekend },
  { phrase: 'this week', window: thisWeek },
  { phrase: 'next week', window: nextWeek },
  { phrase: 'weekend', window: thisWeekend },
  { phrase: 'tonight', window: (today) => ({ fromDay: today, toDay: today }) },
  { phrase: 'today', window: (today) => ({ fromDay: today, toDay: today }) },
  {
    phrase: 'tomorrow',
    window: (today) => ({ fromDay: addDays(today, 1), toDay: addDays(today, 1) }),
  },
  ...Object.entries(WEEKDAY_INDEX).map(([name, index]) => ({
    phrase: name,
    window: (today: string) => namedWeekday(today, index),
  })),
];

function union(current: DayWindow | null, next: DayWindow): DayWindow {
  if (current === null) return next;
  return {
    fromDay: current.fromDay < next.fromDay ? current.fromDay : next.fromDay,
    toDay: current.toDay > next.toDay ? current.toDay : next.toDay,
  };
}

export function resolveActivityQuery(
  query: string | undefined,
  now: Date,
  timeZone: string,
): ResolvedActivityQuery {
  const today = dayKeyOf(now, timeZone);
  let rest = (query ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  let window: DayWindow | null = null;
  let guard = 0;
  while (rest !== '' && guard < 8) {
    guard += 1;
    const hit = TIME_PHRASES.find((entry) => new RegExp(`\\b${entry.phrase}\\b`).test(rest));
    if (!hit) break;
    window = union(window, hit.window(today));
    rest = rest
      .replace(new RegExp(`\\b${hit.phrase}\\b`), ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  const needle = rest.replace(/^[\s,.-]+|[\s,.-]+$/g, '').trim();
  return {
    needle: needle === '' ? null : needle,
    fromDay: window?.fromDay ?? null,
    toDay: window?.toDay ?? null,
  };
}

export function selectByActivityQuery<
  T extends { title: string; summary: string; eventDate: string | null },
>(views: readonly T[], query: string | undefined, now: Date, timeZone: string): T[] {
  const resolved = resolveActivityQuery(query, now, timeZone);
  const inRange =
    resolved.fromDay === null || resolved.toDay === null
      ? [...views]
      : views.filter(
          (view) =>
            view.eventDate !== null &&
            view.eventDate >= (resolved.fromDay as string) &&
            view.eventDate <= (resolved.toDay as string),
        );
  if (resolved.needle === null) return inRange;
  const needle = resolved.needle;
  const matched = inRange.filter(
    (view) =>
      view.title.toLowerCase().includes(needle) || view.summary.toLowerCase().includes(needle),
  );
  return matched.length > 0 ? matched : inRange;
}
