import { STAGE_BOUNDARIES_MONTHS, stageFromAgeInMonths } from '@hale/types';
import { type ActivityQuery, deidentifyActivityQuery } from '~/lib/channel/activity/deidentify';
import type { ActivityFinder, ActivityPick } from '~/lib/channel/activity/lane';
import { resolveMunicipalities } from '~/lib/registration/match-registration-windows';
import { type WeekendPick, asciiCopy } from './radar-decide';

/**
 * Step 4 of onboarding: a broad, skimmable map of what is on for these kids,
 * from real search data only.
 *
 * Code decides which categories fit the kids' ages and runs one live search
 * per category. The model writes the lead-in for each group; code places the
 * real lines under it. Nothing here writes a parent-facing sentence, and no
 * line exists that a search did not return.
 */

export type ActivityCategoryId =
  | 'parent_baby'
  | 'swimming'
  | 'free_public'
  | 'music_dance'
  | 'outdoors'
  | 'learning_sports_arts'
  | 'seasonal_outings'
  | 'social_growth'
  | 'language_culture';

export interface ActivityCategory {
  id: ActivityCategoryId;
  /**
   * Search seeds. Lowercase, no digits, under the query ceiling. Examples, not
   * a limit: the finder decides what the page actually says.
   */
  subject: string;
  /** Inclusive age band in months this category is shown for. */
  minMonths: number;
  maxMonths: number;
  /**
   * Per-stage rank, lower first. Babies and toddlers lean on parent-and-baby
   * groups, swimming and free facilities. Older kids lean on learning, sports,
   * arts and camps.
   */
  rank: Record<'newborn' | 'toddler' | 'preschool' | 'child' | 'teenager', number>;
}

const [, PRESCHOOL, CHILD] = STAGE_BOUNDARIES_MONTHS;
const EIGHTEEN = 18 * 12;

export const ACTIVITY_CATEGORIES: readonly ActivityCategory[] = [
  {
    id: 'parent_baby',
    subject: 'parent and baby toddler groups earlyon library story time drop-in play groups',
    minMonths: 0,
    maxMonths: PRESCHOOL + 11,
    rank: { newborn: 0, toddler: 0, preschool: 3, child: 9, teenager: 9 },
  },
  {
    id: 'swimming',
    subject: 'kids swimming lessons water safety skills parent and tot swim',
    minMonths: 4,
    maxMonths: EIGHTEEN,
    rank: { newborn: 1, toddler: 1, preschool: 1, child: 2, teenager: 5 },
  },
  {
    id: 'free_public',
    subject: 'free community centre drop-in swim skating open gym family programs',
    minMonths: 0,
    maxMonths: EIGHTEEN,
    rank: { newborn: 2, toddler: 2, preschool: 4, child: 4, teenager: 4 },
  },
  {
    id: 'music_dance',
    subject: 'kids music classes instruments choir kids dance movement classes',
    minMonths: 12,
    maxMonths: EIGHTEEN,
    rank: { newborn: 9, toddler: 4, preschool: 2, child: 3, teenager: 3 },
  },
  {
    id: 'outdoors',
    subject: 'outdoors nature parks trails forest school camps splash pads family hikes',
    minMonths: 0,
    maxMonths: EIGHTEEN,
    rank: { newborn: 3, toddler: 3, preschool: 5, child: 5, teenager: 6 },
  },
  {
    id: 'learning_sports_arts',
    subject: 'kids learning programs sports soccer gymnastics skating arts crafts classes',
    minMonths: PRESCHOOL,
    maxMonths: EIGHTEEN,
    rank: { newborn: 9, toddler: 9, preschool: 0, child: 0, teenager: 0 },
  },
  {
    id: 'seasonal_outings',
    subject: 'family outings fairs farm markets museums exhibits zoo aquarium seasonal events',
    minMonths: 0,
    maxMonths: EIGHTEEN,
    rank: { newborn: 4, toddler: 5, preschool: 6, child: 6, teenager: 7 },
  },
  {
    id: 'social_growth',
    subject: 'day camps pa day holiday camps after school care scouts girl guides',
    minMonths: CHILD - 12,
    maxMonths: EIGHTEEN,
    rank: { newborn: 9, toddler: 9, preschool: 7, child: 1, teenager: 1 },
  },
  {
    id: 'language_culture',
    subject: 'kids french classes chinese classes language programs community cultural events',
    minMonths: PRESCHOOL,
    maxMonths: EIGHTEEN,
    rank: { newborn: 9, toddler: 9, preschool: 8, child: 7, teenager: 2 },
  },
];

