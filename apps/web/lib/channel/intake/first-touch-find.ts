import { deidentifyActivityQuery, townFor } from '~/lib/channel/activity/deidentify';
import type { ActivityFinder, ActivityPick } from '~/lib/channel/activity/lane';
import type { FirstTouchPlace } from './first-touch-place';
import { asciiCopy } from './radar-decide';

/**
 * VIL-385 — the pre-age "what's on this week" lookup.
 *
 * Live search only. No phone, no area code, no street, no child name. A finder
 * that is absent is logged and named `not_configured`; the caller sends the
 * locked empty line. This subject is a search seed, not a parent-facing string.
 */
export const WEEK_FIND_SUBJECT =
  'kids week drop-ins, examples not a limit: swim soccer gym earlyon library parks storytime music';

export type WeekFindOutcome = 'found' | 'empty' | 'not_configured' | 'failed' | 'refused' | 'budget';

/** How long the first-touch turn waits on the week search. The search may keep running. */
export const WEEK_FIND_BUDGET_MS = 8_000;

export async function findThisWeek(input: {
  finder: ActivityFinder | null;
  place: FirstTouchPlace;
}): Promise<{ lines: string[]; outcome: WeekFindOutcome }> {
  if (!input.finder) {
    console.info(
      { outcome: 'not_configured', municipality: input.place.municipality },
      'first-touch week find: skipped: not_configured',
    );
    return { lines: [], outcome: 'not_configured' };
  }
  const municipality = input.place.municipality;
  const query = deidentifyActivityQuery({
    subject: WEEK_FIND_SUBJECT,
    window: 'this week',
    municipality,
    stage: null,
    householdNames: [],
  });
  if (!query.ok) {
    console.info(
      { outcome: 'refused', reason: query.refusal, municipality },
      'first-touch week find: query refused',
    );
    return { lines: [], outcome: 'refused' };
  }
  try {
    const found = await input.finder.find(query.query);
    if (!found.found) {
      console.info(
        { outcome: found.reason, municipality, town: municipality ? townFor(municipality) : null },
        'first-touch week find: no picks',
      );
      return { lines: [], outcome: 'empty' };
    }
    const lines = found.picks
      .slice(0, 3)
      .map(pickLine)
      .filter((line) => line.length > 0);
    if (lines.length === 0) return { lines: [], outcome: 'empty' };
    return { lines, outcome: 'found' };
  } catch (err) {
    console.error(
      { outcome: 'failed', err: err instanceof Error ? err.name : 'unknown', municipality },
      'first-touch week find: search failed',
    );
    return { lines: [], outcome: 'failed' };
  }
}

/**
 * The same search as {@link findThisWeek}, except a slow finder resolves as
 * `budget` with no lines. The underlying request is not cancelled.
 */
export async function findThisWeekWithin(
  input: { finder: ActivityFinder | null; place: FirstTouchPlace },
  budgetMs = WEEK_FIND_BUDGET_MS,
): Promise<{ lines: string[]; outcome: WeekFindOutcome }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<{ lines: string[]; outcome: 'budget' }>((resolve) => {
    timer = setTimeout(() => {
      console.error({ outcome: 'budget', budgetMs }, 'first-touch week find: budget');
      resolve({ lines: [], outcome: 'budget' });
    }, budgetMs);
  });
  try {
    return await Promise.race([findThisWeek(input), budget]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The find bubble. Numbered pick lines only — no lead, no question. */
export function renderWeekFind(lines: readonly string[]): string | null {
  const shown = lines.map((line) => line.trim()).filter((line) => line.length > 0).slice(0, 3);
  if (shown.length === 0) return null;
  return shown.map((line, index) => `${index + 1}. ${line}`).join('\n');
}

function pickLine(pick: ActivityPick): string {
  if (!pick.name.trim() || !pick.ageFit.trim()) return '';
  const when = pick.when ? ` - ${pick.when}` : '';
  const price = pick.price ? ` - ${pick.price}` : '';
  return asciiCopy(`${pick.name} (${pick.ageFit})${when}${price}`);
}
