import type { WeekPlanItem } from '@hale/db';
import { deriveStage } from '@hale/types';
import { type ChildNameLevel, loopChildName } from '~/lib/loop/prefs';
import type { PlanChild } from './payload';

/**
 * VIL-218 · B2 weekly_plan renderer — the pure, channel-agnostic helpers the three
 * channel renderers share. No DB, no LLM, no `new Date()` of their own: `now` is
 * passed in so the teen age gate (deriveStage) is deterministic in tests. Privacy
 * (rule #1) is enforced here — a teen is never named, health detail is genericized
 * for the text channels, and the parent's child_name_level dial is honored.
 */

// ── Child naming ──────────────────────────────────────────────────────────────

const TEEN_SUBJECT = 'your teen';
const KIDS_SUBJECT = 'your kids';
// The header noun when no item concerns a child — used as the possessive determiner
// ("Your week"), so it never takes a trailing "'s".
const NO_CHILD_SUBJECT = 'Your';

function isTeen(child: PlanChild, now: Date): boolean {
  return deriveStage(child.dateOfBirth, now) === 'teenager';
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function joinNames(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0] ?? '';
  const last = names.at(-1) ?? '';
  return `${names.slice(0, -1).join(', ')} & ${last}`;
}

/**
 * The header noun for the children an item references, at the parent's level.
 * One child → its leveled name; a teen → the warmer "your teen" (loopChildName
 * would say "your kid"); multiple distinct first names → "Maya & Liam" / "A, B & C";
 * multiple at relation/generic (or any set with a teen) → "your kids". No children
 * → null (the caller renders the "Your" sentinel).
 */
export function headerNames(
  children: readonly PlanChild[],
  level: ChildNameLevel,
  now: Date,
): string | null {
  if (children.length === 0) return null;
  if (children.length === 1) {
    const child = children[0];
    if (!child) return null;
    if (isTeen(child, now)) return TEEN_SUBJECT;
    return loopChildName(child, level, now);
  }
  const anyTeen = children.some((c) => isTeen(c, now));
  if (level === 'first_name' && !anyTeen) {
    return joinNames(distinct(children.map((c) => c.name)));
  }
  return KIDS_SUBJECT;
}

/** The possessive of the header noun: "Your" (no children), "Maya's", "your kids'". */
export function weekSubject(names: string | null): string {
  if (names === null) return NO_CHILD_SUBJECT;
  return names.endsWith('s') ? `${names}'` : `${names}'s`;
}

/** The children an item in this plan actually references (so a no-child week reads
 * "Your"), preserving the payload's child order. */
export function childrenInPlan(
  items: readonly WeekPlanItem[],
  children: readonly PlanChild[],
): PlanChild[] {
  const ids = new Set(items.flatMap((i) => i.childIds));
  return children.filter((c) => ids.has(c.id));
}

// ── Item "what" (name-leveled or stripped, privacy-genericized) ────────────────

const EM_DASH = '—';
// The connectives compose bakes a child's first name onto in an item title.
const STRIP_PREFIXES = [` ${EM_DASH} `, "'s ", ' '] as const;

const SENSITIVE_CHECKUP = 'a checkup';
const SENSITIVE_APPOINTMENT = 'an appointment';

function itemChild(item: WeekPlanItem, children: readonly PlanChild[]): PlanChild | undefined {
  const id = item.childIds[0];
  if (!id) return undefined;
  return children.find((c) => c.id === id);
}

/** A privacy_sensitive item's coarse "what" — health detail NEVER rides SMS/push
 * (F11 principle 2), regardless of the family's name level. */
export function genericSensitiveWhat(item: WeekPlanItem): string {
  return item.kind === 'appointment' ? SENSITIVE_CHECKUP : SENSITIVE_APPOINTMENT;
}

/** The item's "what" with the family child's own baked first name removed — the SMS
 * header already names them, so repeating it wastes segments (and would leak a name
 * above the privacy level). Nameless titles pass through unchanged. */
export function strippedWhat(item: WeekPlanItem, children: readonly PlanChild[]): string {
  const child = itemChild(item, children);
  if (!child) return item.title;
  for (const sep of STRIP_PREFIXES) {
    const prefix = `${child.name}${sep}`;
    if (item.title.startsWith(prefix)) return item.title.slice(prefix.length);
  }
  return item.title;
}

/** The item's "what" with the baked first name re-leveled to the parent's dial
 * (email shows titles). first_name is a no-op; relation/generic swap in "your
 * daughter" / "your kid"; a teen (already generic in the artifact) has no name to
 * swap and stays generic — the age gate can only make it more private. */
export function leveledWhat(
  item: WeekPlanItem,
  children: readonly PlanChild[],
  level: ChildNameLevel,
  now: Date,
): string {
  const child = itemChild(item, children);
  if (!child) return item.title;
  const leveled = loopChildName(child, level, now);
  if (leveled === child.name) return item.title;
  return item.title.includes(child.name) ? item.title.replace(child.name, leveled) : item.title;
}

// ── Ordering, counts, labels ──────────────────────────────────────────────────

// Undated (month-coarse / undated) items sort after every real date key.
const UNDATED_SORT_KEY = '￿';

/** Items in chronological order — dated ascending by ISO key, undated last. */
export function itemsChronological(items: readonly WeekPlanItem[]): WeekPlanItem[] {
  return [...items].sort((a, b) => {
    const ak = a.startsAt ?? UNDATED_SORT_KEY;
    const bk = b.startsAt ?? UNDATED_SORT_KEY;
    if (ak === bk) return 0;
    return ak < bk ? -1 : 1;
  });
}

