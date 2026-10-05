import { classifyKidCalendarItem } from '~/lib/channel/linq/kid-event';

/**
 * The FACTS the duty lane hands the model, and the lock a duty line leaves under.
 *
 * NOTHING HERE IS A SENTENCE (VIL-413 / VIL-417, founder rule 2026-10-04). Until this
 * change this file held nineteen locked templates in two languages — the week overview,
 * the re-ask, the night-before reminder, the owner sentence, the nobody-yet question,
 * the which-kid and both-claimed questions, the silent-parent hand-off and the three
 * week-list items — plus `dutyCopy`, `dutyWeekList`, `formatDutyKids` and `dutyOwnerEcho`
 * that rendered them, and `DUTY_CHANGE_NEXT_*` ("Say so here if that changes."). All of
 * that is gone. Every duty line is now written by the model through the duty-voice skill
 * (line-input.ts, voice.ts); what remains here is what code can honestly supply: a
 * weekday as a word, a clock as a word, the first name a parent agreed to, and whether a
 * calendar title is a kid event at all.
 *
 * A name is filled only from words a parent said, or from the one parent whose
 * calendar holds the event. Callers pass that decision in. This module does
 * not look a name up and does not invent one.
 */

export const COPARENT_DUTY_COPY_LOCKED_ENV = 'COPARENT_DUTY_COPY_LOCKED';

/**
 * The lane's dark flag: strict `true`, so `TRUE` and `true\n` stay unlocked. It once meant
 * "Sloane signed off these strings"; it now means "the duty lane may speak at all", and
 * is checked BEFORE the model is asked, so a dark lane costs no model call.
 */
export function dutyCopyLocked(): boolean {
  return process.env[COPARENT_DUTY_COPY_LOCKED_ENV] === 'true';
}

export type DutyCopyLanguage = 'en' | 'fr';

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

/**
 * The distinct first names a which-kid question may offer, in the household's order.
 * Fewer than two means there is nothing to ask: the caller skips the line.
 */
export function dutyKidChoices(names: readonly string[]): string[] | null {
  const firsts: string[] = [];
  for (const name of names) {
    const first = spokenFirstName(name);
    if (first && !firsts.includes(first)) firsts.push(first);
  }
  return firsts.length < 2 ? null : firsts;
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
 * The last gate before the transport, after the engine's judge: the lane is lit, and
 * the text is a finished sentence — no design placeholder, no `{token}`, no booking
 * claim. A model line that failed the judge never reaches here; this catches a caller
 * that hands the transport something that was never spoken.
 */
export function dutyCopyMayLeave(text: string): boolean {
  if (!dutyCopyLocked()) return false;
  if (text.includes('TODO-Design')) return false;
  if (TOKEN_TEST.test(text)) return false;
  if (BANNED.test(text)) return false;
  return text.trim().length > 0;
}

/**
 * Append one duty bubble to a weekly bubble that is already leaving. A placeholder, an
 * unrendered token, or an unlit lane leaves the weekly bubble unchanged.
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
