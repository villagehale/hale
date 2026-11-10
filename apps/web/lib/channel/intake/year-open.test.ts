import { describe, expect, it, vi } from 'vitest';
import { namesAVenue } from '~/lib/channel/activity/evidence';
import type { ActivityFinder, ActivityPick } from '~/lib/channel/activity/lane';
import { hasLinkShape } from '~/lib/format/link-shape';
import { ACTIVITY_CATEGORIES } from './activity-map';
import { WEEK_FIND_SUBJECT } from './first-touch-find';
import { type WeekendPick, YEAR_FIND_CAP } from './radar-decide';
import { YEAR_OPEN_SUBJECT, collectYearOpenLines, yearOpenQuery } from './year-open';

const SEB = { name: 'Seb', ageMonths: 17, dobPrecision: 'derived' as const };
const TODAY = '2026-11-08';

describe('the search seeds', () => {
  it('name no one province program, so a US or Alberta family gets its own', () => {
    const seeds = [
      YEAR_OPEN_SUBJECT,
      WEEK_FIND_SUBJECT,
      ...ACTIVITY_CATEGORIES.map((c) => c.subject),
    ];
    for (const seed of seeds) expect(seed).not.toMatch(/earlyon|ontario|toronto/i);
    expect(seeds.filter((seed) => seed.includes('library'))).toHaveLength(3);
  });
});

describe('yearOpenQuery', () => {
  it('asks for the kids year in Halton Hills, with the stage beside the subject', () => {
    const query = yearOpenQuery({ children: [SEB], town: 'Halton Hills' });
    expect(query.ok).toBe(true);
    if (!query.ok) return;
    expect(query.query.subject).toBe(YEAR_OPEN_SUBJECT);
    expect(YEAR_OPEN_SUBJECT.length).toBeLessThanOrEqual(120);
    expect(YEAR_OPEN_SUBJECT).toContain('examples not a limit');
    expect(namesAVenue(YEAR_OPEN_SUBJECT)).toBe(false);
    expect(query.query.stage).toBe('toddler');
    expect(query.query.town).toBe('Halton Hills, Ontario, Canada');
    expect(query.query.window).toBe('this year');
    expect(query.query.subject).not.toMatch(/toddler|baby|teenager|preschool/);
    expect(JSON.stringify(query.query)).not.toContain('Seb');
    expect(JSON.stringify(query.query)).not.toContain('17');
    expect(JSON.stringify(query.query)).not.toContain('L7G');
  });

  it('keeps the same subject at the edges of 0-18 and still names the stage', () => {
    const baby = yearOpenQuery({
      children: [{ name: 'Ada', ageMonths: 2 }],
      town: 'Toronto',
    });
    const teen = yearOpenQuery({
      children: [{ name: null, ageMonths: 200 }],
      town: 'Toronto',
    });
    expect(baby.ok && baby.query.subject).toBe(YEAR_OPEN_SUBJECT);
    expect(baby.ok && baby.query.stage).toBe('newborn');
    expect(teen.ok && teen.query.subject).toBe(YEAR_OPEN_SUBJECT);
    expect(teen.ok && teen.query.stage).toBe('teenager');
  });

  it('refuses with no place, so the year find never searches nowhere', () => {
    expect(yearOpenQuery({ children: [SEB], town: null })).toEqual({
      ok: false,
      reason: 'no_place',
    });
  });

  it('sends every household stage when siblings do not share one', () => {
    const query = yearOpenQuery({
      children: [SEB, { name: 'Jo', ageMonths: 96 }],
      town: 'Halton Hills',
    });
    expect(query.ok).toBe(true);
    if (!query.ok) return;
    expect(query.query.subject).toBe(YEAR_OPEN_SUBJECT);
    expect(query.query.stage).toBe('toddler');
    expect(query.query.stages).toEqual(['toddler', 'child']);
    expect(JSON.stringify(query.query)).not.toContain('Jo');
  });
});

