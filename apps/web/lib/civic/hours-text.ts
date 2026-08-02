/**
 * VIL-252 · M16 · Tier ② — reading a schedule out of free text, deterministically.
 *
 * THE FAILURE THIS MODULE EXISTS TO PREVENT is a wrong time. A parent who packs a
 * toddler, a snack and a stroller and arrives on the wrong morning is worse off
 * than a parent Hale never told about the centre at all. So every function here
 * fails CLOSED: an input it cannot fully account for yields `null`, never a
 * best-effort partial that reads like a complete answer.
 *
 * Two jobs, both pure:
 *
 *   parseHoursStrict — the fast path. Toronto's open-data hours strings follow a
 *     regular shape ("Monday: 9:00 a.m. - noon  ; 2:00 p.m. - 4:00 p.m.  | Tuesday:
 *     ..."), and where that shape holds there is no reason to ask a model: the
 *     deterministic read is exact, free and instant. It returns null the moment
 *     anything does not fit, which is the signal to fall back to the LLM parse.
 *
 *   corroborateSlot — the gate on that fallback. Whatever a model proposes is
 *     checked back against the source text: the day must be vouched for, and the
 *     two times must appear as an adjacent start/end pair. Anything else is
 *     rejected outright — an invented time, and equally a real pair of times the
 *     source never paired. This is what makes a hallucinated storytime hour
 *     structurally unable to reach a parent, rather than something a prompt
 *     politely asks the model to avoid.
 */

/** 0 = Sunday, matching civic_sessions.day_of_week and JS getDay(). */
const DAY_NUMBERS: Readonly<Record<string, number>> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

export interface WeeklySlot {
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
}

/**
 * Whether a proposed slot is backed by the source text. Deliberately BINARY.
 *
 * An earlier draft had a middle "both times are in this day, but not as a pair"
 * tier. That tier described exactly one real situation — the model merged two
 * ranges into one span — and merging is not partial knowledge, it is a wrong
 * time: it claims a centre running 10:00–noon and 3:30–6:00 is open straight
 * through to six. There is no reading of that a parent benefits from, so there is
 * no grade between corroborated and not.
 */
export type Corroboration = 'exact' | 'none';

const TIME_TOKEN = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?|noon|midnight/gi;

/**
 * Minutes from local midnight for one time token, or null when the token does not
 * state a time unambiguously. A bare "9:30" is REFUSED rather than assumed to be
 * morning — a centre that opens at 9:30 p.m. is unlikely, but a parser that
 * guesses is a parser that will eventually guess wrong somewhere that matters.
 */
export function timeTokenMinutes(token: string): number | null {
  const text = token.trim().toLowerCase();
  if (text === 'noon') return 12 * 60;
  if (text === 'midnight') return 0;

  const match = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?$/.exec(text);
  if (match === null) return null;

  const hour12 = Number(match[1]);
  const minutes = match[2] === undefined ? 0 : Number(match[2]);
  if (Number.isNaN(hour12) || Number.isNaN(minutes)) return null;
  if (hour12 < 1 || hour12 > 12 || minutes > 59) return null;

  // 12 a.m. is 00:xx and 12 p.m. is 12:xx — the one hour where the modulo matters.
  const base = (hour12 % 12) * 60 + minutes;
  return match[3] === 'p' ? base + 12 * 60 : base;
}

/** Every time token in a string, in the order it appears, as minutes. A token
 * that does not resolve is kept as null so pair ALIGNMENT is never silently
 * shifted by dropping it. */
function timeSequence(text: string): Array<number | null> {
  return [...text.matchAll(TIME_TOKEN)].map((m) => timeTokenMinutes(m[0]));
}

const DAY_WORD = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/gi;

/**
 * Every weekday the text actually vouches for — named outright, or covered by a
 * range it writes out ("Monday to Thursday", "Tuesday–Friday").
 *
 * Ranges matter because real centre pages use them constantly ("Monday to
 * Thursday 9:00 am — 2:00 pm" is verbatim from a Toronto EarlyON provider). A
 * corroborator that only accepted literal day names would reject Tuesday and
 * Wednesday there — rejecting the true reading, which is just as much a failure
 * as accepting a false one, because it would silently empty the fallback path.
 */