/** How many items ask something of the parent (a booking or a decision). */
export function pendingCount(items: readonly WeekPlanItem[]): number {
  return items.filter((i) => i.needs !== 'none').length;
}

/** Split a plan into the two things a parent reads it for: what still needs their
 * OK (a booking, a decision) and what is already handled (on the calendar). This is
 * the structural spine of the email + /plan card — the plan is two sections, not one
 * undifferentiated list. Input order is preserved within each side. */
export function partitionByNeed(items: readonly WeekPlanItem[]): {
  pending: WeekPlanItem[];
  handled: WeekPlanItem[];
} {
  const pending: WeekPlanItem[] = [];
  const handled: WeekPlanItem[] = [];
  for (const item of items) (item.needs === 'none' ? handled : pending).push(item);
  return { pending, handled };
}

const PROVENANCE_LABEL: Record<WeekPlanItem['kind'], string> = {
  appointment: 'Health',
  routine: 'Routine',
  village: 'Village',
  birthday: 'Birthday',
  suggestion: 'Suggestion',
};

/** The provenance chip shown next to an email item. */
export function provenanceLabel(kind: WeekPlanItem['kind']): string {
  return PROVENANCE_LABEL[kind];
}

const MONTH_ABBREV = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;
const EN_DASH = '–';

/** The Mon–Sun span of a week keyed on its Monday `weekStart` (a bare `YYYY-MM-DD`),
 * as a header kicker: "Jul 20 – 26" within a month, "Jul 28 – Aug 3" across one. Read
 * at UTC midnight so the label is timezone-independent (same technique as dayAbbrev). */
export function weekRangeLabel(weekStart: string): string {
  const start = new Date(`${weekStart.slice(0, 10)}T00:00:00Z`);
  const end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + 6);
  const startMonth = MONTH_ABBREV[start.getUTCMonth()];
  const endMonth = MONTH_ABBREV[end.getUTCMonth()];
  const head = `${startMonth} ${start.getUTCDate()}`;
  const tail =
    start.getUTCMonth() === end.getUTCMonth()
      ? `${end.getUTCDate()}`
      : `${endMonth} ${end.getUTCDate()}`;
  return `${head} ${EN_DASH} ${tail}`;
}

const WEEKDAY_ABBREV = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** The weekday label (Mon..Sun) of a family-local ISO start key, or null when the
 * item is day-coarse/undated. Parsed at UTC midnight so the calendar weekday of the
 * date key is timezone-independent (same technique as prefs.localParts). */
export function dayAbbrev(startsAt: string | null): string | null {
  if (!startsAt) return null;
  const weekday = new Date(`${startsAt.slice(0, 10)}T00:00:00Z`).getUTCDay();
  return WEEKDAY_ABBREV[weekday] ?? null;
}

/** The 12-hour clock label (e.g. "4:30") of a family-local ISO start key, or null
 * when the key carries no time (day-coarse). */
export function timeLabel(startsAt: string | null): string | null {
  if (!startsAt || !startsAt.includes('T')) return null;
  const [hStr, mStr] = startsAt.slice(11, 16).split(':');
  const hour24 = Number(hStr);
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${mStr}`;
}

// ── SMS encoding (GSM-7 vs UCS-2 segment math) ────────────────────────────────

// GSM 03.38 default alphabet (each char = 1 septet), excluding the ESC marker.
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
// Extension table (each char = 2 septets, preceded by ESC).
const GSM7_EXTENSION = '\f^{}\\[~]|€';

/** The GSM-7 septet length of `text`, or null when a char is outside the alphabet
 * (i.e. the message must be sent as UCS-2). */
function septetCount(text: string): number | null {
  let count = 0;
  for (const ch of text) {
    if (GSM7_BASIC.includes(ch)) count += 1;
    else if (GSM7_EXTENSION.includes(ch)) count += 2;
    else return null;
  }
  return count;
}

/** Whether `text` is encodable in the GSM-7 alphabet. */
export function isGsm7(text: string): boolean {
  return septetCount(text) !== null;
}

/**
 * The number of SMS segments `text` occupies. GSM-7: 160 septets in a lone segment,
 * 153 per segment once concatenated (7 septets of UDH). UCS-2: 70 UTF-16 code units
 * lone, 67 per concatenated segment. This is the concatenation math carriers bill on.
 */
export function smsSegments(text: string): number {
  const septets = septetCount(text);
  if (septets !== null) {
    return septets <= 160 ? 1 : Math.ceil(septets / 153);
  }
  const units = text.length;
  return units <= 70 ? 1 : Math.ceil(units / 67);
}

const GSM_NORMALIZE: ReadonlyArray<readonly [RegExp, string]> = [
  [/[–—]/g, '-'], // en / em dash
  [/[‘’‛]/g, "'"], // curly single quotes
  [/[“”]/g, '"'], // curly double quotes
  [/…/g, '...'], // ellipsis
  [/·/g, '-'], // middle dot
];

/**
 * Fold SMS copy into the GSM-7 alphabet: map typographic punctuation to its GSM
 * equivalent and drop anything still non-encodable (emoji). Keeping the SMS GSM-7 is
 * what lets a full week fit the ≤3-segment budget — a single non-GSM glyph would
 * force UCS-2 (67 chars/segment) and blow it. Applied once, at the SMS boundary.
 */
export function gsmSafe(text: string): string {
  let out = text;
  for (const [re, rep] of GSM_NORMALIZE) out = out.replace(re, rep);
  out = [...out].filter((ch) => GSM7_BASIC.includes(ch) || GSM7_EXTENSION.includes(ch)).join('');
  return out.replace(/ {2,}/g, ' ');
}
