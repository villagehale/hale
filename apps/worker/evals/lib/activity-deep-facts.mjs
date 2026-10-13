/**
 * A date belongs to the page whose text was read, and a linked schedule document
 * is part of that reading.
 *
 * The live Cartwheels pass put "July 22" on rows cited to programs.php and called
 * it the home page. July 22 is on the home page, which was fetched, and not on
 * programs.php. The same page links a "Schedule at a glance" PDF that was never
 * opened. The judge then saw only the first 6,000 characters of the notes, which
 * end inside programs.php, so the home page looked unread.
 *
 * These checks read the pages. They do not require a sentence.
 */

const MONTHS = new Map([
  ['jan', 'january'],
  ['january', 'january'],
  ['feb', 'february'],
  ['february', 'february'],
  ['mar', 'march'],
  ['march', 'march'],
  ['apr', 'april'],
  ['april', 'april'],
  ['may', 'may'],
  ['jun', 'june'],
  ['june', 'june'],
  ['jul', 'july'],
  ['july', 'july'],
  ['aug', 'august'],
  ['august', 'august'],
  ['sep', 'september'],
  ['sept', 'september'],
  ['september', 'september'],
  ['oct', 'october'],
  ['october', 'october'],
  ['nov', 'november'],
  ['november', 'november'],
  ['dec', 'december'],
  ['december', 'december'],
]);

const DATE_RE =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi;

const SCHEDULE_LINK = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;

const UNREAD =
  /\b(?:could not|couldn'?t|cannot|can'?t|unable|did not open|didn'?t open|did not read|didn'?t read|not opened|failed to)\b/i;

/** How much of one fetched page the judge is shown when the notes no longer fit in one slice. */
const JUDGE_PAGE_CHARS = 4_000;

/** The historical slice. Short notes stay byte-for-byte so their judge keys do not move. */
const JUDGE_NOTES_CAP = 6_000;

function pageKey(url) {
  return String(url)
    .trim()
    .toLowerCase()
    .replace(/#.*$/, '')
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

function pageBlocks(notes) {
  const marks = [...String(notes).matchAll(/--- page:\s*(\S+)\s*---\n?/g)];
  return marks.map((mark, index) => {
    const start = mark.index + mark[0].length;
    const end = index + 1 < marks.length ? marks[index + 1].index : notes.length;
    return { url: mark[1], text: notes.slice(start, end) };
  });
}

/** Pages whose text was actually read. A frozen fixture stores that text under a blank url. */
export function fetchedPages(evidence) {
  const pages = [];
  for (const page of evidence?.pages ?? []) {
    const url = String(page?.url ?? '').trim();
    const text = String(page?.text ?? '');
    if (url) pages.push({ url, text });
    else pages.push(...pageBlocks(text));
  }
  if (pages.length === 0) pages.push(...pageBlocks(String(evidence?.notes ?? '')));
  return pages;
}

function dateKey(month, day) {
  const name = MONTHS.get(month.toLowerCase().replace(/\./g, ''));
  if (!name) return null;
  const n = Number(day);
  if (!Number.isInteger(n) || n < 1 || n > 31) return null;
  return `${name} ${n}`;
}

function datesIn(text) {
  const found = [];
  for (const match of String(text ?? '').matchAll(DATE_RE)) {
    const key = dateKey(match[1], match[2]);
    if (key) found.push(key);
  }
  return found;
}

function dateKeys(text) {
  return new Set(datesIn(text));
}

function citedPage(pages, slot) {
  const url = slot?.sourceUrl ?? slot?.source_url ?? '';
  const key = pageKey(url);
  if (!key) return null;
  return pages.find((page) => pageKey(page.url) === key) ?? null;
}

function isHomeUrl(url) {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '');
    return path === '' || /^\/index\.(?:php|html?)$/i.test(path);
  } catch {
    return false;
  }
}

function isRegistrationUrl(url) {
  return /registration/i.test(url);
}

const NAMED_PAGES = [
  { label: 'home page', test: /\bhome ?page\b/i, isUrl: isHomeUrl },
  { label: 'registration page', test: /\bregistration page\b/i, isUrl: isRegistrationUrl },
];

function factFields(slot) {
  return [slot?.when, slot?.price, slot?.registration].filter((field) => field);
}

