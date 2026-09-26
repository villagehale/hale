import { type FamilyStage, STAGE_BOUNDARIES_MONTHS, stageFromAgeInMonths } from '@hale/types';
import { type ActivityQuery, deidentifyActivityQuery } from '~/lib/channel/activity/deidentify';
import type { ActivityFinder, ActivityPick } from '~/lib/channel/activity/lane';
import type { ReplyLanguage } from '~/lib/channel/language';
import { resolveMunicipalities } from '~/lib/registration/match-registration-windows';
import { type WeekendPick, asciiCopy, parseAgeRange } from './radar-decide';

/**
 * The first useful text after kids and a postal code: what is on for this child
 * this year. A district registration date is not a substitute for that list.
 *
 * Planner framing. Hale is the planner for the kids' year. A find is one beat
 * of that year.
 */

export const YEAR_OPEN_LEAD = "Here's what's on for your kids this year:";

/**
 * Design locked (Sloane, 2026-09-24). The only bubble when the year search
 * truly failed and no source produced a line. One sentence. The ladder does
 * not continue in this turn.
 */
export const YEAR_OPEN_EMPTY_BY_LANGUAGE: Record<ReplyLanguage, string> = {
  en: "Looking nearby for what's on. Nothing age-fit yet — I'll text you the first good one in a day or two.",
  fr: "Je cherche ce qui se passe autour. Rien d'age adapt pour l'instant — je t'envoie le premier bon dans un jour ou deux.",
};

/** No live find yet. Not a registration date, and not a second ask. */
export function yearOpenEmptyMessage(language: ReplyLanguage = 'en'): string {
  return YEAR_OPEN_EMPTY_BY_LANGUAGE[language];
}

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
  'kids year, examples not a limit: swim soccer gym earlyon library parks fairs music museum zoo farm trips stem storytime';

export type YearFinderUse = 'used' | 'not_configured' | 'failed' | 'empty' | 'refused';

/**
 * What may be searched: the year subject above, a stage word, every stage in
 * the household when siblings differ, a town when the FSA names exactly one,
 * and "this year". No child name, no exact age, no postal code (rule #1).
 * Ages 0-18 all get a subject; nothing here refuses a finder because of age.
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
    subject: YEAR_OPEN_SUBJECT,
    window: 'this year',
    municipality,
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
  if (shown.length === 0) return yearOpenEmptyMessage();
  return `${YEAR_OPEN_LEAD}\n${shown.map((line, index) => `${index + 1}. ${line}`).join('\n')}`;
}

/**
 * The live search always runs. Stage-fitting picks are said first, civic
 * weekend lines fill toward three, and a pick outside the household's stages
 * stays in the list when there is room. Absence of the finder is logged and
 * named. The locked empty sentence is the caller's job, and only when this
 * returns no lines.
 */
export async function collectYearOpenLines(input: {
  civic: readonly WeekendPick[];
  children: readonly { name: string | null; ageMonths: number | null }[];
  areaCoarse: string | null;
  finder: ActivityFinder | null;
  familyId: string;
}): Promise<{ lines: string[]; titles: string[]; finder: YearFinderUse }> {
  const civic = input.civic.slice(0, 3).map(civicHit);
  if (!input.finder) {
    console.info({ familyId: input.familyId }, 'intake year find: skipped: not_configured');
    return packYearOpen(civic, 'not_configured');
  }
  const query = yearOpenQuery({ children: input.children, areaCoarse: input.areaCoarse });
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
    const stages =
      query.query.stages && query.query.stages.length > 0
        ? query.query.stages
        : query.query.stage
          ? [query.query.stage]
          : [];
    const ranked = [...found.picks].sort(
      (a, b) => ageFitRank(a.ageFit, stages) - ageFitRank(b.ageFit, stages),
    );
    const leading = ranked.filter((pick) => ageFitRank(pick.ageFit, stages) === 0);
    const trailing = ranked.filter((pick) => ageFitRank(pick.ageFit, stages) === 1);
    return packYearOpen([...leading.map(webHit), ...civic, ...trailing.map(webHit)], 'used');
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

/** Month span of one stage. Read from the shared boundaries so a preschool
 * shift cannot leave this rank on a stale floor. */
function spanOf(stage: FamilyStage): { min: number; max: number } {
  const [toddler, preschool, child, teenager] = STAGE_BOUNDARIES_MONTHS;
  switch (stage) {
    case 'newborn':
      return { min: 0, max: toddler - 1 };
    case 'toddler':
      return { min: toddler, max: preschool - 1 };
    case 'preschool':
      return { min: preschool, max: child - 1 };
    case 'child':
      return { min: child, max: teenager - 1 };
    case 'teenager':
      return { min: teenager, max: Number.POSITIVE_INFINITY };
  }
}

/**
 * 0 leads, 1 follows. An age label we cannot read, an all-ages label, and a
 * band that overlaps any household stage all lead. A band we can read that
 * overlaps none of them follows. It is never dropped.
 */
function ageFitRank(ageFit: string, stages: readonly FamilyStage[]): 0 | 1 {
  if (stages.length === 0) return 0;
  const band = parseAgeRange(ageFit);
  if (!band) return 0;
  if (band.minMonths === null && band.maxMonths === null) return 0;
  const min = band.minMonths ?? 0;
  const max = band.maxMonths ?? Number.POSITIVE_INFINITY;
  if (min > max) return 0;
  const fits = stages.some((stage) => {
    const span = spanOf(stage);
    return min <= span.max && max >= span.min;
  });
  return fits ? 0 : 1;
}
