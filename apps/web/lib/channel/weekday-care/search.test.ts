import type { Municipality } from '@hale/db';
import { describe, expect, it } from 'vitest';
import type { ActivityFinder, ActivityPick } from '~/lib/channel/activity/lane';
import { groundUserMessage } from '~/lib/channel/activity/lane';
import { buildWeekdayActivityQuery, runWeekdaySearch } from './search';

const NOW = new Date('2026-09-22T14:00:00.000Z');
const TZ = 'America/Toronto';

function finder(result: Awaited<ReturnType<ActivityFinder['find']>>): ActivityFinder & {
  queries: unknown[];
} {
  const queries: unknown[] = [];
  return {
    queries,
    async find(query) {
      queries.push(query);
      return result;
    },
  };
}

const PICK: ActivityPick = {
  name: 'Armour Heights after school',
  ageFit: 'ages 6-12',
  when: 'Tuesdays at 3:30pm',
  price: null,
  sourceName: 'Toronto Parks',
  source: 'web',
};

describe('buildWeekdayActivityQuery', () => {
  it('sends stage, town, and the date, and never a name or an exact age', () => {
    const built = buildWeekdayActivityQuery({
      children: [{ stage: 'child', interests: ['swimming'] }],
      municipality: 'toronto' as Municipality,
      now: NOW,
      timeZone: TZ,
      householdNames: ['Maya', 'Ana'],
      prompt: 'after_school',
    });
    if (!built.ok) throw new Error(built.reason);
    expect(built.query.stage).toBe('child');
    expect(built.query.town).toBe('Toronto');
    expect(built.query.subject).toBe('after-school activities (swimming)');
    expect(built.query.window).toBe('weekdays in September');
    const json = JSON.stringify(built.query);
    expect(json).not.toContain('Maya');
    expect(json).not.toContain('Ana');
    expect(json).not.toMatch(/\b102\b/);
    expect(groundUserMessage(built.query)).not.toContain('Maya');
  });

  it('passes every stage band when the household is mixed, and still no teen name', () => {
    const built = buildWeekdayActivityQuery({
      children: [
        { stage: 'toddler', interests: [] },
        { stage: 'teenager', interests: ['Ava soccer'] },
      ],
      municipality: null,
      now: NOW,
      timeZone: TZ,
      householdNames: ['Mia', 'Ava'],
      prompt: 'weekend_fallback',
    });
    if (!built.ok) throw new Error(built.reason);
    expect(built.query.stage).toBeNull();
    expect(built.query.stages).toEqual(['toddler', 'teenager']);
    expect(JSON.stringify(built.query)).not.toContain('Ava');
    expect(JSON.stringify(built.query)).not.toContain('Mia');
    expect(groundUserMessage(built.query)).toContain('"stages":["toddler","teenager"]');
  });

  it('uses the verified break date as availability and does not invent a category list', () => {
    const built = buildWeekdayActivityQuery({
      children: [{ stage: 'child', interests: [] }],
      municipality: 'toronto' as Municipality,
      now: NOW,
      timeZone: TZ,
      householdNames: [],
      prompt: 'break',
      breakDate: '2026-10-09',
    });
    if (!built.ok) throw new Error(built.reason);
    expect(built.query.subject).toBe('nearby activities');
    expect(built.query.window).toBe('during the break in October');
    expect(JSON.stringify(built.query)).not.toContain('2026-10-09');
    expect(built.query.subject).not.toContain('sports');
    expect(built.query.subject).not.toContain('tutoring');
  });
});

describe('runWeekdaySearch', () => {
  it('delivers only a grounded pick and hands the de-identified query to the finder', async () => {
    const search = finder({ found: true, picks: [PICK] });
    const built = buildWeekdayActivityQuery({
      children: [{ stage: 'child', interests: [] }],
      municipality: 'toronto' as Municipality,
      now: NOW,
      timeZone: TZ,
      householdNames: ['Maya'],
      prompt: 'after_school',
    });
    if (!built.ok) throw new Error(built.reason);

    const delivery = await runWeekdaySearch(search, built.query, ['Maya']);

    expect(search.queries).toEqual([built.query]);
    expect(delivery.status).toBe('deliver');
    if (delivery.status !== 'deliver') return;
    expect(delivery.body).toContain('Armour Heights after school');
    expect(delivery.body).toContain('Toronto Parks');
    expect(delivery.body).toContain('ages 6-12');
    expect(delivery.body).toContain('Tuesdays at 3:30pm');
    expect(delivery.body).not.toContain('Maya');
  });

  it('abstains when the search finds nothing, and does not invent a venue', async () => {
    const search = finder({ found: false, reason: 'no_picks' });
    const delivery = await runWeekdaySearch(
      search,
      { subject: 'after-school activities', window: null, town: null, stage: 'child' },
      [],
    );
    expect(delivery).toEqual({ status: 'abstain', reason: 'no_picks' });
  });

  it('abstains when the only pick names someone in the household', async () => {
    const search = finder({
      found: true,
      picks: [{ ...PICK, name: 'Maya dance' }],
    });
    const delivery = await runWeekdaySearch(
      search,
      { subject: 'after-school activities', window: null, town: null, stage: 'child' },
      ['Maya'],
    );
    expect(delivery).toEqual({ status: 'abstain', reason: 'not_deliverable' });
  });

  it('abstains when the search was not grounded', async () => {
    const search = finder({ found: false, reason: 'not_grounded' });
    const delivery = await runWeekdaySearch(
      search,
      { subject: 'weekday activities', window: null, town: null, stage: null },
      [],
    );
    expect(delivery).toEqual({ status: 'abstain', reason: 'not_grounded' });
  });
});