/**
 * Every month-and-day in a slot has to be in the text of `source_url`, and a field
 * that names another page has to be naming one that was fetched and that carries
 * the date. A snippet, or a page that was not fetched, is not a credit.
 */
export function miscreditedDateFailures(slots, evidence) {
  const pages = fetchedPages(evidence);
  const failures = [];
  for (const slot of slots ?? []) {
    const name = slot?.name || 'slot';
    const page = citedPage(pages, slot);
    const onCited = dateKeys(page?.text ?? '');
    const seen = new Set();
    for (const field of factFields(slot)) {
      for (const key of datesIn(field)) {
        if (seen.has(key)) continue;
        seen.add(key);
        if (!onCited.has(key)) failures.push(`miscredited_date:${name}:${key}`);
      }
      for (const named of NAMED_PAGES) {
        if (!named.test.test(field)) continue;
        const matches = pages.filter((item) => named.isUrl(item.url));
        if (matches.length === 0) {
          failures.push(`miscredited_date:${name}:${named.label} not read`);
          continue;
        }
        const onNamed = new Set(matches.flatMap((item) => [...dateKeys(item.text)]));
        for (const key of datesIn(field)) {
          if (!onNamed.has(key))
            failures.push(`miscredited_date:${name}:${key} not on ${named.label}`);
        }
      }
    }
  }
  return failures;
}

function isScheduleDocument(label, url) {
  return /\.pdf(?:$|[?#])/i.test(url) && /schedule/i.test(`${label} ${url}`);
}

function scheduleDocs(pages) {
  const docs = [];
  const seen = new Set();
  for (const page of pages) {
    for (const match of page.text.matchAll(SCHEDULE_LINK)) {
      const url = match[2];
      if (!isScheduleDocument(match[1], url)) continue;
      if (pageKey(url) === pageKey(page.url)) continue;
      const key = pageKey(url);
      if (seen.has(key)) continue;
      seen.add(key);
      docs.push(url);
    }
  }
  return docs;
}

function admitsUnread(prose, url) {
  const file = decodeURIComponent(url.split('/').pop()?.split(/[?#]/)[0] ?? '');
  const stem = file.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ');
  const hay = prose.toLowerCase();
  const named =
    hay.includes(url.toLowerCase()) ||
    (file.length > 0 && hay.includes(file.toLowerCase())) ||
    (stem.length > 8 && hay.includes(stem.toLowerCase()));
  return named && UNREAD.test(prose);
}

/** The model's own words: the notes with each fetched page's text taken back out, plus the slot. */
function modelProse(evidence, slots) {
  let notes = String(evidence?.notes ?? '');
  for (const page of evidence?.pages ?? []) {
    if (page?.text) notes = notes.replace(page.text, ' ');
  }
  notes = notes.replace(/--- page:\s*\S+\s*---/g, ' ');
  return `${notes}\n${(slots ?? []).flatMap((slot) => factFields(slot)).join('\n')}`;
}

/**
 * When the opened pages publish a schedule and one of them links a schedule
 * document, that document was fetched, or the pass says it could not be read.
 * The wording is the model's. The document's name has to be in what it wrote.
 */
export function unreadScheduleFailures(slots, evidence, pageEvidence) {
  if (pageEvidence !== 'page_has_schedule') return [];
  const pages = fetchedPages(evidence);
  const fetched = new Set(pages.map((page) => pageKey(page.url)));
  const prose = modelProse(evidence, slots);
  const failures = [];
  for (const url of scheduleDocs(pages)) {
    if (fetched.has(pageKey(url))) continue;
    if (admitsUnread(prose, url)) continue;
    const file = url.split('/').pop()?.split(/[?#]/)[0] ?? url;
    failures.push(`unread_schedule:${file}`);
  }
  return failures;
}

/**
 * Notes for the judge. Under the old cap they are unchanged. Past it, every
 * fetched page is included, or a long first page hides the page a date came from.
 */
export function notesForTheJudge(evidence) {
  const notes = String(evidence?.notes ?? '');
  if (notes.length <= JUDGE_NOTES_CAP) return notes;
  const pages = fetchedPages(evidence);
  if (pages.length === 0) return notes.slice(0, JUDGE_NOTES_CAP);
  return pages
    .map((page) => `--- page: ${page.url} ---\n${page.text.slice(0, JUDGE_PAGE_CHARS)}`)
    .join('\n');
}
