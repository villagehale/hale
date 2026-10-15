/**
 * What the judge is shown of the pages a deep pass read.
 *
 * The live Cartwheels pass put "July 22" on rows cited to programs.php. The judge then
 * saw only the first 6,000 characters of the notes, which end inside programs.php, so
 * the home page that carries the date looked unread. Whether a date sits on the page it
 * is credited to is the judge's call (JUDGE_SYSTEM in run-activity-deep-eval.mjs); this
 * module only makes sure every fetched page is in front of it. Nothing here reads the
 * model's wording.
 */

/** How much of one fetched page the judge is shown when the notes no longer fit in one slice. */
const JUDGE_PAGE_CHARS = 4_000;

/** The historical slice. Short notes stay byte-for-byte so their judge keys do not move. */
const JUDGE_NOTES_CAP = 6_000;

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
