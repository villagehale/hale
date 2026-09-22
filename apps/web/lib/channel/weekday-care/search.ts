import type { Database, Municipality } from '@hale/db';
import { schema } from '@hale/db';
import { FAMILY_STAGES, type FamilyStage, deriveStage, isBeyondProductAge } from '@hale/types';
import { eq } from 'drizzle-orm';
import {
  type ActivityQuery,
  deidentifyActivityQuery,
  namesAPerson,
} from '~/lib/channel/activity/deidentify';
import type { ActivityFinder, ActivityPick } from '~/lib/channel/activity/lane';
import { productionActivityFamilyReader } from '~/lib/channel/activity/reader';
import type { WeekdaySearchPrompt } from '~/lib/channel/nudge/weekday-care-copy';
import { isPrintableGsm7Basic } from '~/lib/channel/sms-segments';
import { DEFAULT_TIMEZONE, dayKeyOf } from '~/lib/format/datetime';

/**
 * A yes to a weekday-finder ask, handed to the existing activity search.
 *
 * The SMS already asked for one job. This builds the de-identified query that job
 * consented to: stage bands (never an exact age or a name), the town the FSA names,
 * the date, and interests the parent already stated. A pick ships only when the
 * finder grounded it. Anything else is a named abstain, never a venue Hale wrote.
 */

export interface WeekdaySearchChild {
  stage: FamilyStage | null;
  interests: readonly string[];
}

export type WeekdaySearchDelivery =
  | { status: 'deliver'; body: string }
  | { status: 'abstain'; reason: string };

const SUBJECT: Record<WeekdaySearchPrompt, string> = {
  after_school: 'after-school activities',
  weekend_fallback: 'weekday activities',
  break: 'nearby activities',
};

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** `2026-10-09` → `October`. Not an ISO date, which the de-id scrub treats as a DOB. */
function monthName(dayKey: string): string {
  const month = Number(dayKey.slice(5, 7));
  return MONTHS[month - 1] ?? 'this month';
}

const STAGE_ORDER = new Map<FamilyStage, number>(
  FAMILY_STAGES.map((stage, index) => [stage, index]),
);

function interestPhrase(interests: readonly string[], householdNames: readonly string[]): string {
  const kept: string[] = [];
  for (const raw of interests) {
    const interest = raw.trim();
    if (interest.length === 0 || interest.length > 40) continue;
    if (!isPrintableGsm7Basic(interest)) continue;
    if (namesAPerson(interest, householdNames)) continue;
    kept.push(interest);
    if (kept.length === 3) break;
  }
  return kept.join(', ');
}

function stagesOf(children: readonly WeekdaySearchChild[]): FamilyStage[] {
  const present = new Set<FamilyStage>();
  for (const child of children) {
    if (child.stage !== null) present.add(child.stage);
  }
  return [...present].sort((a, b) => (STAGE_ORDER.get(a) ?? 0) - (STAGE_ORDER.get(b) ?? 0));
}

/**
 * The query a yes is allowed to send. Names, exact ages, and dates of birth are not
 * inputs: a caller that has them must leave them out before this function sees them.
 */
export function buildWeekdayActivityQuery(input: {
  children: readonly WeekdaySearchChild[];
  municipality: Municipality | null;
  now: Date;
  timeZone: string;
  householdNames: readonly string[];
  prompt: WeekdaySearchPrompt;
  /** Trailing ISO date on a verified break key, when the ask was a break. */
  breakDate?: string | null;
}): { ok: true; query: ActivityQuery } | { ok: false; reason: string } {
  const interests = input.children.flatMap((child) => [...child.interests]);
  const extra = interestPhrase(interests, input.householdNames);
  const subject = extra.length > 0 ? `${SUBJECT[input.prompt]} (${extra})` : SUBJECT[input.prompt];
  const today = dayKeyOf(input.now, input.timeZone);
  // A full ISO date is scrubbed as a date of birth before it can cross the border
  // (scrubResidualPii). The month is the availability the search is allowed to see.
  const window =
    input.prompt === 'break' && input.breakDate
      ? `during the break in ${monthName(input.breakDate)}`
      : `weekdays in ${monthName(today)}`;
  const bands = stagesOf(input.children);
  const stage = bands.length === 1 ? (bands[0] as FamilyStage) : null;

  const deidentified = deidentifyActivityQuery({
    subject,
    window,
    municipality: input.municipality,
    stage,
    householdNames: input.householdNames,
  });
  if (!deidentified.ok) return { ok: false, reason: deidentified.refusal };

  if (bands.length > 1) {
    return { ok: true, query: { ...deidentified.query, stage: null, stages: bands } };
  }
  return deidentified;
}

