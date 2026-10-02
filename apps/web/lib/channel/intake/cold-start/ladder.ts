/**
 * VIL-392 — cold-start planners.
 *
 * Names, gender, and pronouns never filter activities. Age is the only filter.
 * Kids' names are stored as a first name. Calendar and email are separate
 * asks and are never stacked. Calendar is due on the next reply after the
 * name line, or on day 7. Email is due only after a school, daycare, or camp
 * mention. Nothing here reads a plan tier.
 */

import type { FactWrite } from '~/lib/memory/facts';

const DAY_MS = 24 * 60 * 60 * 1000;
const SCHOOL = /\b(school|daycare|day care|camp|ecole|garderie)\b/i;
const SIGNUP_OPEN = /\b(sign-?ups? open|registration opens|inscriptions ouvrent)\b/i;

export function kidFirstName(name: string | null | undefined): string | null {
  if (!name) return null;
  const token = name
    .trim()
    .split(/\s+/)[0]
    ?.replace(/[^A-Za-zÀ-ÿ'-]/g, '');
  if (!token || token.length < 1 || token.length > 40) return null;
  return token;
}

/** UTC month difference. Never moves an age backwards. */
export function ageUpMonths(ageMonths: number, recordedAt: Date, now: Date): number {
  const months =
    (now.getUTCFullYear() - recordedAt.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - recordedAt.getUTCMonth());
  return Math.max(0, ageMonths + Math.max(0, months));
}

export function mentionsSchoolOrCamp(text: string): boolean {
  return SCHOOL.test(text);
}

export function calendarAskDue(input: {
  now: Date;
  familyStartedAt: Date;
  /** The name line already went out on an earlier reply. */
  nameLineSent: boolean;
  alreadyAsked: boolean;
}): boolean {
  if (input.alreadyAsked) return false;
  if (input.nameLineSent) return true;
  return input.now.getTime() >= input.familyStartedAt.getTime() + 7 * DAY_MS;
}

export function asksGender(text: string): boolean {
  return /\b(gender|boy or girl|girl or boy|sexe)\b/i.test(text);
}

/** The picked line names when sign-ups open. Otherwise the offer uses the activity day. */
export function signupDateKnownForPick(findBody: string, pick: string): boolean {
  const trimmed = pick.trim();
  if (!/^\d+$/.test(trimmed)) return false;
  const line = findBody.split('\n').find((row) => row.startsWith(`${trimmed}. `));
  if (!line) return false;
  return SIGNUP_OPEN.test(line);
}

export function activityFromFind(
  findBody: string,
  pick: string,
): { day: string; activity: string } | null {
  const trimmed = pick.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const line = findBody.split('\n').find((row) => row.startsWith(`${trimmed}. `));
  if (!line) return { day: 'then', activity: 'that one' };
  const match = /^\d+\.\s+(.+?)(?:\s+\([^)]*\))?(?:\s+-\s+(.+))?$/.exec(line);
  if (!match?.[1]) return { day: 'then', activity: 'that one' };
  return { day: match[2]?.trim() || 'then', activity: match[1].trim() };
}

export function ageCorrectionFact(input: {
  familyId: string;
  childId: string | null;
  ageMonths: number;
  now: Date;
}): FactWrite {
  return {
    familyId: input.familyId,
    childId: input.childId,
    factType: 'logistic',
    factKey: 'child-age-correction',
    factValue: { schemaVersion: 1, kind: 'age_correction', ageMonths: input.ageMonths },
    confidence: 1,
    inferredBy: 'cold_start_age_correction',
    validFrom: input.now,
    memoryKind: 'lasting',
    memorySource: 'parent_message',
    sourcedAt: input.now,
  };
}

/** "actually 5" / "Maya is 5 now" — a correction, not the first ages answer. */
export function ageCorrectionMonths(text: string): number | null {
  if (!/\b(actually|correction|now)\b/i.test(text)) return null;
  const years = /\b(\d+)\s*(?:years?|ans)\b/i.exec(text);
  if (years?.[1]) return Number(years[1]) * 12;
  const months = /\b(\d+)\s*(?:months?|mois)\b/i.exec(text);
  if (months?.[1]) return Number(months[1]);
  const bare = /\b(?:actually|now)\s+(\d+)\b/i.exec(text);
  if (bare?.[1]) return Number(bare[1]) * 12;
  return null;
}
