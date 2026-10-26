import type { ReplyLanguage } from '~/lib/channel/language';
import { speak } from '~/lib/channel/spoken-line';
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
const DEFAULT_QUIET_START = 21;
const DEFAULT_QUIET_END = 8;
const MAX_PROPOSALS = 3;

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
    if (hour < wake || hour >= sleep) return false;
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
  const durationMs = (input.durationMinutes ?? 60) * 60 * 1000;
  const horizon = input.now.getTime() + (input.days ?? 7) * 24 * HOUR_MS;
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
  };
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
 * The group line, AI-written. Null (send nothing) when there is nothing true to say:
 * no common time and nobody to ask, or the writer failed.
 */
export async function composeCommonTime(
  input: CommonTimeInput,
  language: ReplyLanguage | null,
  write: typeof speak = speak,
): Promise<{ text: string; slots: Date[] } | null> {
  const slots = findCommonTimes(input);
  if (slots.length === 0 && familiesToAsk(input.families).length === 0) return null;
  const text = await write({
    purpose: 'group_common_time',
    language,
    facts: commonTimeFacts(input, slots, language),
  });
  if (!text) return null;
  return { text, slots };
}
