import { describe, expect, it, vi } from 'vitest';
import { namesAVenue } from '~/lib/channel/activity/evidence';
import type { ActivityFinder, ActivityPick } from '~/lib/channel/activity/lane';
import { type WeekendPick, YEAR_FIND_CAP } from './radar-decide';
import {
  YEAR_OPEN_EMPTY_BY_LANGUAGE,
  YEAR_OPEN_LEAD,
  YEAR_OPEN_SUBJECT,
  collectYearOpenLines,
  renderYearOpen,
  yearOpenEmptyMessage,
  yearOpenQuery,
} from './year-open';

const SEB = { name: 'Seb', ageMonths: 17 };

describe('yearOpenQuery', () => {
  it('asks for the kids year in Halton Hills, with the stage beside the subject', () => {
    const query = yearOpenQuery({ children: [SEB], areaCoarse: 'L7G' });
    expect(query.ok).toBe(true);
    if (!query.ok) return;
    expect(query.query.subject).toBe(YEAR_OPEN_SUBJECT);
    expect(YEAR_OPEN_SUBJECT.length).toBeLessThanOrEqual(120);
    expect(YEAR_OPEN_SUBJECT).toContain('examples not a limit');
    expect(namesAVenue(YEAR_OPEN_SUBJECT)).toBe(false);
    expect(query.query.stage).toBe('toddler');
    expect(query.query.town).toBe('Halton Hills');
    expect(query.query.window).toBe('this year');
    expect(query.query.subject).not.toMatch(/toddler|baby|teenager|preschool/);
    expect(JSON.stringify(query.query)).not.toContain('Seb');
    expect(JSON.stringify(query.query)).not.toContain('17');
    expect(JSON.stringify(query.query)).not.toContain('L7G');
  });

  it('keeps the same subject at the edges of 0-18 and still names the stage', () => {
    const baby = yearOpenQuery({
      children: [{ name: 'Ada', ageMonths: 2 }],
      areaCoarse: 'M5V',
    });
    const teen = yearOpenQuery({
      children: [{ name: null, ageMonths: 200 }],
      areaCoarse: 'M5V',
    });
    expect(baby.ok && baby.query.subject).toBe(YEAR_OPEN_SUBJECT);
    expect(baby.ok && baby.query.stage).toBe('newborn');
    expect(teen.ok && teen.query.subject).toBe(YEAR_OPEN_SUBJECT);
    expect(teen.ok && teen.query.stage).toBe('teenager');
  });

  it('sends every household stage when siblings do not share one', () => {
    const query = yearOpenQuery({
      children: [SEB, { name: 'Jo', ageMonths: 96 }],
      areaCoarse: 'L7G',
    });
    expect(query.ok).toBe(true);
    if (!query.ok) return;
    expect(query.query.subject).toBe(YEAR_OPEN_SUBJECT);
    expect(query.query.stage).toBe('toddler');
    expect(query.query.stages).toEqual(['toddler', 'child']);
    expect(JSON.stringify(query.query)).not.toContain('Jo');
  });
});

