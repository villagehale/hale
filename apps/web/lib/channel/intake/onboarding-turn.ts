import {
  type ParentRoleGuess,
  acceptParentRole,
  preferParentRole,
} from '~/lib/channel/identity/parent-role';
import type { ExtractedChild } from './extract';
import { type FirstTouchPlace, placeFromGivenFields } from './first-touch-place';

/**
 * One activity the parent agreed to put on the calendar. The model settles
 * the day and cadence in conversation; code checks the shape and creates the
 * event. Adding is a reminder, never a registration.
 */
export interface ScheduleAdd {
  /** 1-based index into the real activity lines Hale showed. */
  line: number;
  cadence: 'once' | 'weekly';
  /** First occurrence, YYYY-MM-DD in the family's time zone. */
  date: string;
  /** HH:MM, or null when no start time was settled. */
  time: string | null;
  /** Weekly only. How many weeks to write. Null takes the default. */
  weeks: number | null;
  /** The kid it is for, as the model named them. Checked against the line's age fit. */
  child?: string | null;
}

/**
 * What the onboarding model may hand back with its reply.
 *
 * The model decides which of these the parent just gave. Code checks the shape
 * of each field and stores what passes. It does not read the parent's words to
 * decide which fields are present.
 */
export type CoparentGroupMode = 'existing' | 'new';

export interface OnboardingCapture {
  postalCode: string | null;
  city: string | null;
  children: {
    name: string | null;
    ageMonths: number | null;
    agePrecision: 'years' | 'months' | null;
  }[];
  parentName: string | null;
  /**
   * VIL-417. The model's soft read of whether this parent is the mother or the
   * father, from their name or from what they said ("my wife", "I'm his dad").
   * `unknown` for an ambiguous name. Code validates the enum and stores it.
   */
  parentRole: ParentRoleGuess | null;
  /** Their answer when asked whether a held name is the right one to use. */
  nameConfirmed: boolean | null;
  connectCalendar: boolean | null;
  connectGmail: boolean | null;
  /** Activities they agreed to put on the calendar, with the settled schedule. */
  scheduleAdds: ScheduleAdd[];
  /** Nothing more to add to the calendar: declined, or every wanted activity is on. */
  scheduleDone: boolean;
  /** Whether to set up the group chat with the co-parent. Null until they answer. */
  coparentGroup: boolean | null;
  /**
   * Which group a yes means: the family group they already have (`existing`), or a
   * new one with the other parent (`new`). Code holds it to the parent's words.
   */
  coparentGroupMode: CoparentGroupMode | null;
  /** They do not want to give a parent name. Do not ask it again. */
  nameDeclined: boolean;
  /** They do not want to give the kids' names. Do not ask that again. */
  kidsNamesDeclined: boolean;
  /** Not now for the calendar. Do not ask it again in this onboarding. */
  calendarLater: boolean;
  /** Not now for email. Do not ask it again in this onboarding. */
  gmailLater: boolean;
  stopAsking: boolean;
}

export const EMPTY_ONBOARDING_CAPTURE: OnboardingCapture = {
  postalCode: null,
  city: null,
  children: [],
  parentName: null,
  parentRole: null,
  nameConfirmed: null,
  connectCalendar: null,
  connectGmail: null,
  scheduleAdds: [],
  scheduleDone: false,
  coparentGroup: null,
  coparentGroupMode: null,
  nameDeclined: false,
  kidsNamesDeclined: false,
  calendarLater: false,
  gmailLater: false,
  stopAsking: false,
};

/**
 * The order Hale walks. Guidance for the model, and the order code uses once
 * fields are stored. The activity map (step 4) is not an item: it is shown
 * between ages and the parent's name and asks nothing. The two wow moments
 * ride the connected receipts, not this list.
 */
export const ONBOARDING_ORDER = [
  'postal',
  'kids',
  'ages',
  'name',
  'gmail',
  'calendar',
  'schedule',
  'coparent',
] as const;

