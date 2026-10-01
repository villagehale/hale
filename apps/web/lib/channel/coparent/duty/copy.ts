import { classifyKidCalendarItem } from '~/lib/channel/linq/kid-event';

/**
 * Parent-facing lines for duty asks. Sloane locked these strings (VIL-382).
 *
 * French is ASCII. A line may leave only when {@link dutyCopyLocked} is exactly
 * `true` and the text has no leftover `{token}`. The sends flag is the
 * caller's other gate. Flags stay off here.
 *
 * A name is filled only from words a parent said, or from the one parent whose
 * calendar holds the event. Callers pass that decision in. This module does
 * not look a name up and does not invent one.
 */

export const COPARENT_DUTY_COPY_LOCKED_ENV = 'COPARENT_DUTY_COPY_LOCKED';

/** Strict `true`. `TRUE` and `true\n` stay unlocked. */
export function dutyCopyLocked(): boolean {
  return process.env[COPARENT_DUTY_COPY_LOCKED_ENV] === 'true';
}

export const DUTY_WHICH_KID_COPY = '{name}, got it. Which kid is that for: {kids}?';
export const DUTY_WHICH_KID_COPY_FR = "{name}, note. C'est pour quel enfant: {kids}?";

export const DUTY_BOTH_CLAIMED_COPY =
  "You both said you've got {event}, {day}. Who's taking it, {parentA} or {parentB}?";
export const DUTY_BOTH_CLAIMED_COPY_FR =
  "Vous avez dit tous les deux que vous vous en occupez pour {event}, {day}. C'est {parentA} ou {parentB}?";

export const DUTY_WEEK_OVERVIEW_COPY_EN = 'Who has what this week: {list}.';
export const DUTY_WEEK_OVERVIEW_COPY_FR = "Qui s'occupe de quoi cette semaine: {list}.";

export const DUTY_REASK_COPY_EN =
  "Still nobody on {kid}'s {event}, {day} at {time}. Who's taking it?";
export const DUTY_REASK_COPY_FR =
  "Toujours personne pour s'occuper de {event} pour {kid}, {day} a {time}. Qui le prend?";

export const DUTY_NIGHT_BEFORE_COPY_EN =
  "Tomorrow: {name} has {kid}'s {event} at {time}. Say so here if that changes.";
export const DUTY_NIGHT_BEFORE_COPY_FR =
  "Demain: {name} s'occupe de {event} pour {kid} a {time}. Dites-le ici si ca change.";

export const DUTY_PARENT_OWNED_COPY_EN = "{name} has {kid}'s {event}, {day} at {time}.";
export const DUTY_PARENT_OWNED_COPY_FR = "{name} s'occupe de {event} pour {kid}, {day} a {time}.";

export const DUTY_PARENT_ASK_COPY_EN =
  "Nobody has {kid}'s {event}, {day} at {time} yet. Who's taking it?";
export const DUTY_PARENT_ASK_COPY_FR =
  "Personne ne s'occupe encore de {event} pour {kid}, {day} a {time}. Qui le prend?";

export const DUTY_SILENT_PARENT_COPY_EN = '{name}, over to you on {event}, {day}.';
export const DUTY_SILENT_PARENT_COPY_FR = '{name}, a toi de nous dire pour {event}, {day}.';

/** Owned week-list item. Unowned tails live in {@link dutyWeekList}. */
export const DUTY_WEEK_OWNED_ITEM = '{day} {event} ({name})';
export const DUTY_WEEK_UNOWNED_ITEM_EN = '{day} {event} (nobody yet)';
export const DUTY_WEEK_UNOWNED_ITEM_FR = "{day} {event} (personne pour l'instant)";

export const DUTY_COPY_TEMPLATES = [
  DUTY_WHICH_KID_COPY,
  DUTY_WHICH_KID_COPY_FR,
  DUTY_BOTH_CLAIMED_COPY,
  DUTY_BOTH_CLAIMED_COPY_FR,
  DUTY_WEEK_OVERVIEW_COPY_EN,
  DUTY_WEEK_OVERVIEW_COPY_FR,
  DUTY_REASK_COPY_EN,
  DUTY_REASK_COPY_FR,
  DUTY_NIGHT_BEFORE_COPY_EN,
  DUTY_NIGHT_BEFORE_COPY_FR,
  DUTY_PARENT_OWNED_COPY_EN,
  DUTY_PARENT_OWNED_COPY_FR,
  DUTY_PARENT_ASK_COPY_EN,
  DUTY_PARENT_ASK_COPY_FR,
  DUTY_SILENT_PARENT_COPY_EN,
  DUTY_SILENT_PARENT_COPY_FR,
  DUTY_WEEK_OWNED_ITEM,
  DUTY_WEEK_UNOWNED_ITEM_EN,
  DUTY_WEEK_UNOWNED_ITEM_FR,
] as const;

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