export function supportedDays(text: string): Set<number> {
  const days = new Set<number>();
  const lower = text.toLowerCase();

  for (const match of lower.matchAll(DAY_WORD)) {
    const day = DAY_NUMBERS[match[1] ?? ''];
    if (day !== undefined) days.add(day);
  }

  // "monday to thursday" / "tuesday - friday" / "monday through friday"
  const range = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\s*(?:to|through|until|[-–—])\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/gi;
  for (const match of lower.matchAll(range)) {
    const from = DAY_NUMBERS[match[1] ?? ''];
    const to = DAY_NUMBERS[match[2] ?? ''];
    if (from === undefined || to === undefined) continue;
    for (let d = from; ; d = (d + 1) % 7) {
      days.add(d);
      if (d === to) break;
    }
  }
  return days;
}

/** Split "Monday: … | Tuesday: …" into per-day segments. Days the text does not
 * name simply do not appear. */
function daySegments(text: string): Array<{ dayOfWeek: number; body: string }> {
  const segments: Array<{ dayOfWeek: number; body: string }> = [];
  for (const chunk of text.split('|')) {
    const match = /^\s*([A-Za-z]+)\s*:\s*(.*)$/s.exec(chunk);
    if (match === null) continue;
    const dayOfWeek = DAY_NUMBERS[(match[1] ?? '').trim().toLowerCase()];
    if (dayOfWeek === undefined) continue;
    segments.push({ dayOfWeek, body: match[2] ?? '' });
  }
  return segments;
}

/**
 * Read a well-formed municipal hours string exactly, or return null.
 *
 * Null means "this needs the model", not "there are no hours" — the caller falls
 * back to the LLM parse. Every day named must resolve, every range within it must
 * yield a start and an end, and every end must follow its start; one violation
 * anywhere rejects the WHOLE string, because a partially-understood schedule is
 * indistinguishable from a complete one once it is stored.
 */
export function parseHoursStrict(text: string): WeeklySlot[] | null {
  if (text.trim().length === 0) return null;

  const chunks = text.split('|');
  const segments = daySegments(text);
  // Every chunk must have been a day segment; a chunk we skipped is text we did
  // not understand.
  if (segments.length === 0 || segments.length !== chunks.length) return null;

  const slots: WeeklySlot[] = [];
  for (const segment of segments) {
    for (const range of segment.body.split(';')) {
      if (range.trim().length === 0) return null;
      const times = timeSequence(range);
      if (times.length !== 2) return null;
      const [start, end] = times;
      if (start === null || start === undefined) return null;
      if (end === null || end === undefined) return null;
      if (end <= start) return null;
      slots.push({ dayOfWeek: segment.dayOfWeek, startMinute: start, endMinute: end });
    }
  }

  // Upstream repeats a day's ranges verbatim in some records (Agincourt lists
  // Wednesday's two ranges twice). The same slot twice is one drop-in, not two.
  return dedupeSlots(slots);
}

/** Identical (day, start, end) triples collapse; order is preserved. */
export function dedupeSlots(slots: readonly WeeklySlot[]): WeeklySlot[] {
  const seen = new Set<string>();
  const out: WeeklySlot[] = [];
  for (const slot of slots) {
    const key = `${slot.dayOfWeek}:${slot.startMinute}:${slot.endMinute}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(slot);
  }
  return out;
}

/**
 * Check a proposed slot against the text it was supposedly read from.
 *
 *   'exact' — the day is vouched for by the text AND the two times occur in it as
 *             an ADJACENT start/end pair. Ranges are written "start - end", so the
 *             real pairs are the even-aligned neighbours; requiring that alignment
 *             is what rejects a slot stitched together from two separate ranges.
 *   'none'  — anything else: the day is absent, a time does not occur, or the two
 *             times are real but were never a pair. Nothing may surface this.
 *
 * The time check is scoped as tightly as the text allows. Municipal strings label
 * each day ("Monday: … | Tuesday: …"), so a slot is checked against ITS day's
 * segment only — that is what stops Tuesday borrowing Monday's hours. Free prose
 * has no such structure, so the check falls back to the whole text; the pair
 * alignment still holds, and the day still has to be vouched for.
 */
export function corroborateSlot(sourceText: string, slot: WeeklySlot): Corroboration {
  if (!supportedDays(sourceText).has(slot.dayOfWeek)) return 'none';

  const segment = daySegments(sourceText).find((s) => s.dayOfWeek === slot.dayOfWeek);
  const scope = segment?.body ?? sourceText;

  const times = timeSequence(scope);
  for (let i = 0; i + 1 < times.length; i += 2) {
    const start = times[i];
    const end = times[i + 1];
    if (start === slot.startMinute && end === slot.endMinute) return 'exact';
  }
  return 'none';
}