export type OnboardingItem = (typeof ONBOARDING_ORDER)[number];

export type OnboardingChecklist = Record<OnboardingItem, boolean>;

export const EMPTY_CHECKLIST: OnboardingChecklist = {
  postal: false,
  kids: false,
  ages: false,
  name: false,
  gmail: false,
  calendar: false,
  schedule: false,
  coparent: false,
};

/** A find still waiting on a pick, older than this, is not what the next text answers. */
export const COLD_START_FRESH_MS = 6 * 60 * 60 * 1000;

/**
 * True when the last thing on the thread is at least {@link COLD_START_FRESH_MS} old.
 * A missing stamp is not stale: there is no old question to retire.
 */
export function coldStartIsStale(lastActivityAt: string | null | undefined, now: Date): boolean {
  if (!lastActivityAt) return false;
  const at = Date.parse(lastActivityAt);
  if (Number.isNaN(at)) return false;
  return now.getTime() - at >= COLD_START_FRESH_MS;
}

/**
 * Only the legacy unanswered pick goes stale. Every item on the current
 * order is answered whenever it arrives, including the next day.
 */
export function coldStartQuestionIsStale(
  step: string | null | undefined,
  lastActivityAt: string | null | undefined,
  now: Date,
): boolean {
  return step === 'pick' && coldStartIsStale(lastActivityAt, now);
}

export function lastTranscriptAt(transcript: readonly { at: string }[]): string | null {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const at = transcript[i]?.at;
    if (at) return at;
  }
  return null;
}

/** Every child we are keeping has an age. A named child with no age is not done. */
export function agesAreComplete(children: readonly { ageMonths: number | null }[]): boolean {
  return children.length > 0 && children.every((child) => child.ageMonths != null);
}

/** Every child we are keeping has a first name. */
export function kidsAreNamed(children: readonly { name: string | null }[]): boolean {
  return (
    children.length > 0 &&
    children.every((child) => child.name != null && child.name.trim().length > 0)
  );
}

const MAX_AGE_MONTHS = 216;
/** The most weekly occurrences one schedule add may write. */
export const MAX_SCHEDULE_WEEKS = 12;
export const DEFAULT_SCHEDULE_WEEKS = 8;
/** A first occurrence more than a year out is not this year's plan. */
const MAX_SCHEDULE_DAYS_AHEAD = 366;

export function onboardingMissing(list: OnboardingChecklist): OnboardingItem[] {
  return ONBOARDING_ORDER.filter((item) => !list[item]);
}

function acceptName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 40) return null;
  if (/[?\d]/u.test(trimmed)) return null;
  if (trimmed.split(/\s+/u).length > 3) return null;
  if (!/\p{L}/u.test(trimmed)) return null;
  return trimmed;
}

function acceptBool(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  return null;
}

function acceptGroupMode(value: unknown): CoparentGroupMode | null {
  return value === 'existing' || value === 'new' ? value : null;
}

function validDayKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const at = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

export interface ScheduleLimits {
  findLineCount: number;
  /** YYYY-MM-DD of today in the family's zone. A date before it is dropped. */
  today?: string | null;
  /** The real map lines, so an add can be checked against the line's day, time and age fit. */
  lines?: readonly string[];
  /** The kids as stored, for the age-fit check. */
  children?: readonly { name: string | null; ageMonths: number | null }[];
  /** Lines already on the calendar from this onboarding. A repeat is dropped, not refused. */
  scheduledLines?: readonly number[];
}

const WEEKDAY_INDEX: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/** The weekdays a line runs on ("Tuesdays 9:30", "Tuesdays and Thursdays"), as 0-6. */
export function lineWeekdays(line: string): number[] {
  const found =
    line.match(/\b(sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:days?)?\b/giu) ?? [];
  const days = new Set<number>();
  for (const token of found) {
    const index = WEEKDAY_INDEX[token.slice(0, 3).toLowerCase()];
    if (index != null) days.add(index);
  }
  return [...days].sort((a, b) => a - b);
}

