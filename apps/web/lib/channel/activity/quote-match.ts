import { plainText } from '~/lib/channel/coach/reply';

/**
 * IS THIS FACT ON THAT PAGE — asked in a way a TABLE can answer.
 *
 * THE FAILURE THIS EXISTS FOR. 2026-08-24, live, the real subject. The synthesis came back
 * with twenty-seven true rows off the Halton Hills swim-lessons page — day, clock time,
 * session code and fee, every one of them published. The refutation refused all fifty-three
 * facts as `quote_absent`, the composer was handed a row with nothing on it, and the parent
 * was told "no day, time or price on the fall page yet" while the grid sat on the page Hale
 * had just read. Nothing was fabricated and nothing was wrong except the CHECK.
 *
 * WHY A VERBATIM SPAN CANNOT CHECK A GRID. The page prints a schedule as table cells:
 *
 *     Parent and Tot 1, 2, 3 | Mon | 10:00AM - 10:30AM | Oct 05 - Dec 07 | 108969
 *
 * and no model quoting that writes it back with the pipes in. It writes the row as a
 * sentence — "Mondays 10:00-10:30AM, Oct 05 - Dec 07 (code 108969)" — which is a faithful
 * reading of the cells and not a substring of anything. The fee is worse: the page carries
 * "P&T to Swimmer 3: $86.22 for 9 lessons (30 minute lesson)" under a heading two hundred
 * characters earlier reading "Halton Hills Taxpayer Fees:", and the honest quote for that
 * fact composes the two. A verbatim check does not refuse fabrication here; it refuses
 * TABLES, and it refuses them silently and completely.
 *
 * WHAT REPLACES IT. A quote is backed when it is on the page VERBATIM — unchanged, and
 * still the first thing tried, so nothing that passed before can start failing — or when
 * every LOAD-BEARING TOKEN in it appears on that page, IN THE SAME ORDER, inside one short
 * window. Load-bearing means the things a parent would be hurt by getting wrong: money,
 * clock times, calendar dates, session codes, day names, and the bare numbers beside them.
 * The prose between them is not checked, because the prose is the part the model is
 * entitled to rewrite.
 *
 * THE ORDER AND THE WINDOW ARE THE STRICTNESS, and they were measured rather than guessed.
 * Against the real 70,365-character page (2026-08-24):
 *
 *   every TRUE fact              span 24 to 50 characters   (a table row, or a fee line)
 *   $310 that is on no page      no match at all
 *   an AM quoted as PM           no match at all
 *   a session code swapped       no match at all
 *   a time from a different row  span 11,353 characters
 *   a fee borrowing the duration
 *     from the line above it     span 147 characters
 *
 * {@link ANCHOR_WINDOW_CHARS} is set between the two — well past the widest true row and
 * short of the tightest thing that lies. A fabricated composite can only pass by borrowing
 * every one of its numbers from one short stretch of the page, in the order it printed
 * them, which is most of the way to being true.
 *
 * IT IS DETERMINISTIC AND IT COSTS NOTHING, which is what lets the check run against the
 * WHOLE page rather than against the bounded copy the merge was given (fanout.ts). That
 * asymmetry was the other half of the same failure: the grid began at character 27,153 and
 * the merge's snapshot stopped at 24,000, so the checker was refusing facts for not being
 * in bytes it had thrown away.
 */

/**
 * How far apart a fact's tokens may sit and still be one fact.
 *
 * See the module note for the measurement. 120 characters is 2.4x the widest true span
 * observed (a six-token grid row at 50) and comfortably inside the tightest false one
 * (147, a fee that borrowed "(30 minute lesson)" off the line above it). A page is free to
 * print the same numbers elsewhere; what it cannot do is print them all, in this order,
 * this close together, by accident.
 */
export const ANCHOR_WINDOW_CHARS = 120;

/**
 * The fewest tokens that can carry a claim.
 *
 * One is never enough — a lone "$86.22" on a fee page is a fact about the page and not
 * about this programme, and a lone day name is not a fact at all. Two, with at least one
 * of them {@link isDistinctive}, is the floor at which "these tokens, in this order, this
 * close" starts to mean something. A quote with nothing countable in it (`a sentence that
 * is nowhere on that page`) yields no tokens and is refused outright, which is right: there
 * is nothing in it a checker could stand on.
 */
export const MIN_ANCHORS = 2;

type AnchorKind = 'money' | 'time' | 'date' | 'code' | 'number' | 'day';

