import { type FamilyStage, stageFromAgeInMonths } from '@hale/types';
import {
  type ActivityQuery,
  deidentifyActivityQuery,
} from '~/lib/channel/activity/deidentify';
import type { ActivityFinder, ActivityPick } from '~/lib/channel/activity/lane';
import type { ReplyLanguage } from '~/lib/channel/language';
import { resolveMunicipalities } from '~/lib/registration/match-registration-windows';
import { type WeekendPick, asciiCopy } from './radar-decide';

/**
 * The first useful text after kids and a postal code: what is on for this child
 * this year. A district registration date is not a substitute for that list.
 *
 * Planner framing. Hale is the planner for the kids' year. A find is one beat
 * of that year.
 */

export const YEAR_OPEN_LEAD = "Here's what's on for your kids this year:";

/**
 * Design locked (Sloane, 2026-09-24). The only bubble when the live year find
 * has nothing age-fit, including a search that failed. One sentence. The ladder
 * does not continue in this turn.
 */
export const YEAR_OPEN_EMPTY_BY_LANGUAGE: Record<ReplyLanguage, string> = {
  en: "Looking nearby for what's on. Nothing age-fit yet — I'll text you the first good one in a day or two.",
  fr: "Je cherche ce qui se passe autour. Rien d'age adapt pour l'instant — je t'envoie le premier bon dans un jour ou deux.",
};

/** No live find yet. Not a registration date, and not a second ask. */
export function yearOpenEmptyMessage(language: ReplyLanguage = 'en'): string {
  return YEAR_OPEN_EMPTY_BY_LANGUAGE[language];
}

const STAGE_SUBJECT: Record<FamilyStage, string> = {
  newborn: 'programs for a baby',
  toddler: 'programs for a toddler',
  preschool: 'programs for a preschooler',
  child: 'programs for a school-age child',
  teenager: 'programs for a teenager',
};

export type YearFinderUse =
  | 'used'
  | 'skipped_enough'
  | 'not_configured'
  | 'failed'
  | 'empty'
  | 'refused';

/**
 * What may be searched: a stage word, a town when the FSA names exactly one, and
 * "this year". No child name, no exact age, no postal code (rule #1). Ages 0-18
 * all get a subject; nothing here refuses a finder because of age.
 */
export function yearOpenQuery(input: {
  children: readonly { name: string | null; ageMonths: number | null }[];
  areaCoarse: string | null;
}): { ok: true; query: ActivityQuery } | { ok: false; reason: string } {
  const ages = input.children
    .map((child) => child.ageMonths)
    .filter((age): age is number => age !== null);
  if (ages.length === 0) return { ok: false, reason: 'no_age' };
  const youngest = Math.min(...ages);
  const stage = stageFromAgeInMonths(youngest);
  const stages = [...new Set(ages.map((age) => stageFromAgeInMonths(age)))];
  const municipalities = input.areaCoarse ? resolveMunicipalities(input.areaCoarse) : [];
  const municipality = municipalities.length === 1 ? (municipalities[0] ?? null) : null;
  const householdNames = input.children
    .map((child) => child.name)
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
  const deidentified = deidentifyActivityQuery({
    subject: STAGE_SUBJECT[stage],
    window: 'this year',
    municipality,
    stage,
    householdNames,
  });
  if (!deidentified.ok) return { ok: false, reason: deidentified.refusal };
  if (stages.length > 1) return { ok: true, query: { ...deidentified.query, stages } };
  return deidentified;
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

export function renderYearOpen(lines: readonly string[]): string {
  const shown = lines.map((line) => line.trim()).filter((line) => line.length > 0).slice(0, 3);
  if (shown.length === 0) return yearOpenEmptyMessage();
  return `${YEAR_OPEN_LEAD}\n${shown.map((line, index) => `${index + 1}. ${line}`).join('\n')}`;
}

/**
 * Civic age-fit lines first. A web search fills toward three only when fewer than
 * two are already in hand. Absence of the finder is logged and named.
 */
export async function collectYearOpenLines(input: {
  civic: readonly WeekendPick[];
  children: readonly { name: string | null; ageMonths: number | null }[];
  areaCoarse: string | null;
  finder: ActivityFinder | null;
  familyId: string;
}): Promise<{ lines: string[]; finder: YearFinderUse }> {
  const civicLines = input.civic.slice(0, 3).map(civicLine);
  if (civicLines.length >= 2) {
    return { lines: civicLines, finder: 'skipped_enough' };
  }
  if (!input.finder) {
    console.info(
      { familyId: input.familyId },
      'intake year find: skipped: not_configured',
    );
    return { lines: civicLines, finder: 'not_configured' };
  }
  const query = yearOpenQuery({ children: input.children, areaCoarse: input.areaCoarse });
  if (!query.ok) {
    console.info(
      { familyId: input.familyId, reason: query.reason },
      'intake year find: query refused',
    );
    return { lines: civicLines, finder: 'refused' };
  }
  try {
    const found = await input.finder.find(query.query);
    if (!found.found) {
      console.info(
        { familyId: input.familyId, reason: found.reason },
        'intake year find: no web picks',
      );
      return { lines: civicLines, finder: 'empty' };
    }
    const room = 3 - civicLines.length;
    const web = found.picks.slice(0, room).map(webLine);
    return { lines: [...civicLines, ...web], finder: 'used' };
  } catch (err) {
    console.error(
      {
        familyId: input.familyId,
        err: err instanceof Error ? err.constructor.name : 'unknown',
      },
      'intake year find: search failed',
    );
    return { lines: civicLines, finder: 'failed' };
  }
}
