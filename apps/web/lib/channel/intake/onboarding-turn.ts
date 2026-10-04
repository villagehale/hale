import type { ExtractedChild } from './extract';
import { type FirstTouchPlace, placeFromGivenFields } from './first-touch-place';

/**
 * What the onboarding model may hand back with its reply.
 *
 * The model decides which of these the parent just gave. Code checks the shape
 * of each field and stores what passes. It does not read the parent's words to
 * decide which fields are present.
 */
export interface OnboardingCapture {
  postalCode: string | null;
  city: string | null;
  children: {
    name: string | null;
    ageMonths: number | null;
    agePrecision: 'years' | 'months' | null;
  }[];
  parentName: string | null;
  /** 1-based index into the real activity lines. Pending until those lines exist. */
  activityPick: number | null;
  connectCalendar: boolean | null;
  connectGmail: boolean | null;
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
  activityPick: null,
  connectCalendar: null,
  connectGmail: null,
  nameDeclined: false,
  kidsNamesDeclined: false,
  calendarLater: false,
  gmailLater: false,
  stopAsking: false,
};

/** The order Hale walks. Guidance for the model, and the order code uses once fields are stored. */
export const ONBOARDING_ORDER = [
  'postal',
  'ages',
  'pick',
  'name',
  'kids',
  'calendar',
  'gmail',
] as const;

export type OnboardingItem = (typeof ONBOARDING_ORDER)[number];

export interface OnboardingChecklist {
  postal: boolean;
  ages: boolean;
  pick: boolean;
  name: boolean;
  kids: boolean;
  calendar: boolean;
  gmail: boolean;
}

export const EMPTY_CHECKLIST: OnboardingChecklist = {
  postal: false,
  ages: false,
  pick: false,
  name: false,
  kids: false,
  calendar: false,
  gmail: false,
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
 * Only the unanswered find goes stale. Name, calendar, and email are answered
 * whenever they arrive, including the next day.
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

const MAX_PENDING_PICK = 3;
const MAX_AGE_MONTHS = 216;

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

/**
 * Keep a field only when it is the shape of that fact.
 * A pick is kept as pending (1–3) before any lines exist, and only if it
 * points at a real line once they do.
 */
export function acceptOnboardingCapture(
  raw: unknown,
  limits: { findLineCount: number } = { findLineCount: 0 },
): OnboardingCapture {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_ONBOARDING_CAPTURE };
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
  const pickRaw = row.activityPick;
  const pickMax = limits.findLineCount > 0 ? limits.findLineCount : MAX_PENDING_PICK;
  const activityPick =
    typeof pickRaw === 'number' && Number.isInteger(pickRaw) && pickRaw >= 1 && pickRaw <= pickMax
      ? pickRaw
      : null;
  return {
    postalCode: postalCode && postalCode.length > 0 ? postalCode : null,
    city: city && city.length > 0 ? city : null,
    children,
    parentName: acceptName(row.parentName),
    activityPick,
    connectCalendar: acceptBool(row.connectCalendar),
    connectGmail: acceptBool(row.connectGmail),
    nameDeclined: row.nameDeclined === true,
    kidsNamesDeclined: row.kidsNamesDeclined === true,
    calendarLater: row.calendarLater === true,
    gmailLater: row.gmailLater === true,
    stopAsking: row.stopAsking === true,
  };
}

/** A pending pick becomes real only when it selects one of the lines code fetched. */
export function confirmActivityPick(pick: number | null, lineCount: number): number | null {
  if (pick == null || lineCount <= 0) return null;
  if (!Number.isInteger(pick) || pick < 1 || pick > lineCount) return null;
  return pick;
}

export function checklistAfter(
  prior: OnboardingChecklist,
  capture: OnboardingCapture,
  extra: { pickConfirmed?: boolean } = {},
): OnboardingChecklist {
  return {
    postal:
      prior.postal ||
      placeFromGivenFields({ postalCode: capture.postalCode, city: capture.city }) != null,
    ages: prior.ages || agesAreComplete(capture.children),
    pick: prior.pick || extra.pickConfirmed === true,
    name: prior.name || capture.parentName != null || capture.nameDeclined,
    kids: prior.kids || capture.kidsNamesDeclined || kidsAreNamed(capture.children),
    calendar: prior.calendar || capture.connectCalendar != null || capture.calendarLater,
    gmail: prior.gmail || capture.connectGmail != null || capture.gmailLater,
  };
}

/** Prefer the later capture, and keep a prior fact when the new one is empty. */
export function mergeCaptures(
  prior: OnboardingCapture,
  next: OnboardingCapture,
): OnboardingCapture {
  return {
    postalCode: next.postalCode ?? prior.postalCode,
    city: next.city ?? prior.city,
    children: next.children.length > 0 ? next.children : prior.children,
    parentName: next.parentName ?? prior.parentName,
    activityPick: next.activityPick ?? prior.activityPick,
    connectCalendar: next.connectCalendar ?? prior.connectCalendar,
    connectGmail: next.connectGmail ?? prior.connectGmail,
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
  activityPick: number | null;
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

/**
 * Turn a model capture into facts code can store.
 * A postal or city is kept only when the field itself is one we can place.
 */
export function storedFromCapture(
  prior: {
    children: readonly ExtractedChild[];
    postalCode: string | null;
    place: FirstTouchPlace | null;
    parentName: string | null;
    activityPick: number | null;
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
  return {
    collectedChildren: children,
    postalCode: place?.postalCode ?? prior.postalCode,
    place,
    parentName: capture.parentName ?? prior.parentName,
    activityPick: capture.activityPick ?? prior.activityPick,
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
