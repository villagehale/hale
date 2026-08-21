import type Anthropic from '@anthropic-ai/sdk';

/**
 * WHAT A GROUNDING TURN ACTUALLY READ — the value the lane did not have, and the
 * benchmark defect that follows from not having it.
 *
 * 2026-08-21. A parent asked about Cartwheels. Hale said "no dates or price up yet". Their
 * published fall block — Sept 14/15 to Oct 26/27, $124-145, registration open since
 * July 22 — was on their own schedule page. Hale said the Gellert swim schedule "posts
 * when registration opens"; the full Fall P&T schedule with class codes and $86.22 was
 * already up. Neither answer was a judgement call. Both were a turn that read SEARCH
 * SNIPPETS and then made a claim about PAGES.
 *
 * "There are no dates posted" is a statement about a page somebody opened. Until this
 * module there was no field anywhere in the lane that knew whether one had been, so the
 * honest sentence and the ignorant one were the same string. This is that field.
 *
 * THE THREE COUNTS ARE KEPT APART ON PURPOSE (rule #11):
 *
 *   `searchResults` — the old grounding invariant. A turn that searched.
 *   `pagesRead`     — a `web_fetch` that came back with a DOCUMENT. A page somebody
 *                     opened, and the only thing that licenses "their page doesn't say".
 *   `pagesRefused`  — a `web_fetch` that came back an ERROR. Verified live on the
 *                     benchmark's own venues: `cartwheelsgymcentre.com/programs.php`
 *                     returns `url_not_allowed` and the Halton Hills municipal page
 *                     returns `url_not_accessible`, while the same site's root fetches
 *                     fine. A refusal is not a page that said nothing. Folding the two
 *                     together would rebuild the exact defect one layer down.
 *
 * The `web_fetch` result shape is read STRUCTURALLY rather than through the SDK's types:
 * the pinned SDK (0.41.0) predates the tool and has no `WebFetchTool` in its `ToolUnion`,
 * so there is nothing to import. Live-probed against `claude-sonnet-5` on 2026-08-21 —
 * `web_fetch_20260209` and `web_fetch_20250910` both run with no beta header, and both
 * return `{type:'web_fetch_tool_result', content:{type:'web_fetch_result'|
 * 'web_fetch_tool_result_error', ...}}`.
 */

/** What a grounding turn searched, opened, and wrote down. */
export interface GroundingEvidence {
  /** Real web-search results. An errored search block is not a result. */
  searchResults: number;
  /** Pages actually opened and returned as documents. */
  pagesRead: number;
  /** Fetches that came back refused or unreachable. Never a page that said nothing. */
  pagesRefused: number;
  /** The URLs behind `pagesRead`, so a pick can cite the page it was read off. */
  urlsRead: string[];
  /** Everything the turn wrote down: its prose, its tool arguments, and the TEXT OF THE
   * PAGES IT OPENED. The last is the point — a composer handed only prose is standing on
   * the model's summary of a page, and a composer handed the page can be checked. */
  notes: string;
}

interface FetchResultBlock {
  type: string;
  content?: {
    type?: string;
    url?: string;
    error_code?: string;
    content?: { source?: { data?: string } };
  };
}

function fetchBlock(block: Anthropic.ContentBlock): FetchResultBlock | null {
  const candidate = block as unknown as FetchResultBlock;
  return candidate.type === 'web_fetch_tool_result' ? candidate : null;
}

/** Read the whole turn once. Cheap, pure, and the single reader of these block shapes. */
export function readEvidence(content: Anthropic.ContentBlock[]): GroundingEvidence {
  let searchResults = 0;
  let pagesRead = 0;
  let pagesRefused = 0;
  const urlsRead: string[] = [];
  const notes: string[] = [];

  for (const block of content) {
    if (block.type === 'text') {
      notes.push(block.text);
      continue;
    }
    if (block.type === 'tool_use') {
      notes.push(JSON.stringify(block.input));
      continue;
    }
    if (block.type === 'web_search_tool_result') {
      if (Array.isArray(block.content)) searchResults += block.content.length;
      continue;
    }
    const fetched = fetchBlock(block);
    if (!fetched) continue;
    const result = fetched.content;
    if (result?.type !== 'web_fetch_result') {
      pagesRefused += 1;
      continue;
    }
    pagesRead += 1;
    const url = result.url ?? '';
    if (url !== '') urlsRead.push(url);
    const text = result.content?.source?.data ?? '';
    // The URL rides with its text so a downstream extraction can cite the page a fact
    // came off rather than the venue in the abstract.
    if (text !== '') notes.push(`--- page: ${url} ---\n${text}`);
  }

  return { searchResults, pagesRead, pagesRefused, urlsRead, notes: notes.join('\n').trim() };
}

/**
 * Does this de-identified subject NAME A PLACE?
 *
 * The fetch budget is bought with latency a parent is watching — a live probe of the
 * search+fetch turn took 52 seconds against 30-ish for search alone — so it is spent only
 * where it pays: the parent named somewhere, and the answer lives on that place's own
 * schedule page. "Cartwheels Gym Centre" and "Gellert swim schedule" both buy it;
 * "toddler gymnastics" does not, because there is no one site to open.
 *
 * DETERMINISTIC, and deliberately not a model call: this decides how a turn spends money
 * and seconds, and a decision that can be talked into firing is one that fires on every
 * turn. The signal is a capitalised word that is not a programme noun — the shape a
 * proper noun takes and a category never does. A model that title-cases "Toddler
 * Gymnastics" is not naming a venue and does not buy the budget, which is why the
 * generic set is checked before the capital.
 */
const PROGRAMME_WORDS = new Set([
  'gym',
  'gymnastics',
  'swim',
  'swimming',
  'lessons',
  'lesson',
  'class',
  'classes',
  'program',
  'programs',
  'programme',
  'toddler',
  'preschool',
  'baby',
  'kids',
  'parent',
  'tot',
  'drop',
  'schedule',
  'registration',
  'indoor',
  'outdoor',
  'fall',
  'winter',
  'spring',
  'summer',
  'session',
  'camp',
  'music',
  'dance',
  'soccer',
  'skating',
  'library',
  'recreation',
  'community',
  'centre',
  'center',
  'club',
]);

export function namesAVenue(subject: string): boolean {
  return subject
    .split(/[^A-Za-z0-9'-]+/)
    .filter((word) => word.length >= 3)
    .some((word) => {
      const first = word.charAt(0);
      if (first !== first.toUpperCase() || first === first.toLowerCase()) return false;
      return !PROGRAMME_WORDS.has(word.toLowerCase());
    });
}
