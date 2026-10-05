import { describe, expect, it } from 'vitest';
import type { ActivityFinder, ActivityPick } from '~/lib/channel/activity/lane';
import {
  ACTIVITY_CATEGORIES,
  type ActivityCategoryId,
  MAX_MAP_GROUPS,
  MAX_MAP_ITEMS_PER_GROUP,
  categoriesForAges,
  collectActivityMap,
  groupsFromFindBody,
  renderActivityMapBody,
} from './activity-map';
import type { WeekendPick } from './radar-decide';

/**
 * Step 4 of onboarding: the broad map. Code picks the two or three categories
 * for the kids' ages and runs one real search each; the model only writes the
 * lead-ins. Nothing on the map exists that a search did not return.
 */

const FAMILY = 'family-1';

function pick(name: string, overrides: Partial<ActivityPick> = {}): ActivityPick {
  return {
    name,
    ageFit: 'ages 3-5',
    when: 'Saturdays 10am',
    price: '$12',
    sourceName: 'City of Toronto',
    source: 'web',
    ...overrides,
  };
}

function civic(title: string, venueName: string | null = 'Main Library'): WeekendPick {
  return {
    candidateRef: { id: `civic-${title}`, title, venueName },
    day: 'saturday',
    kidNames: [],
    whyFacts: [],
    access: 'drop_in',
    when: null,
    verifiedUrl: null,
  };
}

/** A finder that answers each category's subject with named picks, and records the queries. */
function finderWith(answers: Partial<Record<ActivityCategoryId, ActivityPick[]>>): {
  finder: ActivityFinder;
  subjects: string[];
} {
  const subjects: string[] = [];
  const finder: ActivityFinder = {
    async find(query) {
      subjects.push(query.subject);
      const category = ACTIVITY_CATEGORIES.find((row) => row.subject === query.subject);
      const picks = category ? answers[category.id] : undefined;
      if (!picks || picks.length === 0) return { found: false, reason: 'no_picks' };
      return { found: true, picks };
    },
  };
  return { finder, subjects };
}

describe('categoriesForAges', () => {
  it('covers every category Barton named', () => {
    expect(ACTIVITY_CATEGORIES.map((row) => row.id).sort()).toEqual(
      [
        'free_public',
        'language_culture',
        'learning_sports_arts',
        'music_dance',
        'outdoors',
        'parent_baby',
        'seasonal_outings',
        'social_growth',
        'swimming',
      ].sort(),
    );
  });

  it('leans on parent-and-baby groups, swimming and free facilities for a baby', () => {
    expect(categoriesForAges([8]).map((row) => row.id)).toEqual([
      'parent_baby',
      'swimming',
      'free_public',
    ]);
  });

  it('leans the same way for a toddler', () => {
    expect(categoriesForAges([20]).map((row) => row.id)).toEqual([
      'parent_baby',
      'swimming',
      'free_public',
    ]);
  });

  it('leads with learning, sports and arts for a preschooler', () => {
    const ids = categoriesForAges([50]).map((row) => row.id);
    expect(ids[0]).toBe('learning_sports_arts');
    expect(ids).toHaveLength(MAX_MAP_GROUPS);
    expect(ids).not.toContain('social_growth');
  });

  it('adds camps and after-school for a school-age kid', () => {
    const ids = categoriesForAges([8 * 12]).map((row) => row.id);
    expect(ids).toEqual(['learning_sports_arts', 'social_growth', 'swimming']);
    expect(ids).not.toContain('parent_baby');
  });

  it('shows at most three groups, never the whole catalogue', () => {
    expect(categoriesForAges([8, 50, 8 * 12, 15 * 12]).length).toBeLessThanOrEqual(MAX_MAP_GROUPS);
    expect(categoriesForAges([50], 9).length).toBe(MAX_MAP_GROUPS);
  });

  it('lets every child vote: a baby and a school-age kid both get a group', () => {
    const ids = categoriesForAges([8, 8 * 12]).map((row) => row.id);
    expect(ids).toContain('parent_baby');
    expect(ids).toContain('learning_sports_arts');
  });

  it('shows nothing for no ages', () => {
    expect(categoriesForAges([])).toEqual([]);
    expect(categoriesForAges([Number.NaN, -3])).toEqual([]);
  });
});

