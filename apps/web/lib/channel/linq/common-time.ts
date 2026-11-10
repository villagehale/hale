import type { Database } from '@hale/db';
import { knownHouseholdTimezone } from '~/lib/channel/household-timezone';
import type { ReplyLanguage } from '~/lib/channel/language';
import { speak } from '~/lib/channel/spoken-line';
import { DEFAULT_LOOP_PREFS, loadLoopPrefsView } from '~/lib/loop/prefs';
import { formatWhen } from './household-calendar';

/**
 * Find a common time across families (VIL-459).
 *
 * Inputs are free/busy spans only (see `freeBusyOnly` in household-calendar.ts): a title,
 * place or attendee never enters this module, so it cannot reach the group. Families with
 * no connected calendar are not guessed at; they are named so the AI can ask them. What
 * people said in the chat ("not before 10", "Saturday is out") arrives as `blocked` spans,
 * read by the AI upstream. The group line itself is written by the AI from facts; when it
 * fails, nothing is sent.
 */

export interface Span {
  start: Date;
  end: Date;
}

export interface FamilyAvailability {
  /** The name the group already uses for this family. Never a private detail. */
  label: string;
  timeZone: string;
  /** Free/busy spans, or null when this family has no calendar connected. */
  busy: readonly Span[] | null;
  /** Local hour quiet time starts (default 21) and ends (default 8). */
  quietStartHour?: number;
  quietEndHour?: number;
}

export interface CommonTimeInput {
  families: readonly FamilyAvailability[];
  /** Spans the chat ruled out, for everyone. */
  blocked?: readonly Span[];
  now: Date;
  /** Up to three proposals. */
  count?: number;
  durationMinutes?: number;
  days?: number;
}

const HOUR_MS = 60 * 60 * 1000;
/** How long a proposed time runs, and so the plan a pick makes. */
export const COMMON_TIME_MINUTES = 60;
const DEFAULT_QUIET_START = 21;
const DEFAULT_QUIET_END = 8;
const MAX_PROPOSALS = 3;
const DEFAULT_DAYS = 7;

function localHour(date: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(date);
  return Number(hour);
}

/** Every hour of [start, end) sits between quiet end and quiet start in this family's zone. */
function awakeThroughout(family: FamilyAvailability, start: Date, end: Date): boolean {
  const wake = family.quietEndHour ?? DEFAULT_QUIET_END;
  const sleep = family.quietStartHour ?? DEFAULT_QUIET_START;
  for (let t = start.getTime(); t < end.getTime(); t += HOUR_MS) {
    const hour = localHour(new Date(t), family.timeZone);
    const quiet = sleep > wake ? hour >= sleep || hour < wake : hour >= sleep && hour < wake;
    if (quiet) return false;
  }
  return true;
}

function overlapsAny(spans: readonly Span[], start: Date, end: Date): boolean {
  return spans.some(
    (span) => span.start.getTime() < end.getTime() && start.getTime() < span.end.getTime(),
  );
}

/**
 * Up to three start times, on the hour, in the next `days`, that are outside every known
 * busy span, outside every chat-ruled-out span, and inside every family's waking hours in
 * its own time zone. Families with no calendar only constrain by waking hours.
 * Spread: at most one proposal per calendar day of the first family.
 */
export function findCommonTimes(input: CommonTimeInput): Date[] {
  const count = Math.min(input.count ?? MAX_PROPOSALS, MAX_PROPOSALS);
  const durationMs = (input.durationMinutes ?? COMMON_TIME_MINUTES) * 60 * 1000;
  const horizon = input.now.getTime() + (input.days ?? DEFAULT_DAYS) * 24 * HOUR_MS;
  const blocked = input.blocked ?? [];
  const anchorZone = input.families[0]?.timeZone ?? 'UTC';
  const found: Date[] = [];
  const days = new Set<string>();
  if (count <= 0 || input.families.length === 0) return found;
  let t = Math.ceil(input.now.getTime() / HOUR_MS) * HOUR_MS;
  for (; t + durationMs <= horizon && found.length < count; t += HOUR_MS) {
    const start = new Date(t);
    const end = new Date(t + durationMs);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: anchorZone }).format(start);
    if (days.has(day)) continue;
    if (overlapsAny(blocked, start, end)) continue;
    const ok = input.families.every(
      (family) =>
        awakeThroughout(family, start, end) && !overlapsAny(family.busy ?? [], start, end),
    );
    if (!ok) continue;
    found.push(start);
    days.add(day);
  }
  return found;
}