/** Groups on one map. Two or three, never the whole catalogue. */
export const MAX_MAP_GROUPS = 3;
/** Real results per group. The finder returns at most three; two or three are shown. */
export const MAX_MAP_ITEMS_PER_GROUP = 3;

/**
 * The two or three categories most relevant to these kids. Every child's age
 * votes; a category outside every child's band is not shown. Ties keep the
 * catalogue order.
 */
export function categoriesForAges(
  ageMonths: readonly number[],
  limit = MAX_MAP_GROUPS,
): ActivityCategory[] {
  const ages = ageMonths.filter((age) => Number.isFinite(age) && age >= 0);
  if (ages.length === 0) return [];
  const scored = ACTIVITY_CATEGORIES.flatMap((category) => {
    const fitting = ages.filter((age) => age >= category.minMonths && age <= category.maxMonths);
    if (fitting.length === 0) return [];
    const score = Math.min(...fitting.map((age) => category.rank[stageFromAgeInMonths(age)]));
    return [{ category, score }];
  });
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, Math.max(2, Math.min(limit, MAX_MAP_GROUPS))).map((row) => row.category);
}

export interface ActivityMapGroup {
  category: ActivityCategoryId;
  /** Rendered lines, in the finder's own words. */
  lines: string[];
  /** The finds' own titles, same order as lines. */
  titles: string[];
}

export type ActivityMapFinder = 'used' | 'not_configured' | 'refused' | 'failed' | 'empty';

export interface ActivityMap {
  groups: ActivityMapGroup[];
  /** Every line across groups, in map order. Index + 1 is the number the parent sees. */
  lines: string[];
  titles: string[];
  finder: ActivityMapFinder;
}

function webLine(pick: ActivityPick): string {
  const when = pick.when ? ` - ${pick.when}` : '';
  const price = pick.price ? ` - ${pick.price}` : '';
  return asciiCopy(`${pick.name} (${pick.ageFit})${when}${price}`);
}

function civicLine(pick: WeekendPick): string {
  const where = pick.candidateRef.venueName ? ` at ${pick.candidateRef.venueName}` : '';
  const day = pick.day.charAt(0).toUpperCase() + pick.day.slice(1);
  return asciiCopy(`${day}: ${pick.candidateRef.title}${where}`);
}

function categoryQuery(
  category: ActivityCategory,
  input: {
    children: readonly { name: string | null; ageMonths: number | null }[];
    areaCoarse: string | null;
  },
): ActivityQuery | null {
  const ages = input.children
    .map((child) => child.ageMonths)
    .filter((age): age is number => age !== null);
  if (ages.length === 0) return null;
  const stages = [...new Set(ages.map((age) => stageFromAgeInMonths(age)))];
  const municipalities = input.areaCoarse ? resolveMunicipalities(input.areaCoarse) : [];
  const municipality = municipalities.length === 1 ? (municipalities[0] ?? null) : null;
  const householdNames = input.children
    .map((child) => child.name)
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
  const deidentified = deidentifyActivityQuery({
    subject: category.subject,
    window: 'this year',
    municipality,
    stage: stageFromAgeInMonths(Math.min(...ages)),
    householdNames,
  });
  if (!deidentified.ok) return null;
  return stages.length > 1 ? { ...deidentified.query, stages } : deidentified.query;
}

function flatten(groups: ActivityMapGroup[], finder: ActivityMapFinder): ActivityMap {
  const kept = groups.filter((group) => group.lines.length > 0);
  return {
    groups: kept,
    lines: kept.flatMap((group) => group.lines),
    titles: kept.flatMap((group) => group.titles),
    finder,
  };
}

/**
 * One live search per fitting category, in parallel. A category whose search
 * returned nothing is left off the map rather than filled. Civic weekend
 * finds join the free-and-public group when that group is shown, since they
 * are the free sessions a community centre or library publishes.
 */
