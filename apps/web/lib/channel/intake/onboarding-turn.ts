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
  stopAsking: false,
};

/** The order Hale walks. Guidance for the model, and the order code uses once fields are stored. */
export const ONBOARDING_ORDER = ['postal', 'ages', 'pick', 'name', 'calendar', 'gmail'] as const;

export type OnboardingItem = (typeof ONBOARDING_ORDER)[number];

export interface OnboardingChecklist {
  postal: boolean;
  ages: boolean;
  pick: boolean;
  name: boolean;
  calendar: boolean;
  gmail: boolean;
}

export const EMPTY_CHECKLIST: OnboardingChecklist = {
  postal: false,
  ages: false,
  pick: false,
  name: false,
  calendar: false,
  gmail: false,
};

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
    if (ageMonths === null) return [];
    const agePrecision: 'years' | 'months' =
      item.agePrecision === 'years' || item.agePrecision === 'months'
        ? item.agePrecision
        : 'months';
    return [{ name: acceptName(item.name), ageMonths, agePrecision }];
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
    ages: prior.ages || capture.children.some((child) => child.ageMonths != null),
    pick: prior.pick || extra.pickConfirmed === true,
    name: prior.name || capture.parentName != null,
    calendar: prior.calendar || capture.connectCalendar != null,
    gmail: prior.gmail || capture.connectGmail != null,
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
  const children: ExtractedChild[] =
    capture.children.length > 0
      ? capture.children.map((child) => ({
          name: child.name,
          ageMonths: child.ageMonths,
          agePrecision: child.agePrecision ?? 'months',
        }))
      : [...prior.children];
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