describe('collectActivityMap', () => {
  const kids = [{ name: 'Maya', ageMonths: 50 }];

  it('runs one real search per fitting category and keeps two or three results each', async () => {
    const { finder, subjects } = finderWith({
      learning_sports_arts: [
        pick('Swim'),
        pick('Soccer tots'),
        pick('Art class'),
        pick('Gymnastics'),
      ],
      swimming: [pick('Parent and tot swim', { price: null })],
      music_dance: [pick('Music together', { when: null })],
    });
    const map = await collectActivityMap({
      finder,
      children: kids,
      areaCoarse: 'M5V',
      civic: [],
      familyId: FAMILY,
    });
    expect(map.finder).toBe('used');
    expect(subjects).toHaveLength(MAX_MAP_GROUPS);
    expect(map.groups.map((group) => group.category)).toEqual([
      'learning_sports_arts',
      'swimming',
      'music_dance',
    ]);
    expect(map.groups[0]?.lines).toHaveLength(MAX_MAP_ITEMS_PER_GROUP);
    expect(map.groups[0]?.lines).not.toContain(expect.stringContaining('Gymnastics'));
    expect(map.groups[1]?.lines).toEqual(['Parent and tot swim (ages 3-5) - Saturdays 10am']);
    expect(map.groups[2]?.lines).toEqual(['Music together (ages 3-5) - $12']);
    expect(map.lines).toHaveLength(5);
    expect(map.titles).toEqual([
      'Swim',
      'Soccer tots',
      'Art class',
      'Parent and tot swim',
      'Music together',
    ]);
  });

  it('leaves a category off rather than filling it when its search found nothing', async () => {
    const { finder } = finderWith({ learning_sports_arts: [pick('Swim')] });
    const map = await collectActivityMap({
      finder,
      children: kids,
      areaCoarse: 'M5V',
      civic: [],
      familyId: FAMILY,
    });
    expect(map.groups.map((group) => group.category)).toEqual(['learning_sports_arts']);
    expect(map.lines).toEqual(['Swim (ages 3-5) - Saturdays 10am - $12']);
  });

  it('puts civic weekend finds under free and public, topping up to the cap', async () => {
    const { finder } = finderWith({
      parent_baby: [pick('EarlyON drop-in')],
      free_public: [pick('Free family swim'), pick('Open gym')],
    });
    const map = await collectActivityMap({
      finder,
      children: [{ name: 'Leo', ageMonths: 10 }],
      areaCoarse: 'M5V',
      civic: [civic('Story time'), civic('Baby rhyme time'), civic('Lego club')],
      familyId: FAMILY,
    });
    const free = map.groups.find((group) => group.category === 'free_public');
    expect(free?.lines).toHaveLength(MAX_MAP_ITEMS_PER_GROUP);
    expect(free?.lines.at(-1)).toBe('Saturday: Story time at Main Library');
    expect(free?.titles).toEqual(['Free family swim', 'Open gym', 'Story time']);
  });

  it('names a missing finder and still shows the civic finds it has (rule #11)', async () => {
    const map = await collectActivityMap({
      finder: null,
      children: kids,
      areaCoarse: 'M5V',
      civic: [civic('Story time')],
      familyId: FAMILY,
    });
    expect(map.finder).toBe('not_configured');
    expect(map.groups).toEqual([
      {
        category: 'free_public',
        lines: ['Saturday: Story time at Main Library'],
        titles: ['Story time'],
      },
    ]);
  });

  it('names a search that threw and keeps the groups that answered', async () => {
    const finder: ActivityFinder = {
      async find(query) {
        const category = ACTIVITY_CATEGORIES.find((row) => row.subject === query.subject);
        if (category?.id === 'learning_sports_arts') return { found: true, picks: [pick('Swim')] };
        throw new Error('upstream');
      },
    };
    const map = await collectActivityMap({
      finder,
      children: kids,
      areaCoarse: 'M5V',
      civic: [],
      familyId: FAMILY,
    });
    expect(map.finder).toBe('used');
    expect(map.lines).toEqual(['Swim (ages 3-5) - Saturdays 10am - $12']);

    const broken: ActivityFinder = {
      async find() {
        throw new Error('upstream');
      },
    };
    const none = await collectActivityMap({
      finder: broken,
      children: kids,
      areaCoarse: 'M5V',
      civic: [],
      familyId: FAMILY,
    });
    expect(none.finder).toBe('failed');
    expect(none.lines).toEqual([]);
  });

  it('is empty, not failed, when every search ran and found nothing', async () => {
    const { finder } = finderWith({});
    const map = await collectActivityMap({
      finder,
      children: kids,
      areaCoarse: 'M5V',
      civic: [],
      familyId: FAMILY,
    });
    expect(map.finder).toBe('empty');
    expect(map.groups).toEqual([]);
  });

  it("never puts a kid's name into a search", async () => {
    const seen: string[] = [];
    const finder: ActivityFinder = {
      async find(query) {
        seen.push(JSON.stringify(query));
        return { found: false, reason: 'no_picks' };
      },
    };
    await collectActivityMap({
      finder,
      children: [{ name: 'Maya', ageMonths: 50 }],
      areaCoarse: 'M5V',
      civic: [],
      familyId: FAMILY,
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.join(' ')).not.toMatch(/maya/i);
  });
});

describe('the stored map body', () => {
  it('renders markers and numbers across groups, and reads the groups back', () => {
    const body = renderActivityMapBody({
      groups: [
        { category: 'swimming', lines: ['Swim (ages 3-5) - Sat'], titles: ['Swim'] },
        {
          category: 'free_public',
          lines: ['Saturday: Story time at Main Library', 'Open gym (all ages)'],
          titles: ['Story time', 'Open gym'],
        },
        { category: 'outdoors', lines: [], titles: [] },
      ],
    });
    expect(body.split('\n')).toEqual([
      '[swimming]',
      '1. Swim (ages 3-5) - Sat',
      '[free_public]',
      '2. Saturday: Story time at Main Library',
      '3. Open gym (all ages)',
    ]);
    expect(groupsFromFindBody(body)).toEqual([
      { category: 'swimming', lines: ['Swim (ages 3-5) - Sat'], titles: ['Swim'] },
      {
        category: 'free_public',
        lines: ['Saturday: Story time at Main Library', 'Open gym (all ages)'],
        titles: ['Saturday: Story time at Main Library', 'Open gym'],
      },
    ]);
  });

  it('reads a flat numbered find as one unnamed group, so an older session still has a map', () => {
    expect(groupsFromFindBody('1. Swim (ages 3-5) - Saturday\n2. Story time - Tuesday')).toEqual([
      {
        category: 'learning_sports_arts',
        lines: ['Swim (ages 3-5) - Saturday', 'Story time - Tuesday'],
        titles: ['Swim', 'Story time - Tuesday'],
      },
    ]);
  });
});