export async function collectActivityMap(input: {
  finder: ActivityFinder | null;
  children: readonly { name: string | null; ageMonths: number | null }[];
  areaCoarse: string | null;
  civic: readonly WeekendPick[];
  familyId: string;
}): Promise<ActivityMap> {
  const ages = input.children
    .map((child) => child.ageMonths)
    .filter((age): age is number => age !== null);
  const categories = categoriesForAges(ages);
  const civicGroup: ActivityMapGroup | null =
    input.civic.length > 0
      ? {
          category: 'free_public',
          lines: input.civic.slice(0, MAX_MAP_ITEMS_PER_GROUP).map(civicLine),
          titles: input.civic
            .slice(0, MAX_MAP_ITEMS_PER_GROUP)
            .map((pick) => pick.candidateRef.title.trim()),
        }
      : null;
  if (!input.finder) {
    console.info({ familyId: input.familyId }, 'intake activity map: skipped: not_configured');
    return flatten(civicGroup ? [civicGroup] : [], 'not_configured');
  }
  if (categories.length === 0) {
    return flatten(civicGroup ? [civicGroup] : [], 'refused');
  }
  let anyUsed = false;
  let anyFailed = false;
  const groups = await Promise.all(
    categories.map(async (category): Promise<ActivityMapGroup> => {
      const query = categoryQuery(category, input);
      const empty: ActivityMapGroup = { category: category.id, lines: [], titles: [] };
      if (!query) return empty;
      try {
        const found = await input.finder?.find(query);
        if (!found || !found.found) return empty;
        anyUsed = true;
        const picks = found.picks.slice(0, MAX_MAP_ITEMS_PER_GROUP);
        return {
          category: category.id,
          lines: picks.map(webLine),
          titles: picks.map((pick) => pick.name.trim()),
        };
      } catch (err) {
        anyFailed = true;
        console.error(
          {
            familyId: input.familyId,
            category: category.id,
            err: err instanceof Error ? err.constructor.name : 'unknown',
          },
          'intake activity map: search failed',
        );
        return empty;
      }
    }),
  );
  if (civicGroup) {
    const free = groups.find((group) => group.category === 'free_public');
    if (free) {
      const room = MAX_MAP_ITEMS_PER_GROUP - free.lines.length;
      if (room > 0) {
        free.lines.push(...civicGroup.lines.slice(0, room));
        free.titles.push(...civicGroup.titles.slice(0, room));
      }
    } else {
      groups.push(civicGroup);
    }
  }
  const finder: ActivityMapFinder = anyUsed ? 'used' : anyFailed ? 'failed' : 'empty';
  console.info(
    {
      familyId: input.familyId,
      finder,
      groups: groups.filter((group) => group.lines.length > 0).length,
      lines: groups.reduce((sum, group) => sum + group.lines.length, 0),
    },
    'intake activity map',
  );
  return flatten(groups, finder);
}

/**
 * The stored shape of a map: a `[category]` marker line, then that group's
 * numbered lines, numbered across the whole map. Markers never go to the
 * parent. `linesOfFind` reads the numbered lines back; this reads the groups.
 */
export function renderActivityMapBody(map: Pick<ActivityMap, 'groups'>): string {
  const parts: string[] = [];
  let index = 0;
  for (const group of map.groups) {
    if (group.lines.length === 0) continue;
    parts.push(`[${group.category}]`);
    for (const line of group.lines) {
      index += 1;
      parts.push(`${index}. ${line}`);
    }
  }
  return parts.join('\n');
}

const MARKER = /^\[([a-z_]+)\]$/u;

/** Groups off a stored map body. A body with no markers is one unnamed group. */
export function groupsFromFindBody(findBody: string): ActivityMapGroup[] {
  const groups: ActivityMapGroup[] = [];
  let current: ActivityMapGroup | null = null;
  for (const raw of findBody.split('\n')) {
    const line = raw.trim();
    const marker = MARKER.exec(line);
    if (marker) {
      current = { category: marker[1] as ActivityCategoryId, lines: [], titles: [] };
      groups.push(current);
      continue;
    }
    const numbered = /^\d+\.\s+(.+)$/u.exec(line);
    if (!numbered?.[1]) continue;
    if (!current) {
      current = { category: 'learning_sports_arts', lines: [], titles: [] };
      groups.push(current);
    }
    current.lines.push(numbered[1]);
    current.titles.push(numbered[1].replace(/\s+\(.*$/u, '').trim());
  }
  return groups.filter((group) => group.lines.length > 0);
}
