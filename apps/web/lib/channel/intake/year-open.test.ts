import { describe, expect, it, vi } from 'vitest';
import type { ActivityFinder } from '~/lib/channel/activity/lane';
import { YEAR_FIND_CAP, type WeekendPick } from './radar-decide';
import {
  YEAR_OPEN_LEAD,
  YEAR_OPEN_STILL_LOOKING,
  collectYearOpenLines,
  renderYearOpen,
  yearOpenEmptyMessage,
  yearOpenQuery,
} from './year-open';

const SEB = { name: 'Seb', ageMonths: 17 };

describe('yearOpenQuery', () => {
  it('asks for toddler programs in Halton Hills this year, with no child name', () => {
    const query = yearOpenQuery({ children: [SEB], areaCoarse: 'L7G' });
    expect(query.ok).toBe(true);
    if (!query.ok) return;
    expect(query.query.subject).toBe('programs for a toddler');
    expect(query.query.stage).toBe('toddler');
    expect(query.query.town).toBe('Halton Hills');
    expect(query.query.window).toBe('this year');
    expect(JSON.stringify(query.query)).not.toContain('Seb');
    expect(JSON.stringify(query.query)).not.toContain('17');
    expect(JSON.stringify(query.query)).not.toContain('L7G');
  });

  it('still builds a subject at the edges of 0-18', () => {
    const baby = yearOpenQuery({
      children: [{ name: 'Ada', ageMonths: 2 }],
      areaCoarse: 'M5V',
    });
    const teen = yearOpenQuery({
      children: [{ name: null, ageMonths: 200 }],
      areaCoarse: 'M5V',
    });
    expect(baby.ok && baby.query.subject).toBe('programs for a baby');
    expect(teen.ok && teen.query.subject).toBe('programs for a teenager');
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

  it('says it is still looking when nothing is in hand', () => {
    expect(yearOpenEmptyMessage()).toContain(YEAR_OPEN_STILL_LOOKING);
    expect(yearOpenEmptyMessage()).toContain('Your first weekend find lands in a day or two.');
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

  it('skips the search when two civic lines are already in hand', async () => {
    const find = vi.fn(finder.find.bind(finder));
    const opened = await collectYearOpenLines({
      civic: [pick('Story time'), pick('Music')],
      children: [SEB],
      areaCoarse: 'L7G',
      finder: { find },
      familyId: 'fam',
    });
    expect(find).not.toHaveBeenCalled();
    expect(opened.finder).toBe('skipped_enough');
    expect(opened.lines).toHaveLength(2);
    expect(opened.lines[0]).toContain('Story time');
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
    expect(info.mock.calls.map((call) => call.join(' ')).join('\n')).toContain(
      'skipped: not_configured',
    );
    info.mockRestore();
  });

  it('fills toward three and stops there', async () => {
    const opened = await collectYearOpenLines({
      civic: [pick('Story time')],
      children: [SEB],
      areaCoarse: 'L7G',
      finder,
      familyId: 'fam',
    });
    expect(opened.finder).toBe('used');
    expect(opened.lines).toHaveLength(3);
    expect(opened.lines[0]).toContain('Story time');
    expect(opened.lines[1]).toContain('Drop-in gym');
    expect(YEAR_FIND_CAP).toBe(3);
  });
});

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