function pickSentence(pick: ActivityPick): string | null {
  if (pick.source !== 'web') return null;
  const name = pick.name.trim();
  const ageFit = pick.ageFit.trim();
  const sourceName = pick.sourceName.trim();
  if (name.length === 0 || ageFit.length === 0 || sourceName.length === 0) return null;
  const when = pick.when?.trim() ? ` ${pick.when.trim()}.` : '';
  const price = pick.price?.trim() ? ` ${pick.price.trim()}.` : '';
  return `${name}.${when} ${sourceName} lists it for ${ageFit}.${price}`
    .replace(/\s+/g, ' ')
    .trim();
}

/** Restate a grounded pick, or name why nothing can be sent. */
export async function runWeekdaySearch(
  finder: ActivityFinder,
  query: ActivityQuery,
  householdNames: readonly string[],
): Promise<WeekdaySearchDelivery> {
  let result: Awaited<ReturnType<ActivityFinder['find']>>;
  try {
    result = await finder.find(query);
  } catch {
    return { status: 'abstain', reason: 'ground_failed' };
  }
  if (!result.found) return { status: 'abstain', reason: result.reason };

  for (const pick of result.picks) {
    const sentence = pickSentence(pick);
    if (sentence === null) continue;
    if (!isPrintableGsm7Basic(sentence)) continue;
    if (namesAPerson(sentence, householdNames)) continue;
    return { status: 'deliver', body: sentence };
  }
  return { status: 'abstain', reason: 'not_deliverable' };
}

function breakDateOf(eventKey: string | null): string | null {
  if (eventKey === null) return null;
  const match = /(\d{4}-\d{2}-\d{2})$/.exec(eventKey);
  return match?.[1] ?? null;
}

/**
 * Load THIS family's stages, town, and interests, then search. The reads are
 * family-scoped. A missing school calendar is not consulted here: the ask that
 * opened this turn already had to be a verified break before `prompt` is `break`.
 */
export async function searchWeekdaysForFamily(
  database: Database,
  finder: ActivityFinder,
  input: {
    familyId: string;
    parentUserId: string;
    now: Date;
    prompt: WeekdaySearchPrompt;
    eventKey: string | null;
  },
): Promise<WeekdaySearchDelivery> {
  const reader = productionActivityFamilyReader();
  const [children, municipality, householdNames, parent] = await Promise.all([
    database
      .select({
        dateOfBirth: schema.children.dateOfBirth,
        interests: schema.children.interests,
      })
      .from(schema.children)
      .where(eq(schema.children.familyId, input.familyId)),
    reader.municipality(database, input.familyId),
    reader.householdNames(database, input.familyId),
    database
      .select({ timezone: schema.users.timezone })
      .from(schema.users)
      .where(eq(schema.users.id, input.parentUserId))
      .limit(1),
  ]);

  const built = buildWeekdayActivityQuery({
    children: children.map((child) => ({
      stage: isBeyondProductAge(child.dateOfBirth, input.now)
        ? null
        : deriveStage(child.dateOfBirth, input.now),
      interests: child.interests,
    })),
    municipality,
    now: input.now,
    timeZone: parent[0]?.timezone ?? DEFAULT_TIMEZONE,
    householdNames,
    prompt: input.prompt,
    breakDate: breakDateOf(input.eventKey),
  });
  if (!built.ok) return { status: 'abstain', reason: built.reason };
  return runWeekdaySearch(finder, built.query, householdNames);
}