describe('collectYearOpenLines', () => {
  const finder: ActivityFinder = {
    async find() {
      return {
        found: true,
        picks: [
          {
            name: 'Drop-in gym',
            ageFit: '1-2 years',
            when: 'Fridays',
            price: null,
            sourceName: 'Town',
            source: 'web',
          },
          {
            name: 'Second',
            ageFit: '1-2 years',
            when: null,
            price: null,
            sourceName: 'Town',
            source: 'web',
          },
          {
            name: 'Third',
            ageFit: '1-2 years',
            when: null,
            price: null,
            sourceName: 'Town',
            source: 'web',
          },
        ],
      };
    },
  };

  it('still searches when civic lines are already in hand', async () => {
    const find = vi.fn(async () => ({
      found: true as const,
      picks: [webPick('Parent and tot swim', '12-24 months')],
    }));
    const opened = await collectYearOpenLines({
      civic: [pick('Story time'), pick('Music')],
      children: [SEB],
      town: 'Halton Hills',
      finder: { find },
      familyId: 'fam',
      today: TODAY,
    });
    expect(find).toHaveBeenCalledOnce();
    expect(opened.finder).toBe('used');
    expect(opened.lines).toHaveLength(3);
    expect(opened.lines[0]).toContain('Parent and tot swim');
    expect(opened.lines.join('\n')).toContain('Story time');
    expect(opened.lines.join('\n')).toContain('Music');
    expect(opened.titles).toEqual(['Parent and tot swim', 'Story time', 'Music']);
  });

  it('drops a link-shaped word from a find line and keeps the rest of it', async () => {
    const find = vi.fn(async () => ({
      found: true as const,
      picks: [webPick('Kidsclub.ca Swim', '12-24 months')],
    }));
    const opened = await collectYearOpenLines({
      civic: [
        {
          ...pick('Story time'),
          candidateRef: { id: 's', title: 'Story time', venueName: 'Funhall.app Library' },
        },
      ],
      children: [SEB],
      town: 'Halton Hills',
      finder: { find },
      familyId: 'fam',
      today: TODAY,
    });
    expect(opened.lines).toHaveLength(2);
    expect(opened.lines[0]).toContain('Swim (12-24 months)');
    expect(opened.lines[1]).toContain('Story time at Library');
    for (const line of opened.lines) expect(hasLinkShape(line), line).toBe(false);
  });

  it('names a missing search instead of inventing a registration date', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const opened = await collectYearOpenLines({
      civic: [],
      children: [SEB],
      town: 'Halton Hills',
      finder: null,
      familyId: 'fam',
      today: TODAY,
    });
    expect(opened.finder).toBe('not_configured');
    expect(opened.lines).toEqual([]);
    expect(opened.titles).toEqual([]);
    expect(info.mock.calls.map((call) => call.join(' ')).join('\n')).toContain(
      'skipped: not_configured',
    );
    info.mockRestore();
  });

  it('fills toward three and stops there, live picks first', async () => {
    const opened = await collectYearOpenLines({
      civic: [pick('Story time')],
      children: [SEB],
      town: 'Halton Hills',
      finder,
      familyId: 'fam',
      today: TODAY,
    });
    expect(opened.finder).toBe('used');
    expect(opened.lines).toHaveLength(3);
    expect(opened.lines[0]).toContain('Drop-in gym');
    expect(opened.lines[1]).toContain('Second');
    expect(opened.lines.join('\n')).not.toContain('Story time');
    expect(opened.titles).toEqual(['Drop-in gym', 'Second', 'Third']);
    expect(YEAR_FIND_CAP).toBe(3);
  });

  it('leaves out a pick outside every child age and lets civic take its room', async () => {
    const opened = await collectYearOpenLines({
      civic: [pick('Story time')],
      children: [SEB],
      town: 'Halton Hills',
      finder: {
        async find() {
          return {
            found: true,
            picks: [
              webPick('U12 soccer tryouts', 'ages 8-12'),
              webPick('Parent and tot swim', '12-24 months'),
            ],
          };
        },
      },
      familyId: 'fam',
      today: TODAY,
    });
    // ages 8-12 is 96..144 months; 17 + 6 < 96.
    expect(opened.lines.map((line) => line.split(' (')[0])).toEqual([
      'Parent and tot swim',
      'Saturday: Story time',
    ]);
    expect(opened.titles).toEqual(['Parent and tot swim', 'Story time']);
    expect(opened.titles.join('\n')).not.toContain('Saturday:');
  });

  it('does not sink an older sibling behind the youngest stage', async () => {
    const opened = await collectYearOpenLines({
      civic: [],
      children: [SEB, { name: 'Jo', ageMonths: 96, dobPrecision: 'derived' }],
      town: 'Halton Hills',
      finder: {
        async find() {
          return {
            found: true,
            picks: [
              webPick('U12 soccer tryouts', 'ages 8-12'),
              webPick('Parent and tot swim', '12-24 months'),
            ],
          };
        },
      },
      familyId: 'fam',
      today: TODAY,
    });
    expect(opened.lines[0]).toContain('U12 soccer tryouts');
    expect(opened.lines[1]).toContain('Parent and tot swim');
  });

  it('keeps only picks whose age band holds a child, and logs the drop as a count', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const find = async () => ({
      found: true as const,
      picks: [
        webPick('Baby rhyme circle', 'Ages 0-1'),
        webPick('Toddler gym', '18 months - 3 years'),
        webPick('Family fair', 'All ages'),
      ],
    });
    const wren = { name: 'Wren', ageMonths: 18, dobPrecision: 'exact' as const };
    const exact = await collectYearOpenLines({
      civic: [],
      children: [wren],
      town: 'Toronto',
      finder: { find },
      familyId: 'fam',
      today: TODAY,
    });
    // Ages 0-1 is 0..12 months and 18 > 12.
    expect(exact.titles).toEqual(['Toddler gym', 'Family fair']);
    const logged = info.mock.calls.find((call) => call[1] === 'intake year find');
    expect(logged?.[0]).toEqual({ familyId: 'fam', picks: 3, droppedAge: 1, droppedPast: 0 });

    const derived = await collectYearOpenLines({
      civic: [],
      children: [{ ...wren, dobPrecision: 'derived' }],
      town: 'Toronto',
      finder: { find },
      familyId: 'fam',
      today: TODAY,
    });
    // 12 + 6 >= 18: a derived age keeps it.
    expect(derived.titles).toEqual(['Baby rhyme circle', 'Toddler gym', 'Family fair']);
    info.mockRestore();
  });

  it('leaves a past-dated pick and an Ages 0-1 pick out of the facts for an 18-month-old', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const opened = await collectYearOpenLines({
      civic: [],
      children: [{ name: 'Wren', ageMonths: 18, dobPrecision: 'exact' }],
      town: 'Toronto',
      finder: {
        async find() {
          return {
            found: true,
            picks: [
              { ...webPick('Spring egg hunt', '1-5 years'), when: 'Saturday, March 8, 2026' },
              webPick('Baby rhyme circle', 'Ages 0-1'),
              webPick('Lantern walk', 'All ages'),
            ],
          };
        },
      },
      familyId: 'fam',
      today: TODAY,
    });
    expect(opened.titles).toEqual(['Lantern walk']);
    expect(opened.lines.join('\n')).not.toMatch(/egg hunt|rhyme circle/i);
    const logged = info.mock.calls.find((call) => call[1] === 'intake year find');
    expect(logged?.[0]).toEqual({ familyId: 'fam', picks: 3, droppedAge: 1, droppedPast: 1 });
    info.mockRestore();
  });

  it('keeps a kind the subject never named', async () => {
    const opened = await collectYearOpenLines({
      civic: [],
      children: [SEB],
      town: 'Halton Hills',
      finder: {
        async find() {
          return { found: true, picks: [webPick('Lantern festival', 'all ages')] };
        },
      },
      familyId: 'fam',
      today: TODAY,
    });
    expect(opened.finder).toBe('used');
    expect(opened.lines).toHaveLength(1);
    expect(opened.lines[0]).toContain('Lantern festival');
    expect(YEAR_OPEN_SUBJECT).not.toContain('lantern');
  });
});

function webPick(name: string, ageFit: string): ActivityPick {
  return {
    name,
    ageFit,
    when: null,
    price: null,
    sourceName: 'Town',
    source: 'web',
  };
}

function pick(title: string): WeekendPick {
  return {
    candidateRef: { id: title, title, venueName: null },
    day: 'saturday',
    kidNames: [],
    whyFacts: [],
    access: 'unknown',
    when: null,
    verifiedUrl: null,
  };
}