interface Anchor {
  kind: AnchorKind;
  /** The canonical form. Two spellings of one fact share it; two facts never do. */
  value: string;
  /** Only ever set on a `time`. Null means the quote wrote a bare clock time, which a page
   * writing `10:00am` still satisfies — but a quote that DID say pm is not satisfied by a
   * page that says am. */
  meridiem: 'a' | 'p' | null;
  at: number;
  end: number;
}

/** A page, tokenised once. Built per page rather than per fact because the fan-out reads
 * seventy thousand characters and a run checks ninety-odd facts against them. */
export interface PageEvidence {
  text: string;
  anchors: readonly Anchor[];
}

const DAYS = new Map<string, string>([
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

const MONTHS = new Map<string, string>([
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

/**
 * Text identity, forgiven for the things a page renders and a model retypes.
 *
 * Whitespace collapses because an HTML table cell arrives as three spaces here and a
 * newline there; typographic punctuation folds to ASCII because a page's en dash comes back
 * as a hyphen through half the fetch pipeline. `plainText` already owns that second mapping
 * for the SMS budget, so the two readings of "same characters" cannot drift apart.
 *
 * The one thing added on top is the meridiem: `7 a.m.`, `7 A.M.` and `7am` are one clock
 * time written three ways, and a page and a model rarely pick the same one. Both boundaries
 * are guarded, because without them `extra. my` folds into `extram y`.
 */
export function normaliseForMatch(text: string): string {
  return plainText(text)
    .toLowerCase()
    .replace(/\b([ap])\.\s?m\.?(?![a-z])/g, '$1m')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Money, clock times, numbers and words — in that order, because the alternatives overlap
 * and the longest reading of a run of characters is the right one. `$86.22` is one token
 * and not three; `10:30am` is one and not two.
 */
const SCAN =
  /\$\s?\d[\d,]*(?:\.\d+)?|\d{1,2}:\d{2}\s?(?:am|pm)?|\d{1,2}\s?(?:am|pm)\b|\d[\d,]*(?:\.\d+)?|[a-z]+/g;

/** A month beside a number is a DATE and not two tokens. Adjacency is bounded rather than
 * exact so `oct 05`, `oct. 5` and `5 october` all read the same; three characters is the
 * widest separator any of those spellings puts between the two halves. */
const ADJACENT_CHARS = 3;

function dayValue(word: string): string | undefined {
  return DAYS.get(word) ?? (word.endsWith('s') ? DAYS.get(word.slice(0, -1)) : undefined);
}

function monthValue(word: string): string | undefined {
  return MONTHS.get(word);
}

function dayOfMonth(raw: string): number | null {
  const digits = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(raw);
  if (!digits) return null;
  const value = Number(digits[1]);
  return value >= 1 && value <= 31 ? value : null;
}

/** Every load-bearing token in a string, in the order it appears. */
function readAnchors(normalised: string): Anchor[] {
  const lexed = [...normalised.matchAll(SCAN)].map((match) => ({
    raw: match[0],
    at: match.index,
    end: match.index + match[0].length,
  }));

  const anchors: Anchor[] = [];
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
        meridiem: clock[3] === undefined ? null : (clock[3][0] as 'a' | 'p'),
        at,
        end,
      });
      continue;
    }

    const hour = /^(\d{1,2})\s?(am|pm)$/.exec(raw);
    if (hour) {
      anchors.push({
        kind: 'time',
        value: `${Number(hour[1])}:00`,
        meridiem: (hour[2] as string)[0] as 'a' | 'p',
        at,
        end,
      });
      continue;
    }

    if (/^\d/.test(raw)) {
      const day = dayOfMonth(raw);
      const month = adjacent && next ? monthValue(next.raw) : undefined;
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

    const month = monthValue(raw);
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

/** Tokenise a page once, so a run can check ninety facts against it without re-reading
 * seventy thousand characters ninety times. */
export function preparePage(text: string): PageEvidence {
  const normalised = normaliseForMatch(text);
  return { text: normalised, anchors: readAnchors(normalised) };
}

/**
 * A token that could only be about this one thing.
 *
 * A day name and a bare number are true of half the page; a fee, a clock time, a calendar
 * date and a six-digit session code are not. Requiring one of these is what stops a quote
 * made entirely of "monday" and "3" from being checkable at all.
 */
function isDistinctive(anchor: Anchor): boolean {
  return anchor.kind === 'money' || anchor.kind === 'time' || anchor.kind === 'date' || anchor.kind === 'code';
}

/** The page satisfies the quote's token only if it is the same fact. A quote that named a
 * meridiem must find that meridiem; a quote that wrote a bare `10:00` is satisfied by the
 * page's `10:00am`, because that is the page supplying detail the quote left off. */
function satisfies(wanted: Anchor, found: Anchor): boolean {
  if (wanted.kind !== found.kind || wanted.value !== found.value) return false;
  return wanted.kind !== 'time' || wanted.meridiem === null || wanted.meridiem === found.meridiem;
}

/**
 * Are all of the quote's tokens on the page, in this order, inside one window?
 *
 * The forward walk stops at the window rather than at the end of the page, which is what
 * keeps this cheap: a seventy-thousand-character page holds some five thousand tokens, and
 * every candidate start looks at the thirty-odd that fall within 120 characters of it.
 */
function anchorsAreOnPage(wanted: readonly Anchor[], page: PageEvidence): boolean {
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
 * Is this quote backed by this page?
 *
 * VERBATIM FIRST, always: a span the page prints exactly is backed, and that path is
 * unchanged from the check this replaces, so nothing that used to pass can start failing.
 * The token pass is a SECOND chance for the quotes a verbatim check cannot express — never
 * a relaxation of the first.
 *
 * `quote` and the page are both {@link normaliseForMatch}'d; the page arrives already
 * prepared because it is checked against many times.
 */
export function quoteIsBackedBy(quote: string, page: PageEvidence): boolean {
  const needle = normaliseForMatch(quote);
  if (needle === '') return false;
  if (page.text.includes(needle)) return true;

  const wanted = readAnchors(needle);
  if (wanted.length < MIN_ANCHORS) return false;
  if (!wanted.some(isDistinctive)) return false;
  return anchorsAreOnPage(wanted, page);
}

/**
 * DOES THIS PAGE PUBLISH A SCHEDULE AT ALL — the positive evidence an absence claim needs.
 *
 * "Their fall page has no times on it yet" is a statement about a page, and until this
 * function there was nothing in the lane that had actually LOOKED. The licence was
 * `pagesOpened`, which answers a different question — somebody opened something — and on
 * 2026-08-24 it let Hale report a published grid as unpublished because the checker had
 * refused every fact off it. A refusal is Hale not knowing; it is not the page being empty.
 *
 * A CLOCK TIME OR A PRICE, and deliberately not a session code: a page carrying nothing but
 * a phone number tokenises a four-digit code out of it, and a signal that fires on every
 * page with a phone number would make the honest "not posted yet" unsayable forever. Those
 * two are also exactly the two facts the message wants — a page with neither has, for this
 * lane's purposes, published nothing.
 *
 * FAIL-CLOSED: any doubt reads as "there is a schedule here", which withholds the absence
 * claim. The cost of that is a vaguer sentence; the cost of the other error is a parent who
 * stops looking for a class that is open for registration.
 */
export function pageCarriesSchedule(page: PageEvidence): boolean {
  return page.anchors.some((anchor) => anchor.kind === 'money' || anchor.kind === 'time');
}

/**
 * Does this sentence actually STATE a schedule fact, or only talk about one?
 *
 * "Sundays 9:30-10:15" states one. "$124 per term" states one. "Fees set by Council each
 * year, published in the current Recreation Guide" is a sentence about where a price
 * lives, offered where a price should be — and a lane that reads it as an answer hands a
 * parent a non-answer and writes down no promise to go back for the real one
 * (deliver.ts `carriesFact`).
 *
 * A DAY COUNTS, unlike in {@link pageCarriesSchedule}. The two questions are different:
 * there, "does this whole page publish a schedule" must not fire on the day-of-week in a
 * building's opening hours; here the field is already claiming to BE the `when` of a
 * class, so "Sundays" is a real if partial answer to it.
 */
export function statesAFigure(field: string): boolean {
  return readAnchors(normaliseForMatch(field)).some(
    (anchor) => anchor.kind !== 'number' && anchor.kind !== 'code',
  );
}

/**
 * How much of a long page's HEAD is kept for context no matter what it contains.
 *
 * A page's first few thousand characters are its title, its season, its "registration
 * opens Tuesday, September 1" paragraph — the things that say WHAT the rest of it is about
 * and that carry no clock time to mark themselves with. Dropping them to make room for
 * more table rows would hand the merge a grid with nothing to attach it to.
 */
export const HEAD_CONTEXT_CHARS = 4_000;

/** A line that is carrying schedule detail: a fee, or a clock time. The same two signals
 * {@link pageCarriesSchedule} trusts, and for the same reason — a session code cannot be
 * told from a phone number, and every municipal page has a phone number on it. */
const SCHEDULE_LINE = /\$\s?\d|\b\d{1,2}:\d{2}\b|\b\d{1,2}\s?[ap]\.?\s?m\.?\b/i;

/** What was cut, said out loud, so the merge reads a page with gaps in it rather than a
 * page that ended early. */
const ELISION = '\n[...]\n';

/**
 * THE BUDGETED VIEW OF A LONG PAGE — the schedule kept, the boilerplate dropped.
 *
 * A HEAD SLICE IS THE WRONG CUT, and this is the second half of the 2026-08-24 failure.
 * Bounding a page for the merge's prompt is a real cost decision (fanout.ts), but taking
 * the FIRST 24,000 characters of an 88,501-character municipal page keeps the accessibility
 * notice and the parking information and throws away the grid, which begins somewhere past
 * 27,000 on every page of this kind. The merge cannot report what it was not shown, so the
 * lane spent three research legs and an Opus turn to answer "their site lists it".
 *
 * So the budget buys the SCHEDULE instead of the beginning: the head for context, then
 * every line carrying a fee or a clock time, each with the line above it — because a fee
 * table's meaning is in its heading ("Halton Hills Taxpayer Fees:", "Program | Day | Time |
 * Dates | code") and a row torn off from it is a row about nothing.
 *
 * IT NEVER GROWS THE PROMPT. A page inside the budget is returned untouched, and the result
 * is never longer than `budget`. What it changes is WHICH characters get bought.
 */
export function scheduleExcerpt(
  text: string,
  budget: number,
): { text: string; truncated: boolean } {
  if (text.length <= budget) return { text, truncated: false };

  const lines = text.split('\n');
  const keep = new Array<boolean>(lines.length).fill(false);
  const cost = (index: number) => (lines[index] as string).length + 1;

  let used = 0;
  let head = 0;
  while (head < lines.length && used + cost(head) <= HEAD_CONTEXT_CHARS) {
    keep[head] = true;
    used += cost(head);
    head += 1;
  }

  // Schedule lines next, in document order, each pulling in the heading above it. Order
  // matters: a grid read out of sequence is a grid whose columns no longer line up with
  // the row they came from.
  for (let index = head; index < lines.length; index += 1) {
    if (!SCHEDULE_LINE.test(lines[index] as string)) continue;
    // The line itself first, and `continue` rather than `break`: one unaffordable row
    // must not abandon the rest of the grid, and a heading too big to afford must not
    // cost us the row it labels.
    if (used + cost(index) + ELISION.length > budget) continue;
    const heading = index > 0 && !keep[index - 1] ? index - 1 : null;
    if (heading !== null && used + cost(index) + cost(heading) + ELISION.length <= budget) {
      keep[heading] = true;
      used += cost(heading);
    }
    keep[index] = true;
    used += cost(index);
  }

  // WHATEVER IS LEFT OF THE BUDGET GOES BACK TO THE PAGE, in order — and a line too long
  // to keep whole is kept as a PREFIX rather than skipped.
  //
  // Without this the function could hand back less than the head slice it replaced. A PDF
  // flattened to text arrives as one enormous unbroken line: the head pass cannot afford
  // it, the schedule pass cannot afford it, and the merge would be handed thirty-five
  // characters of a ninety-thousand-character page. Spending the remainder guarantees this
  // is never a worse view than the cut it replaced, only a better-chosen one.
  const partial = new Map<number, string>();
  for (let index = 0; index < lines.length; index += 1) {
    const room = budget - used - ELISION.length;
    if (room <= 0) break;
    if (keep[index]) continue;
    if (cost(index) <= room) {
      keep[index] = true;
      used += cost(index);
      continue;
    }
    partial.set(index, (lines[index] as string).slice(0, room));
    used += room;
  }

  const out: string[] = [];
  let elided = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = keep[index] ? (lines[index] as string) : partial.get(index);
    if (line === undefined) {
      elided = true;
      continue;
    }
    if (elided) out.push(ELISION.trim());
    elided = partial.has(index);
    out.push(line);
  }
  return { text: out.join('\n').slice(0, budget), truncated: true };
}
