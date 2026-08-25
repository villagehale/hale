// Mirrors apps/web/lib/channel/activity/quote-match.ts, which sits behind the web app's
// `~/` alias the tsx loader here cannot resolve.
//
// ONE MIRROR, THREE RUNNERS. The synthesis eval asks "is this quote on that page" and the
// finder and deep evals ask "does that page publish a schedule at all" — two questions
// over one tokeniser. Copying the tokeniser into each runner would be three replicas free
// to drift from each other as well as from production, which is the failure mode a replica
// already has one of.
//
// WHY IT IS NOT A SUBSTRING CHECK. A page prints a schedule as table cells —
// `Parent and Tot 1 | Mon | 10:00AM - 10:30AM | Oct 05 - Dec 07 | 108969` — and no model
// quoting that writes it back with the pipes in. Verbatim matching does not refuse
// fabrication there, it refuses TABLES: live on 2026-08-24 it refused fifty-three
// published facts in one run. So a quote is backed when the page prints it VERBATIM (tried
// first, so nothing that passed before can start failing) or when every LOAD-BEARING token
// in it appears on the page IN ORDER inside one short window.

/** How far apart a fact's tokens may sit and still be one fact. Measured, not guessed:
 * against the real page every TRUE fact spanned 24-50 characters and the tightest FALSE
 * one 147. */
export const ANCHOR_WINDOW_CHARS = 120;

/** One token is never enough — a lone `$86.22` is a fact about the page, not about this
 * programme. Two, one of them distinctive, is the floor. */
export const MIN_ANCHORS = 2;

const DAYS = new Map([
  ['sunday', 'sun'],
  ['sun', 'sun'],
  ['monday', 'mon'],
  ['mon', 'mon'],
  ['tuesday', 'tue'],
  ['tue', 'tue'],
  ['tues', 'tue'],
  ['wednesday', 'wed'],
  ['wed', 'wed'],
  ['thursday', 'thu'],
  ['thu', 'thu'],
  ['thurs', 'thu'],
  ['friday', 'fri'],
  ['fri', 'fri'],
  ['saturday', 'sat'],
  ['sat', 'sat'],
]);

const MONTHS = new Map([
  ['jan', 'jan'],
  ['january', 'jan'],
  ['feb', 'feb'],
  ['february', 'feb'],
  ['mar', 'mar'],
  ['march', 'mar'],
  ['apr', 'apr'],
  ['april', 'apr'],
  ['may', 'may'],
  ['jun', 'jun'],
  ['june', 'jun'],
  ['jul', 'jul'],
  ['july', 'jul'],
  ['aug', 'aug'],
  ['august', 'aug'],
  ['sep', 'sep'],
  ['sept', 'sep'],
  ['september', 'sep'],
  ['oct', 'oct'],
  ['october', 'oct'],
  ['nov', 'nov'],
  ['november', 'nov'],
  ['dec', 'dec'],
  ['december', 'dec'],
]);

/** Mirrors `plainText`'s unicode folding (coach/reply.ts) — the mapping `normaliseForMatch`
 * inherits by calling it. */
const GSM7_SUBSTITUTIONS = [
  [/[‘’‛]/g, "'"],
  [/[“”]/g, '"'],
  [/[–—―]/g, '-'],
  [/…/g, '...'],
  [/[\u00a0\u2007\u202f\u2009]/g, ' '],
];

/**
 * Text identity, forgiven for the things a page renders and a model retypes — mirrors
 * `normaliseForMatch`.
 *
 * The meridiem fold is the part that is not `plainText`: `7 a.m.`, `7 A.M.` and `7am` are
 * one clock time written three ways, and a page and a model rarely pick the same one. Both
 * boundaries are guarded, or `extra. my` folds into `extram y`.
 */
