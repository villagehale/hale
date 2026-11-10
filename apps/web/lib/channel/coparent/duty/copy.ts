import { classifyKidCalendarItem } from '~/lib/channel/linq/kid-event';

/**
 * Facts for duty lines (VIL-507, absolute zero fixed copy).
 *
 * There is no sentence here in any language. Each line is a purpose, the facts the
 * model may use, and whether its one next step may be a question. The model writes
 * every word (reply-copy); a miss holds the send.
 *
 * A name is filled only from words a parent said, or from the one parent whose
 * calendar holds the event. Callers pass that decision in. This module does
 * not look a name up and does not invent one.
 */

export type DutyCopyId =
  | 'week_overview'
  | 'reask_48h'
  | 'night_before'
  | 'parent_initiated'
  | 'which_kid'
  | 'both_claimed'
  | 'silent_parent';

export type DutyCopyLanguage = 'en' | 'fr';

/** Values substituted into a locked template. Empty and missing both refuse. */
export interface DutyCopyParams {
  name?: string | null;
  kid?: string | null;
  event?: string | null;
  day?: string | null;
  time?: string | null;
  parentA?: string | null;
  parentB?: string | null;
  kids?: string | null;
  list?: string | null;
}

export class DutyCopyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DutyCopyError';
  }
}

const EN_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const FR_DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const BANNED = /\b(booked|enrolled|signed up)\b/i;
const TOKEN_TEST = /\{[a-zA-Z]+\}/;

const REQUIRED: Record<Exclude<DutyCopyId, 'night_before'>, readonly (keyof DutyCopyParams)[]> = {
  week_overview: ['list'],
  reask_48h: ['kid', 'event', 'day', 'time'],
  parent_initiated: ['kid', 'event', 'day', 'time'],
  which_kid: ['name', 'kids'],
  both_claimed: ['event', 'day', 'parentA', 'parentB'],
  silent_parent: ['name', 'event', 'day'],
};

function filled(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || /[{}]/.test(trimmed)) return null;
  return trimmed;
}

/** One duty line for the model: what it is for, its facts, and its ask budget. */
export interface DutyLinePlan {
  purpose: string;
  questionAllowed: boolean;
  facts: string[];
}

/**
 * Plan one line. Throws {@link DutyCopyError} when a required fact is missing, so a
 * caller can refuse the send. `parent_initiated` is the owner statement when `name` is
 * set and the nobody-yet question otherwise.
 */
export function dutyLinePlan(id: DutyCopyId, params: DutyCopyParams = {}): DutyLinePlan {
  if (id === 'night_before') {
    throw new DutyCopyError('night_before is composed from facts');
  }
  const owned = id === 'parent_initiated' && filled(params.name) !== null;
  const required: readonly (keyof DutyCopyParams)[] = owned
    ? ['name', 'kid', 'event', 'day', 'time']
    : REQUIRED[id];
  const facts: string[] = [];
  for (const key of required) {
    const value = filled(params[key]);
    if (!value) throw new DutyCopyError(`missing ${key}`);
    if (BANNED.test(value)) throw new DutyCopyError('banned');
    facts.push(value);
  }
  const purpose = owned ? 'duty_owner' : `duty_${id}`;
  const questionAllowed =
    id === 'which_kid' ||
    id === 'both_claimed' ||
    id === 'reask_48h' ||
    (id === 'parent_initiated' && !owned);
  return { purpose, questionAllowed, facts };
}

export interface DutyWeekEntry {
  day: string;
  event: string;
  /** Set only when a parent said who has it. Calendar presence is not enough. */
  name: string | null;
}

/** Week-overview facts: one data item per event, `day event: owner` or `: unassigned`. */
export function dutyWeekFacts(entries: readonly DutyWeekEntry[]): string {
  return entries
    .map((entry) => {
      const day = filled(entry.day);
      const event = filled(entry.event);
      if (!day || !event) throw new DutyCopyError('missing list');
      const name = filled(entry.name);
      return `${day} ${event}: ${name ?? 'unassigned'}`;
    })
    .join('; ');
}

/**
 * `{kids}` for which-kid. Two or more first names, then "or both" / "ou les deux".
 * One name returns null: the caller skips the line.
 */
export function formatDutyKids(
  names: readonly string[],
  language: DutyCopyLanguage,
): string | null {
  const firsts: string[] = [];
  for (const name of names) {
    const first = spokenFirstName(name);
    if (first && !firsts.includes(first)) firsts.push(first);
  }
  if (firsts.length < 2) return null;
  const tail = language === 'fr' ? 'ou les deux' : 'or both';
  return `${firsts.join(', ')}, ${tail}`;
}

/**
 * Given name a parent agreed to (`users.name`), never a phone and never a
 * Google guess. The first word only. Null when there is nothing we may say.
 */
export function spokenFirstName(name: string | null | undefined): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  if ((trimmed.match(/\d/g) ?? []).length >= 7) return null;
  const first = trimmed.split(/\s+/)[0] ?? '';
  if (!/^[A-Za-z][A-Za-z'.-]*$/.test(first)) return null;
  return first;
}

export function dutyWeekdayName(date: Date, timeZone: string, language: DutyCopyLanguage): string {
  const short = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
  const index = SHORT_DAYS.indexOf(short);
  if (index < 0) throw new DutyCopyError('day');
  const label = language === 'fr' ? FR_DAYS[index] : EN_DAYS[index];
  if (!label) throw new DutyCopyError('day');
  return label;
}

/** ASCII clock. English is `3:00pm`. French is 24-hour `15:00`. */
export function dutyClockLabel(date: Date, timeZone: string, language: DutyCopyLanguage): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  let hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = (parts.find((part) => part.type === 'minute')?.value ?? '00').padStart(2, '0');
  if (!Number.isFinite(hour)) throw new DutyCopyError('time');
  if (hour === 24) hour = 0;
  if (language === 'fr') return `${String(hour).padStart(2, '0')}:${minute}`;
  const suffix = hour < 12 ? 'am' : 'pm';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${minute}${suffix}`;
}

/**
 * A finished sentence may leave: no design placeholder, no `{token}`, no
 * booking claim. The locked template is not itself a send.
 */
export function dutyCopyMayLeave(text: string): boolean {
  if (text.includes('TODO-Design')) return false;
  if (TOKEN_TEST.test(text)) return false;
  if (BANNED.test(text)) return false;
  return text.trim().length > 0;
}

/**
 * Append one duty line to a bubble that is already leaving. A placeholder or
 * an unrendered token leaves the bubble unchanged.
 */
export function absorbDutyLine(weekly: string, line: string | null | undefined): string {
  if (!line || line.trim().length === 0) return weekly;
  if (!dutyCopyMayLeave(line)) return weekly;
  return `${weekly.trimEnd()}\n${line.trim()}`;
}

/** Kid-word title only. A child's name alone does not make an adult title speakable. */
export function dutyTitleMayBeSpoken(title: string | null | undefined): boolean {
  const trimmed = title?.trim() ?? '';
  if (!trimmed) return false;
  return classifyKidCalendarItem({ title: trimmed, childNames: [] });
}

/**
 * Facts for the owner echo ("who has it"), for the model to word. Null when a fact is
 * missing, or the event title is not a kid event (that title is not returned).
 */
export function dutyOwnerEcho(
  _language: DutyCopyLanguage,
  params: DutyCopyParams,
): DutyLinePlan | null {
  if (!dutyTitleMayBeSpoken(params.event)) return null;
  if (!filled(params.name)) return null;
  try {
    return dutyLinePlan('parent_initiated', params);
  } catch {
    return null;
  }
}