/** The one start time a line names ("Saturdays 11:00", "Wednesdays 18:30"), as HH:MM. */
export function lineStartTime(line: string): string | null {
  const times = line.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/gu) ?? [];
  if (times.length !== 1) return null;
  const [hour, minute] = (times[0] ?? '').split(':');
  return `${String(Number(hour)).padStart(2, '0')}:${minute}`;
}

/**
 * The age fit a line states, in months, inclusive: "(6-36 months)", "(0-6 yrs)",
 * "(ages 6-8)". Null when the line does not say ("all ages", nothing in brackets).
 */
export function lineAgeFitMonths(line: string): { min: number; max: number } | null {
  const match =
    /\((?:ages?\s*)?(\d{1,2})\s*[-\u2013]\s*(\d{1,2})\s*(months?|mos?|yrs?|years?)?\)/iu.exec(line);
  if (!match) return null;
  const low = Number(match[1]);
  const high = Number(match[2]);
  if (/^mo/iu.test(match[3] ?? '')) return { min: low, max: high };
  return { min: low * 12, max: high * 12 + 11 };
}

function weekdayOf(dayKey: string): number {
  return new Date(`${dayKey}T12:00:00Z`).getUTCDay();
}

function shiftDayKey(dayKey: string, days: number): string {
  const at = new Date(`${dayKey}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** The first day on or after `dayKey` that the line runs on. The line's day is the fact. */
function snapToLineDay(dayKey: string, weekdays: readonly number[]): string {
  if (weekdays.length === 0 || weekdays.includes(weekdayOf(dayKey))) return dayKey;
  for (let offset = 1; offset < 7; offset += 1) {
    const next = shiftDayKey(dayKey, offset);
    if (weekdays.includes(weekdayOf(next))) return next;
  }
  return dayKey;
}

/** The stored kid an add names: the same first name, or a nickname it starts ("Seb"). */
function childNamed(
  name: string,
  children: readonly { name: string | null; ageMonths: number | null }[],
): { name: string | null; ageMonths: number | null } | undefined {
  const given = name.trim().toLowerCase();
  if (given.length < 2) return undefined;
  return children.find((child) => {
    const kid = (child.name ?? '').trim().toLowerCase();
    if (kid.length < 2) return false;
    return kid === given || (given.length >= 3 && kid.startsWith(given));
  });
}

/**
 * Keep an add only when it points at a real line and names a real day.
 * Code never fills a missing date: a proposal the parent has not settled is
 * not an event.
 */
export function acceptScheduleAdd(raw: unknown, limits: ScheduleLimits): ScheduleAdd | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const line = row.line;
  if (
    typeof line !== 'number' ||
    !Number.isInteger(line) ||
    line < 1 ||
    line > limits.findLineCount
  ) {
    return null;
  }
  const cadence = row.cadence === 'weekly' ? 'weekly' : row.cadence === 'once' ? 'once' : null;
  if (!cadence) return null;
  const text = limits.lines?.[line - 1] ?? '';
  const child = typeof row.child === 'string' && row.child.trim() ? row.child.trim() : null;
  // A line for a baby is not the six-year-old's: the age fit the line states is the check.
  if (child && limits.children) {
    const kid = childNamed(child, limits.children);
    const fit = lineAgeFitMonths(text);
    if (kid?.ageMonths != null && fit && (kid.ageMonths < fit.min || kid.ageMonths > fit.max)) {
      return null;
    }
  }
  const proposed = typeof row.date === 'string' ? row.date.trim() : '';
  if (!validDayKey(proposed)) return null;
  // The day the line runs on wins over the day the model counted to.
  const date = snapToLineDay(proposed, lineWeekdays(text));
  if (limits.today) {
    if (date < limits.today) return null;
    const ahead =
      (Date.parse(`${date}T12:00:00Z`) - Date.parse(`${limits.today}T12:00:00Z`)) / 86_400_000;
    if (ahead > MAX_SCHEDULE_DAYS_AHEAD) return null;
  }
  const given =
    typeof row.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/u.test(row.time.trim())
      ? row.time.trim()
      : null;
  const time = lineStartTime(text) ?? given;
  const weeks =
    cadence === 'weekly' &&
    typeof row.weeks === 'number' &&
    Number.isInteger(row.weeks) &&
    row.weeks >= 1 &&
    row.weeks <= MAX_SCHEDULE_WEEKS
      ? row.weeks
      : null;
  return { line, cadence, date, time, weeks, child };
}

/** An add for a line that is already on the calendar: dropped quietly, it is already there. */
function alreadyScheduled(raw: unknown, limits: ScheduleLimits): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const line = (raw as Record<string, unknown>).line;
  return typeof line === 'number' && (limits.scheduledLines ?? []).includes(line);
}

/**
 * How many adds the model wrote that code refused: a line off the map, a day
 * that is not a real upcoming date. The same line twice is one add, not a
 * refusal. A reply that came with a refused add may confirm something that
 * was never written, so the caller treats it as unusable.
 */
export function countRejectedScheduleAdds(raw: unknown, limits: ScheduleLimits): number {
  if (!raw || typeof raw !== 'object') return 0;
  const addsIn = (raw as Record<string, unknown>).scheduleAdds;
  if (!Array.isArray(addsIn)) return 0;
  return addsIn.filter(
    (add) => !alreadyScheduled(add, limits) && acceptScheduleAdd(add, limits) === null,
  ).length;
}

/**
 * Keep a field only when it is the shape of that fact.
 */
export function acceptOnboardingCapture(
  raw: unknown,
  limits: ScheduleLimits = { findLineCount: 0 },
): OnboardingCapture {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_ONBOARDING_CAPTURE, scheduleAdds: [] };
  const row = raw as Record<string, unknown>;
  const postalCode = typeof row.postalCode === 'string' ? row.postalCode.trim() : null;
  const city = typeof row.city === 'string' ? row.city.trim() : null;
  const childrenIn = Array.isArray(row.children) ? row.children : [];
  const children = childrenIn.flatMap((child) => {
    if (!child || typeof child !== 'object') return [];
    const item = child as Record<string, unknown>;
    const ageMonths =
      typeof item.ageMonths === 'number' &&
      Number.isInteger(item.ageMonths) &&
      item.ageMonths >= 0 &&
      item.ageMonths <= MAX_AGE_MONTHS
        ? item.ageMonths
        : null;
    const name = acceptName(item.name);
    if (ageMonths === null && !name) return [];
    const agePrecision: 'years' | 'months' | null =
      ageMonths === null
        ? null
        : item.agePrecision === 'years' || item.agePrecision === 'months'
          ? item.agePrecision
          : 'months';
    return [{ name, ageMonths, agePrecision }];
  });
  const addsIn = Array.isArray(row.scheduleAdds) ? row.scheduleAdds : [];
  const scheduleAdds: ScheduleAdd[] = [];
  for (const add of addsIn) {
    if (alreadyScheduled(add, limits)) continue;
    const accepted = acceptScheduleAdd(add, limits);
    // One add per line: the same activity settled twice in one message is one reminder.
    if (accepted && !scheduleAdds.some((seen) => seen.line === accepted.line)) {
      scheduleAdds.push(accepted);
    }
  }
  return {
    postalCode: postalCode && postalCode.length > 0 ? postalCode : null,
    city: city && city.length > 0 ? city : null,
    children,
    parentName: acceptName(row.parentName),
    parentRole: acceptParentRole(row.parentRole, row.parentRoleBasis),
    nameConfirmed: acceptBool(row.nameConfirmed),
    connectCalendar: acceptBool(row.connectCalendar),
    connectGmail: acceptBool(row.connectGmail),
    scheduleAdds,
    scheduleDone: row.scheduleDone === true,
    coparentGroup: acceptBool(row.coparentGroup),
    coparentGroupMode: acceptGroupMode(row.coparentGroupMode),
    nameDeclined: row.nameDeclined === true,
    kidsNamesDeclined: row.kidsNamesDeclined === true,
    calendarLater: row.calendarLater === true,
    gmailLater: row.gmailLater === true,
    stopAsking: row.stopAsking === true,
  };
}

export function checklistAfter(
  prior: OnboardingChecklist,
  capture: OnboardingCapture,
): OnboardingChecklist {
  return {
    postal:
      prior.postal ||
      placeFromGivenFields({ postalCode: capture.postalCode, city: capture.city }) != null,
    kids: prior.kids || capture.kidsNamesDeclined || kidsAreNamed(capture.children),
    ages: prior.ages || agesAreComplete(capture.children),
    name: prior.name || capture.parentName != null || capture.nameDeclined,
    gmail: prior.gmail || capture.connectGmail != null || capture.gmailLater,
    calendar: prior.calendar || capture.connectCalendar != null || capture.calendarLater,
    schedule: prior.schedule || capture.scheduleDone,
    coparent: prior.coparent || capture.coparentGroup != null,
  };
}

function sameAdd(a: ScheduleAdd, b: ScheduleAdd): boolean {
  return a.line === b.line && a.date === b.date && a.cadence === b.cadence;
}

/** Prefer the later capture, and keep a prior fact when the new one is empty. */
export function mergeCaptures(
  prior: OnboardingCapture,
  next: OnboardingCapture,
): OnboardingCapture {
  const scheduleAdds = [
    ...prior.scheduleAdds,
    ...next.scheduleAdds.filter((add) => !prior.scheduleAdds.some((seen) => sameAdd(seen, add))),
  ];
  return {
    postalCode: next.postalCode ?? prior.postalCode,
    city: next.city ?? prior.city,
    children: next.children.length > 0 ? next.children : prior.children,
    parentName: next.parentName ?? prior.parentName,
    parentRole: preferParentRole(prior.parentRole, next.parentRole),
    nameConfirmed: next.nameConfirmed ?? prior.nameConfirmed,
    connectCalendar: next.connectCalendar ?? prior.connectCalendar,
    connectGmail: next.connectGmail ?? prior.connectGmail,
    scheduleAdds,
    scheduleDone: next.scheduleDone || prior.scheduleDone,
    coparentGroup: next.coparentGroup ?? prior.coparentGroup,
    coparentGroupMode: next.coparentGroupMode ?? prior.coparentGroupMode,
    nameDeclined: next.nameDeclined || prior.nameDeclined,
    kidsNamesDeclined: next.kidsNamesDeclined || prior.kidsNamesDeclined,
    calendarLater: next.calendarLater || prior.calendarLater,
    gmailLater: next.gmailLater || prior.gmailLater,
    stopAsking: next.stopAsking || prior.stopAsking,
  };
}

export interface StoredOnboarding {
  collectedChildren: ExtractedChild[];
  postalCode: string | null;
  place: FirstTouchPlace | null;
  parentName: string | null;
  parentRole: ParentRoleGuess | null;
  connectCalendar: boolean | null;
  connectGmail: boolean | null;
}

/**
 * Fold a model's children into the ones already stored.
 * A named child updates that child. One unnamed age updates the only child,
 * which is how "actually 5" lands. A name with no age is kept so the age
 * question can come back for that child.
 */
export function mergeChildFacts(
  prior: readonly ExtractedChild[],
  incoming: readonly {
    name: string | null;
    ageMonths: number | null;
    agePrecision: 'years' | 'months' | null;
  }[],
): ExtractedChild[] {
  if (incoming.length === 0) return prior.map((child) => ({ ...child }));
  if (prior.length === 0) {
    return incoming.map((child) => ({
      name: child.name,
      ageMonths: child.ageMonths,
      agePrecision: child.ageMonths == null ? null : (child.agePrecision ?? 'months'),
    }));
  }
  const next = prior.map((child) => ({ ...child }));
  const used = new Set<number>();
  for (const child of incoming) {
    let index = -1;
    if (child.name) {
      index = next.findIndex(
        (row, i) => !used.has(i) && row.name?.toLowerCase() === child.name?.toLowerCase(),
      );
    }
    if (index < 0 && !child.name && incoming.length === 1 && next.length === 1) index = 0;
    if (index < 0 && child.name && incoming.length === 1 && next.length === 1 && !next[0]?.name) {
      index = 0;
    }
    if (index < 0 && !child.name && child.ageMonths != null) {
      index = next.findIndex((row, i) => !used.has(i) && row.ageMonths == null);
    }
    if (index < 0 && child.name && child.ageMonths == null) {
      index = next.findIndex((row, i) => !used.has(i) && !row.name);
    }
    const row = index >= 0 ? next[index] : undefined;
    if (row) {
      used.add(index);
      if (child.name) row.name = child.name;
      if (child.ageMonths != null) {
        row.ageMonths = child.ageMonths;
        row.agePrecision = child.agePrecision ?? row.agePrecision ?? 'months';
      }
    } else if (child.name || child.ageMonths != null) {
      next.push({
        name: child.name,
        ageMonths: child.ageMonths,
        agePrecision: child.ageMonths == null ? null : (child.agePrecision ?? 'months'),
      });
    }
  }
  return next;
}

function foldName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .trim();
}

/**
 * The parent's name is never one of the kids' names, or a kid's nickname
 * ("Seb" for Sebastian). A model that read the kids' names as the parent's
 * stored the one-year-old as the account holder once; code does not let it.
 */
export function namesAChild(name: string, children: readonly { name: string | null }[]): boolean {
  const given = foldName(name);
  if (given.length < 2) return false;
  return children.some((child) => {
    const kid = foldName(child.name ?? '');
    if (kid.length < 2) return false;
    if (kid === given) return true;
    const shorter = kid.length < given.length ? kid : given;
    const longer = shorter === kid ? given : kid;
    return shorter.length >= 3 && longer.startsWith(shorter);
  });
}

/**
 * Turn a model capture into facts code can store.
 * A postal or city is kept only when the field itself is one we can place.
 * A stated role replaces a guess; a later guess replaces an earlier guess.
 * A parent name that is one of the kids' names is dropped.
 */
export function storedFromCapture(
  prior: {
    children: readonly ExtractedChild[];
    postalCode: string | null;
    place: FirstTouchPlace | null;
    parentName: string | null;
    parentRole?: ParentRoleGuess | null;
    connectCalendar: boolean | null;
    connectGmail: boolean | null;
  },
  capture: OnboardingCapture,
): StoredOnboarding {
  const placed = placeFromGivenFields({
    postalCode: capture.postalCode,
    city: capture.city,
  });
  const place = placed ?? prior.place;
  const children = mergeChildFacts(prior.children, capture.children);
  const parentName =
    capture.parentName && !namesAChild(capture.parentName, children) ? capture.parentName : null;
  return {
    collectedChildren: children,
    postalCode: place?.postalCode ?? prior.postalCode,
    place,
    parentName: parentName ?? prior.parentName,
    parentRole: preferParentRole(prior.parentRole ?? null, capture.parentRole),
    connectCalendar: capture.connectCalendar ?? prior.connectCalendar,
    connectGmail: capture.connectGmail ?? prior.connectGmail,
  };
}

/** Title and day off a line Hale fetched. The parent's message is not an input. */
export function activityFromFindLine(line: string): { activity: string; day: string | null } {
  const trimmed = line.trim();
  const match = /^(.+?)(?:\s+\([^)]*\))?(?:\s+-\s+(.+))?$/u.exec(trimmed);
  const activity = match?.[1]?.trim() || trimmed;
  const day = match?.[2]?.trim();
  return { activity, day: day && day.length > 0 ? day : null };
}