describe('renderYearOpen', () => {
  it('numbers at most three lines and never a registration date', () => {
    const message = renderYearOpen(['One', 'Two', 'Three', 'Four']);
    expect(message.startsWith(YEAR_OPEN_LEAD)).toBe(true);
    expect(message).toContain('1. One');
    expect(message).toContain('3. Three');
    expect(message).not.toContain('Four');
    expect(message).not.toMatch(/registration opens|registration opened/i);
    expect(message.toLowerCase()).not.toContain('activity finder');
  });

  it('says the locked empty line when nothing is in hand', () => {
    expect(yearOpenEmptyMessage()).toBe(YEAR_OPEN_EMPTY_BY_LANGUAGE.en);
    expect(yearOpenEmptyMessage('fr')).toBe(YEAR_OPEN_EMPTY_BY_LANGUAGE.fr);
    expect(yearOpenEmptyMessage()).not.toMatch(/registration opens|registration opened/i);
    expect(renderYearOpen([])).toBe(yearOpenEmptyMessage());
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
      areaCoarse: 'L7G',
      finder: { find },
      familyId: 'fam',
    });
    expect(find).toHaveBeenCalledOnce();
    expect(opened.finder).toBe('used');
    expect(opened.lines).toHaveLength(3);
    expect(opened.lines[0]).toContain('Parent and tot swim');
    expect(opened.lines.join('\n')).toContain('Story time');
    expect(opened.lines.join('\n')).toContain('Music');
    expect(opened.titles).toEqual(['Parent and tot swim', 'Story time', 'Music']);
  });

  it('names a missing search instead of inventing a registration date', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const opened = await collectYearOpenLines({
      civic: [],
      children: [SEB],
      areaCoarse: 'L7G',
      finder: null,
      familyId: 'fam',
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
      areaCoarse: 'L7G',
      finder,
      familyId: 'fam',
    });
    expect(opened.finder).toBe('used');
    expect(opened.lines).toHaveLength(3);
    expect(opened.lines[0]).toContain('Drop-in gym');
    expect(opened.lines[1]).toContain('Second');
    expect(opened.lines.join('\n')).not.toContain('Story time');
    expect(opened.titles).toEqual(['Drop-in gym', 'Second', 'Third']);
    expect(YEAR_FIND_CAP).toBe(3);
  });

  it('ranks a stage fit first and still keeps another category', async () => {
    const opened = await collectYearOpenLines({
      civic: [pick('Story time')],
      children: [SEB],
      areaCoarse: 'L7G',
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
    });
    expect(opened.lines.map((line) => line.split(' (')[0])).toEqual([
      'Parent and tot swim',
      'Saturday: Story time',
      'U12 soccer tryouts',
    ]);
    expect(opened.titles).toEqual(['Parent and tot swim', 'Story time', 'U12 soccer tryouts']);
    expect(opened.titles.join('\n')).not.toContain('Saturday:');
  });

  it('does not sink an older sibling behind the youngest stage', async () => {
    const opened = await collectYearOpenLines({
      civic: [],
      children: [SEB, { name: 'Jo', ageMonths: 96 }],
      areaCoarse: 'L7G',
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
    });
    expect(opened.lines[0]).toContain('U12 soccer tryouts');
    expect(opened.lines[1]).toContain('Parent and tot swim');
  });

  it('keeps a kind the subject never named', async () => {
    const opened = await collectYearOpenLines({
      civic: [],
      children: [SEB],
      areaCoarse: 'L7G',
      finder: {
        async find() {
          return { found: true, picks: [webPick('Lantern festival', 'all ages')] };
        },
      },
      familyId: 'fam',
    });
    expect(opened.finder).toBe('used');
    expect(opened.lines).toHaveLength(1);
    expect(opened.lines[0]).toContain('Lantern festival');
    expect(YEAR_OPEN_SUBJECT).not.toContain('lantern');
  });

  it('says nothing only when the search fails and civic has nothing', async () => {
    const opened = await collectYearOpenLines({
      civic: [],
      children: [SEB],
      areaCoarse: 'L7G',
      finder: {
        async find() {
          return { found: false, reason: 'no_picks' };
        },
      },
      familyId: 'fam',
    });
    expect(opened.finder).toBe('empty');
    expect(opened.lines).toEqual([]);
    expect(opened.titles).toEqual([]);
    expect(renderYearOpen(opened.lines)).toBe(yearOpenEmptyMessage());
  });

  it('keeps civic lines when the search throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const opened = await collectYearOpenLines({
      civic: [pick('Story time')],
      children: [SEB],
      areaCoarse: 'L7G',
      finder: {
        async find() {
          throw new Error('ground_failed');
        },
      },
      familyId: 'fam',
    });
    expect(opened.finder).toBe('failed');
    expect(opened.lines).toHaveLength(1);
    expect(opened.lines[0]).toContain('Story time');
    expect(renderYearOpen(opened.lines)).not.toBe(yearOpenEmptyMessage());
    error.mockRestore();
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
