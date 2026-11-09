import { stageFromAgeInMonths } from '@hale/types';
import { type ActivityQuery, deidentifyActivityQuery } from '~/lib/channel/activity/deidentify';
import type { ActivityFinder, ActivityPick } from '~/lib/channel/activity/lane';
import { fitsHouseholdAges } from './pick-fit';
import { type RadarChild, type WeekendPick, asciiCopy } from './radar-decide';

/**
 * The first useful text after kids and a postal code: what is on for this child
 * this year. A district registration date is not a substitute for that list.
 *
 * Planner framing. Hale is the planner for the kids' year. A find is one beat
 * of that year.
 */

/**
 * What the live year search looks for. One subject for every age: the stage
 * rides on the query and ranks what is said first. It does not choose, and
 * does not forbid, a kind of activity.
 *
 * 119 characters, under {@link MAX_QUERY_FIELD_CHARS}. Lowercase, so the
 * intake turn does not buy a venue fetch. No digits, so the de-id scrub leaves
 * it unchanged. The words are search seeds. "examples not a limit" is the
 * instruction that a kind missing from the 120-character ceiling (skate,
 * tryouts, dance, a community centre, playgrounds) is still in scope. Nothing
 * in this module filters a pick against these words.
 */
export const YEAR_OPEN_SUBJECT =
  'kids year, examples not a limit: swim soccer gym library parks rec fairs music museum zoo farm trips stem storytime';

export type YearFinderUse = 'used' | 'not_configured' | 'failed' | 'empty' | 'refused';

/**
 * What may be searched: the year subject above, a stage word, every stage in
 * the household when siblings differ, the family's town (place.ts), and
 * "this year". No town, no search. No child name, no exact age, no postal code (rule #1).
 * Ages 0-18 all get a subject; nothing here refuses a finder because of age.
 */
export function yearOpenQuery(input: {
  children: readonly { name: string | null; ageMonths: number | null }[];
  town: string | null;
}): { ok: true; query: ActivityQuery } | { ok: false; reason: string } {
  const ages = input.children
    .map((child) => child.ageMonths)
    .filter((age): age is number => age !== null);
  if (ages.length === 0) return { ok: false, reason: 'no_age' };
  const youngest = Math.min(...ages);
  const stage = stageFromAgeInMonths(youngest);
  const stages = [...new Set(ages.map((age) => stageFromAgeInMonths(age)))];
  const householdNames = input.children
    .map((child) => child.name)
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
  const deidentified = deidentifyActivityQuery({
    subject: YEAR_OPEN_SUBJECT,
    window: 'this year',
    town: input.town,
    stage,
    householdNames,
  });
  if (!deidentified.ok) return { ok: false, reason: deidentified.refusal };
  if (stages.length > 1) return { ok: true, query: { ...deidentified.query, stages } };
  return deidentified;
}

interface YearOpenHit {
  line: string;
  /** The find's own title. The poll uses this, never the rendered line. */
  title: string;
}

function civicLine(pick: WeekendPick): string {
  const where = pick.candidateRef.venueName ? ` at ${pick.candidateRef.venueName}` : '';
  const who = pick.kidNames.length > 0 ? ` for ${pick.kidNames.join(' and ')}` : '';
  const why = pick.whyFacts.length > 0 ? ` (${pick.whyFacts.join(', ')})` : '';
  const day = pick.day.charAt(0).toUpperCase() + pick.day.slice(1);
  return asciiCopy(`${day}: ${pick.candidateRef.title}${where}${who}${why}`);
}

function webLine(pick: ActivityPick): string {
  const when = pick.when ? ` - ${pick.when}` : '';
  const price = pick.price ? ` - ${pick.price}` : '';
  return asciiCopy(`${pick.name} (${pick.ageFit})${when}${price}`);
}

function civicHit(pick: WeekendPick): YearOpenHit {
  return { line: civicLine(pick), title: pick.candidateRef.title.trim() };
}

function webHit(pick: ActivityPick): YearOpenHit {
  return { line: webLine(pick), title: pick.name.trim() };
}

function packYearOpen(
  hits: readonly YearOpenHit[],
  finder: YearFinderUse,
): { lines: string[]; titles: string[]; finder: YearFinderUse } {
  const shown = hits.slice(0, 3);
  return {
    lines: shown.map((hit) => hit.line),
    titles: shown.map((hit) => hit.title).filter((title) => title.length > 0),
    finder,
  };
}

export function renderYearOpen(lines: readonly string[]): string {
  const shown = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 3);
  // Data, not a message: the numbered lines the friend voice is handed. No lead,
  // and nothing at all when the search found nothing (#868: no fixed lines).
  return shown.map((line, index) => `${index + 1}. ${line}`).join('\n');
}

/**
 * The live search always runs. Picks whose age band holds a child are said
 * first and civic weekend lines fill toward three; a pick outside every
 * child's age is left out (pick-fit.ts). Absence of the finder is logged and
 * named. The locked empty sentence is the caller's job, and only when this
 * returns no lines.
 */
export async function collectYearOpenLines(input: {
  civic: readonly WeekendPick[];
  children: readonly Pick<RadarChild, 'name' | 'ageMonths' | 'dobPrecision'>[];
  town: string | null;
  finder: ActivityFinder | null;
  familyId: string;
}): Promise<{ lines: string[]; titles: string[]; finder: YearFinderUse }> {
  const civic = input.civic.slice(0, 3).map(civicHit);
  if (!input.finder) {
    console.info({ familyId: input.familyId }, 'intake year find: skipped: not_configured');
    return packYearOpen(civic, 'not_configured');
  }
  const query = yearOpenQuery({ children: input.children, town: input.town });
  if (!query.ok) {
    console.info(
      { familyId: input.familyId, reason: query.reason },
      'intake year find: query refused',
    );
    return packYearOpen(civic, 'refused');
  }
  try {
    const found = await input.finder.find(query.query);
    if (!found.found) {
      console.info(
        { familyId: input.familyId, reason: found.reason },
        'intake year find: no web picks',
      );
      return packYearOpen(civic, 'empty');
    }
    const fitting = found.picks.filter((pick) => fitsHouseholdAges(pick, input.children));
    console.info(
      {
        familyId: input.familyId,
        picks: found.picks.length,
        droppedAge: found.picks.length - fitting.length,
      },
      'intake year find',
    );
    return packYearOpen([...fitting.map(webHit), ...civic], 'used');
  } catch (err) {
    console.error(
      {
        familyId: input.familyId,
        err: err instanceof Error ? err.constructor.name : 'unknown',
      },
      'intake year find: search failed',
    );
    return packYearOpen(civic, 'failed');
  }
}