export function normaliseForMatch(text) {
  let out = String(text);
  for (const [pattern, replacement] of GSM7_SUBSTITUTIONS) out = out.replace(pattern, replacement);
  return out
    .toLowerCase()
    .replace(/\b([ap])\.\s?m\.?(?![a-z])/g, '$1m')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Money, clock times, numbers and words — in that order, because the longest reading of a
 * run of characters is the right one. `$86.22` is one token, not three. */
const SCAN =
  /\$\s?\d[\d,]*(?:\.\d+)?|\d{1,2}:\d{2}\s?(?:am|pm)?|\d{1,2}\s?(?:am|pm)\b|\d[\d,]*(?:\.\d+)?|[a-z]+/g;

/** A month beside a number is a DATE, not two tokens. Bounded rather than exact so
 * `oct 05`, `oct. 5` and `5 october` all read the same. */
const ADJACENT_CHARS = 3;

function dayValue(word) {
  return DAYS.get(word) ?? (word.endsWith('s') ? DAYS.get(word.slice(0, -1)) : undefined);
}

function dayOfMonth(raw) {
  const digits = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(raw);
  if (!digits) return null;
  const value = Number(digits[1]);
  return value >= 1 && value <= 31 ? value : null;
}

/** Every load-bearing token in a normalised string, in the order it appears. */
function readAnchors(normalised) {
  const lexed = [...normalised.matchAll(SCAN)].map((match) => ({
    raw: match[0],
    at: match.index,
    end: match.index + match[0].length,
  }));

  const anchors = [];
  for (let index = 0; index < lexed.length; index += 1) {
    const token = lexed[index];
    if (!token) continue;
    const { raw, at, end } = token;
    const next = lexed[index + 1];
    const adjacent = next !== undefined && next.at - end <= ADJACENT_CHARS;

    if (raw.startsWith('$')) {
      anchors.push({ kind: 'money', value: raw.replace(/[\s,]/g, ''), meridiem: null, at, end });
      continue;
    }

    const clock = /^(\d{1,2}):(\d{2})\s?(am|pm)?$/.exec(raw);
    if (clock) {
      anchors.push({
        kind: 'time',
        value: `${Number(clock[1])}:${clock[2]}`,
        meridiem: clock[3] === undefined ? null : clock[3][0],
        at,
        end,
      });
      continue;
    }

    const hour = /^(\d{1,2})\s?(am|pm)$/.exec(raw);
    if (hour) {
      anchors.push({ kind: 'time', value: `${Number(hour[1])}:00`, meridiem: hour[2][0], at, end });
      continue;
    }

    if (/^\d/.test(raw)) {
      const day = dayOfMonth(raw);
      const month = adjacent && next ? MONTHS.get(next.raw) : undefined;
      if (day !== null && month !== undefined && next) {
        anchors.push({ kind: 'date', value: `${month}-${day}`, meridiem: null, at, end: next.end });
        index += 1;
        continue;
      }
      const digits = String(Number(raw.replace(/,/g, '')));
      anchors.push({
        kind: digits.length >= 4 ? 'code' : 'number',
        value: digits,
        meridiem: null,
        at,
        end,
      });
      continue;
    }

    const month = MONTHS.get(raw);
    if (month !== undefined) {
      const day = adjacent && next ? dayOfMonth(next.raw) : null;
      if (day !== null && next) {
        anchors.push({ kind: 'date', value: `${month}-${day}`, meridiem: null, at, end: next.end });
        index += 1;
      }
      // A bare month name is a season, not a date, and every fall page is full of them.
      continue;
    }

    const day = dayValue(raw);
    if (day !== undefined) anchors.push({ kind: 'day', value: day, meridiem: null, at, end });
  }
  return anchors;
}

/** Tokenise a page once — a run checks ninety facts against it. */
export function preparePage(text) {
  const normalised = normaliseForMatch(text);
  return { text: normalised, anchors: readAnchors(normalised) };
}

/** A token that could only be about this one thing. A day name and a bare number are true
 * of half the page; a fee, a clock time, a date and a session code are not. */
function isDistinctive(anchor) {
  return (
    anchor.kind === 'money' ||
    anchor.kind === 'time' ||
    anchor.kind === 'date' ||
    anchor.kind === 'code'
  );
}

/** A quote that named a meridiem must find it; a quote that wrote a bare `10:00` is
 * satisfied by the page's `10:00am`, which is the page supplying detail the quote left off. */
function satisfies(wanted, found) {
  if (wanted.kind !== found.kind || wanted.value !== found.value) return false;
  return wanted.kind !== 'time' || wanted.meridiem === null || wanted.meridiem === found.meridiem;
}

/** Are all of the quote's tokens on the page, in this order, inside one window? */
function anchorsAreOnPage(wanted, page) {
  const first = wanted[0];
  if (!first) return false;
  const found = page.anchors;
  for (let start = 0; start < found.length; start += 1) {
    const head = found[start];
    if (!head || !satisfies(first, head)) continue;
    let matched = 1;
    for (let cursor = start + 1; cursor < found.length; cursor += 1) {
      const candidate = found[cursor];
      if (!candidate) break;
      if (candidate.end - head.at > ANCHOR_WINDOW_CHARS) break;
      const target = wanted[matched];
      if (target && satisfies(target, candidate)) matched += 1;
      if (matched === wanted.length) return true;
    }
    if (matched === wanted.length) return true;
  }
  return false;
}

/**
 * Is this quote backed by this page? — mirrors `quoteIsBackedBy`.
 *
 * VERBATIM FIRST, always. The token pass is a SECOND chance for the quotes a verbatim
 * check cannot express, never a relaxation of the first.
 */
export function quoteIsBackedBy(quote, page) {
  const needle = normaliseForMatch(quote);
  if (needle === '') return false;
  if (page.text.includes(needle)) return true;

  const wanted = readAnchors(needle);
  if (wanted.length < MIN_ANCHORS) return false;
  if (!wanted.some(isDistinctive)) return false;
  return anchorsAreOnPage(wanted, page);
}

/**
 * Does this page publish a schedule at all? — mirrors `pageCarriesSchedule`, the positive
 * evidence an absence claim needs.
 *
 * A CLOCK TIME OR A PRICE, and deliberately not a session code: a page carrying nothing
 * but a phone number tokenises a four-digit code out of it, and a signal that fires on
 * every page with a phone number would make the honest "not posted yet" unsayable forever.
 */
export function pageCarriesSchedule(page) {
  return page.anchors.some((anchor) => anchor.kind === 'money' || anchor.kind === 'time');
}

/**
 * Does this sentence actually STATE a schedule fact, or only talk about one? — mirrors
 * `statesAFigure`.
 *
 * "Sundays 9:30-10:15" states one. "$124 per term" states one. "Fees set by Council each
 * year, published in the current Recreation Guide" is a sentence about where a price lives,
 * offered where a price should be — and a lane that reads it as an answer hands a parent a
 * non-answer and writes down no promise to go back for the real one (deliver.ts
 * `carriesFact`).
 *
 * A DAY COUNTS, unlike in {@link pageCarriesSchedule}. The two questions are different:
 * there, "does this whole page publish a schedule" must not fire on the day-of-week in a
 * building's opening hours; here the field is already claiming to BE the `when` of a class,
 * so "Sundays" is a real if partial answer to it.
 */
export function statesAFigure(field) {
  return readAnchors(normaliseForMatch(field)).some(
    (anchor) => anchor.kind !== 'number' && anchor.kind !== 'code',
  );
}

/**
 * FREE IS A PRICE — a complete one, and the answer to the question. Mirrors `statesNoCost`.
 *
 * {@link statesAFigure} asks for a figure and a free drop-in has none. Requiring one moved
 * six of this corpus's twenty-six distinct top picks and five of them were free drop-ins: a
 * parent told "it's free" has everything they need, and minting a watch to go back for the
 * fee they already have is Hale promising to answer a question nobody asked. Only ever
 * consulted for a PRICE, because "free" in a `when` is a description of the session, not a
 * time.
 */
const NO_COST = /\bfree\b|\bno charge\b|\bno cost\b|\bno fee\b|\bcomplimentary\b/i;

export function statesNoCost(field) {
  return NO_COST.test(field);
}