const SIMPLE: Record<Exclude<DutyCopyId, 'parent_initiated'>, { en: string; fr: string }> = {
  week_overview: { en: DUTY_WEEK_OVERVIEW_COPY_EN, fr: DUTY_WEEK_OVERVIEW_COPY_FR },
  reask_48h: { en: DUTY_REASK_COPY_EN, fr: DUTY_REASK_COPY_FR },
  night_before: { en: DUTY_NIGHT_BEFORE_COPY_EN, fr: DUTY_NIGHT_BEFORE_COPY_FR },
  which_kid: { en: DUTY_WHICH_KID_COPY, fr: DUTY_WHICH_KID_COPY_FR },
  both_claimed: { en: DUTY_BOTH_CLAIMED_COPY, fr: DUTY_BOTH_CLAIMED_COPY_FR },
  silent_parent: { en: DUTY_SILENT_PARENT_COPY_EN, fr: DUTY_SILENT_PARENT_COPY_FR },
};

const REQUIRED: Record<DutyCopyId, readonly (keyof DutyCopyParams)[]> = {
  week_overview: ['list'],
  reask_48h: ['kid', 'event', 'day', 'time'],
  night_before: ['name', 'kid', 'event', 'time'],
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

function renderTemplate(
  template: string,
  params: DutyCopyParams,
  required: readonly (keyof DutyCopyParams)[],
  language: DutyCopyLanguage,
): string {
  const bag = new Map<string, string>();
  for (const key of required) {
    const value = filled(params[key]);
    if (!value) throw new DutyCopyError(`missing ${key}`);
    bag.set(key, value);
  }
  if (filled(params.name)) bag.set('name', filled(params.name) as string);
  const rendered = template.replace(/\{([a-zA-Z]+)\}/g, (_match, key: string) => {
    const value = bag.get(key);
    if (!value) throw new DutyCopyError(`missing ${key}`);
    return value;
  });
  if (TOKEN_TEST.test(rendered)) throw new DutyCopyError('unrendered');
  if (language === 'fr' && [...rendered].some((char) => char.charCodeAt(0) > 0x7f)) {
    throw new DutyCopyError('fr_not_ascii');
  }
  if (BANNED.test(rendered)) throw new DutyCopyError('banned');
  return rendered;
}

/**
 * Render one locked line. Throws {@link DutyCopyError} when a required token
 * is missing, so a caller can refuse the send. Never returns a literal `{…}`.
 * `parent_initiated` uses the owner sentence when `name` is set and the
 * nobody-yet question otherwise.
 */
export function dutyCopy(
  id: DutyCopyId,
  language: DutyCopyLanguage,
  params: DutyCopyParams = {},
): string {
  if (id === 'parent_initiated' && filled(params.name)) {
    return renderTemplate(
      language === 'fr' ? DUTY_PARENT_OWNED_COPY_FR : DUTY_PARENT_OWNED_COPY_EN,
      params,
      ['name', 'kid', 'event', 'day', 'time'],
      language,
    );
  }
  const template = id === 'parent_initiated' ? null : SIMPLE[id][language];
  const sentence =
    template ?? (language === 'fr' ? DUTY_PARENT_ASK_COPY_FR : DUTY_PARENT_ASK_COPY_EN);
  return renderTemplate(sentence, params, REQUIRED[id], language);
}

export interface DutyWeekEntry {
  day: string;
  event: string;
  /** Set only when a parent said who has it. Calendar presence is not enough. */
  name: string | null;
}

/** `{list}` items joined by `; `. */
export function dutyWeekList(
  language: DutyCopyLanguage,
  entries: readonly DutyWeekEntry[],
): string {
  return entries
    .map((entry) => {
      const day = filled(entry.day);
      const event = filled(entry.event);
      if (!day || !event) throw new DutyCopyError('missing list');
      const name = filled(entry.name);
      const template = name
        ? DUTY_WEEK_OWNED_ITEM
        : language === 'fr'
          ? DUTY_WEEK_UNOWNED_ITEM_FR
          : DUTY_WEEK_UNOWNED_ITEM_EN;
      return renderTemplate(
        template,
        { day, event, name },
        name ? ['day', 'event', 'name'] : ['day', 'event'],
        language,
      );
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
 * A line may leave only when Sloane's lock is exactly on and the text is a
 * finished sentence: no design placeholder, no `{token}`, no booking claim.
 */
export function dutyCopyMayLeave(text: string): boolean {
  if (!dutyCopyLocked()) return false;
  if (text.includes('TODO-Design')) return false;
  if (TOKEN_TEST.test(text)) return false;
  if (BANNED.test(text)) return false;
  return text.trim().length > 0;
}

/**
 * Append one duty line to a bubble that is already leaving. A placeholder, an
 * unrendered token, or an unlocked copy flag leaves the bubble unchanged.
 */
export function absorbDutyLine(weekly: string, line: string | null | undefined): string {
  if (!line || line.trim().length === 0) return weekly;
  if (!dutyCopyMayLeave(line)) return weekly;
  return `${weekly.trimEnd()}\n${line.trim()}`;
}

/**
 * The second sentence of the locked night-before line. Appended so a duty
 * echo ends on one next step. Not a new sentence: both night-before
 * templates already end with these words.
 */
export const DUTY_CHANGE_NEXT_EN = 'Say so here if that changes.';
export const DUTY_CHANGE_NEXT_FR = 'Dites-le ici si ca change.';

/**
 * TODO-Design — not locked. These must not leave. The memory flag does not
 * unlock them. `dutyCopyMayLeave` rejects the marker. Listed for Design in
 * the VIL-383 PR. No counts, no event titles, no STOP wording.
 */
export const DUTY_UNDO_TEXT_TODO = 'TODO-Design: Done. Say so here if that is wrong.';
export const DUTY_BURDEN_ANSWER_TODO =
  'TODO-Design: I can answer that in words once this line is locked. Want me to keep the counts internal?';
export const DUTY_DEFAULT_OWNER_TODO =
  'TODO-Design: Want this as the usual plan? Say yes or no.';
export const DUTY_LOPSIDED_CONSENT_TODO =
  'TODO-Design: Want me to keep an eye on keeping things balanced? Say yes or no.';
export const DUTY_LOPSIDED_NUDGE_TODO = 'TODO-Design: Want the open one? Say yes or no.';

export const DUTY_PLACEHOLDER_COPY = [
  DUTY_UNDO_TEXT_TODO,
  DUTY_BURDEN_ANSWER_TODO,
  DUTY_DEFAULT_OWNER_TODO,
  DUTY_LOPSIDED_CONSENT_TODO,
  DUTY_LOPSIDED_NUDGE_TODO,
] as const;

/** Kid-word title only. A child's name alone does not make an adult title speakable. */
export function dutyTitleMayBeSpoken(title: string | null | undefined): boolean {
  const trimmed = title?.trim() ?? '';
  if (!trimmed) return false;
  return classifyKidCalendarItem({ title: trimmed, childNames: [] });
}

/**
 * One line: the locked owner sentence, then the locked "say so if that
 * changes" next step. Null when copy is unlocked, a token is missing, or
 * the event title is not a kid event (that title is not returned).
 */
export function dutyOwnerEcho(
  language: DutyCopyLanguage,
  params: DutyCopyParams,
): string | null {
  if (!dutyTitleMayBeSpoken(params.event)) return null;
  if (!DUTY_NIGHT_BEFORE_COPY_EN.endsWith(DUTY_CHANGE_NEXT_EN)) return null;
  if (!DUTY_NIGHT_BEFORE_COPY_FR.endsWith(DUTY_CHANGE_NEXT_FR)) return null;
  let owner: string;
  try {
    owner = dutyCopy('parent_initiated', language, params);
  } catch {
    return null;
  }
  if (!filled(params.name)) return null;
  const next = language === 'fr' ? DUTY_CHANGE_NEXT_FR : DUTY_CHANGE_NEXT_EN;
  const line = `${owner} ${next}`;
  if (line.includes('\n') || !dutyCopyMayLeave(line)) return null;
  return line;
}