/**
 * A family's clock: its own zone (null when never set; Hale does not guess one) and the
 * waking hours its parent's own quiet hours leave. Quiet 21:30 to 07:30 leaves 08 to 21:
 * a proposal never touches a quiet minute. Equal ends mean no quiet window.
 */
export async function familyClock(
  database: Database,
  familyId: string,
  parentUserId: string | null,
): Promise<{ timeZone: string | null; quietStartHour: number; quietEndHour: number }> {
  const timeZone = await knownHouseholdTimezone(database, familyId);
  const prefs = parentUserId ? await loadLoopPrefsView(parentUserId, database) : DEFAULT_LOOP_PREFS;
  if (prefs.quietHoursStart === prefs.quietHoursEnd) {
    return { timeZone, quietStartHour: 24, quietEndHour: 0 };
  }
  const minutes = (clock: string) => {
    const [hour, minute] = clock.split(':').map(Number);
    return (hour ?? 0) * 60 + (minute ?? 0);
  };
  return {
    timeZone,
    quietStartHour: Math.floor(minutes(prefs.quietHoursStart) / 60),
    quietEndHour: Math.ceil(minutes(prefs.quietHoursEnd) / 60),
  };
}

/** Labels of families whose time Hale cannot see and has to ask about. */
export function familiesToAsk(families: readonly FamilyAvailability[]): string[] {
  return families.filter((family) => family.busy === null).map((family) => family.label);
}

/**
 * The only facts the AI gets. Each proposal is written in every distinct family time zone,
 * so nobody converts. No calendar content is present to leak.
 */
export function commonTimeFacts(
  input: CommonTimeInput,
  slots: readonly Date[],
  language: ReplyLanguage | null,
): Record<string, string> {
  const zones = [...new Set(input.families.map((family) => family.timeZone))];
  const facts: Record<string, string> = {
    checkedFamilies: input.families
      .filter((family) => family.busy !== null)
      .map((family) => family.label)
      .join(', '),
    askFamilies: familiesToAsk(input.families).join(', '),
    proposalCount: String(slots.length),
    searchedDays: String(input.days ?? DEFAULT_DAYS),
  };
  if (slots.length === 0) {
    // What Hale can truly do next. Hale never texts first, so it cannot promise to watch.
    facts.whenNoneWorks = 'someone names another day or week and Hale looks again';
  }
  slots.forEach((slot, index) => {
    facts[`option${index + 1}`] = zones
      .map((zone) =>
        zones.length > 1
          ? `${formatWhen(slot, zone, language ?? 'en')} (${zone})`
          : formatWhen(slot, zone, language ?? 'en'),
      )
      .join(' / ');
  });
  return facts;
}

/**
 * The group line, AI-written from facts. With no common time and nobody to ask, the facts
 * say so (no option) and the AI tells the group plainly. Null (send nothing) when the
 * writer failed: there is no fallback line.
 */
export async function composeCommonTime(
  input: CommonTimeInput,
  language: ReplyLanguage | null,
  write: typeof speak = speak,
): Promise<{ text: string; slots: Date[] } | null> {
  const slots = findCommonTimes(input);
  const text = await write({
    purpose: 'group_common_time',
    language,
    facts: commonTimeFacts(input, slots, language),
  });
  if (!text) return null;
  return { text, slots };
}
