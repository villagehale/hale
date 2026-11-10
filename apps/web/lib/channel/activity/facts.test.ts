import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type RawActivityFact,
  activityCalendarDate,
  activityDateRange,
  bindActivityFacts,
} from './facts';

const now = new Date('2026-10-15T16:00:00Z');
const url = 'https://venue.example/programs?topic=kids#sessions';
const text =
  'Leaf Workshop, ages 2-5. October 16, 2026, 10:30-11:30. October 21, 2026, 09:30-10:30. Regular hours: 10:30-11:30. Cost: $20 per child plus mandatory $2 fee. Register. Indoors.';
const pages = [{ url, text }];
const raw = {
  name: 'Leaf Workshop',
  source_name: 'Example Centre',
  source_url: url,
  name_evidence: 'Leaf Workshop, ages 2-5.',
  age_fit: 'ages 2-5',
  age_evidence: 'Leaf Workshop, ages 2-5.',
  sessions: [
    {
      date: '2026-10-16',
      start_time: '10:30',
      end_time: '11:30',
      evidence: 'October 16, 2026, 10:30-11:30.',
    },
    {
      date: '2026-10-21',
      start_time: '09:30',
      end_time: '10:30',
      evidence: 'October 21, 2026, 09:30-10:30.',
    },
  ],
  price: '$20 per child plus mandatory $2 fee',
  price_evidence: 'Cost: $20 per child plus mandatory $2 fee.',
  access: 'register_at_venue' as const,
  indoor_outdoor: 'indoor' as const,
};
const bind = (items: RawActivityFact[] = [raw], window: string | null = 'October 2026') =>
  bindActivityFacts(items, pages, window, now);

describe('activity facts stay attached to their source', () => {
  it('recovers the recorded Georgetown schedules without recommending the infant-only group', () => {
    const recorded = JSON.parse(
      readFileSync(
        new URL(
          '../../../../worker/evals/cache/1db45bf8408a049f988e34d017eab151e71bf2dd7358ac2509bd9f7ae8323bb1.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ).value.picks as RawActivityFact[];
    const sourcePages = JSON.parse(
      readFileSync(
        new URL(
          '../../../../worker/evals/cache/5a611b43417951f5effe5c3a82fc0829ac768584abd9a472ef027d1c8b4ad45e.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ).pages as { url: string; text: string }[];
    const result = bindActivityFacts(recorded, sourcePages, null, now, undefined, undefined, [
      'toddler',
    ]);
    expect(recorded).toHaveLength(3);
    expect(result.picks.map((pick) => pick.name)).toEqual([recorded[0]?.name, recorded[1]?.name]);
    expect(result.picks[0]?.when).toBe(recorded[0]?.when_evidence);
    expect(result.picks[1]?.when).toBe(recorded[1]?.when_evidence);
    expect(result.picks[0]?.age_fit).toBe(recorded[0]?.age_evidence);
    expect(result.references).toEqual([
      expect.objectContaining({
        name: recorded[2]?.name,
        ageFit: recorded[2]?.age_evidence,
        status: 'unconfirmed',
      }),
    ]);
  });
  it('uses the published age wording and retains incompatible or unknown age as a reference', () => {
    for (const age of ['ages 6-8 years', 'babies from birth until they begin to crawl']) {
      const item = { ...raw, age_fit: 'ages 2-5', age_evidence: age };
      const result = bindActivityFacts(
        [item],
        [{ url, text: `${text} ${age}` }],
        'October 2026',
        now,
        undefined,
        undefined,
        ['toddler'],
      );
      expect(result.picks).toEqual([]);
      expect(result.references[0]).toMatchObject({ ageFit: age, status: 'unconfirmed' });
    }
  });
  it('accepts an explicitly stated mixed-unit band for a matching household stage', () => {
    const age = '19 months to 3 years';
    const item = { ...raw, age_evidence: age };
    const result = bindActivityFacts(
      [item],
      [{ url, text: `${text} ${age}` }],
      'October 2026',
      now,
      undefined,
      undefined,
      ['preschool', 'toddler'],
    );
    expect(result.picks[0]?.age_fit).toBe(age);
    expect(result.references).toEqual([]);
  });
  it.each(['All ages welcome', 'Ages 2+', '2 and up', '18 months and older'])(
    'retains explicit universal or minimum-age eligibility: %s',
    (age) => {
      const item = { ...raw, age_evidence: age };
      const result = bindActivityFacts(
        [item],
        [{ url, text: `${text} ${age}` }],
        'October 2026',
        now,
        undefined,
        undefined,
        ['toddler'],
      );
      expect(result.picks[0]?.age_fit).toBe(age);
    },
  );
  it('does not move a quoted past-year session into the model supplied current year', () => {
    const evidence = 'October 16, 2020, 10:30-11:30.';
    const item = { ...raw, sessions: [{ ...raw.sessions[0]!, evidence }] };
    const result = bindActivityFacts(
      [item],
      [{ url, text: `${text} ${evidence}` }],
      'October 2026',
      now,
    );
    expect(result.picks).toEqual([]);
    expect(result.references[0]).toMatchObject({ when: null, status: 'unconfirmed' });
  });
  it('does not offer regular hours for a requested window that has already ended', () => {
    const item = {
      ...raw,
      sessions: [],
      when: '10:30-11:30',
      schedule_kind: 'hours' as const,
      when_evidence: 'Regular hours: 10:30-11:30.',
    };
    const result = bindActivityFacts([item], pages, 'October 1 to 10, 2026', now);
    expect(result.picks).toEqual([]);
    expect(result.references[0]).toMatchObject({ when: item.when_evidence, status: 'unconfirmed' });
    const trip = bindActivityFacts([item], pages, 'October 1 to 10', now, undefined, {
      start: '2026-10-01',
      end: '2026-10-10',
    });
    expect(trip.picks).toEqual([]);
    expect(trip.references[0]?.status).toBe('unconfirmed');
  });
  it('uses existing trip dates without guessing a year from its scrubbed window', () => {
    const range = { start: '2026-10-16', end: '2026-10-17' };
    expect(activityDateRange('October 16 to 17', now, undefined, range)).toEqual(range);
    const result = bindActivityFacts([raw], pages, 'October 16 to 17', now, undefined, range);
    expect(result.picks[0]?.when).toBe('2026-10-16 10:30–11:30');
    expect(result.references).toEqual([]);
    expect(activityDateRange(null, now, undefined, { ...range, end: '2026-02-31' })).toBeNull();
  });
  it('uses the saved calendar zone at a UTC date boundary without converting source times', () => {
    const boundary = new Date('2026-10-16T02:00:00Z');
    expect(activityCalendarDate(boundary, 'America/Toronto')).toBe('2026-10-15');
    expect(
      activityDateRange('this month', new Date('2026-11-01T02:00:00Z'), 'America/Toronto'),
    ).toEqual({ start: '2026-10-01', end: '2026-10-31' });
    expect(activityCalendarDate(boundary, 'invalid')).toBe('2026-10-16');
  });
  it('preserves independent sessions, source bytes, evidence and existing metadata', () => {
    const result = bind();
    expect(result.picks[0]).toMatchObject({
      source_url: url,
      access: 'register_at_venue',
      indoor_outdoor: 'indoor',
      when: '2026-10-16 10:30–11:30; 2026-10-21 09:30–10:30',
      price: raw.price_evidence,
    });
    expect(result.picks[0]?.evidence.age).toBe(raw.age_evidence);
    expect(result.references).toEqual([]);
  });
  it('rejects a made-up program passage or a source that was not read', () => {
    expect(bind([{ ...raw, name_evidence: 'Invented program' }]).picks).toEqual([]);
    expect(bind([{ ...raw, source_url: 'https://other.example/' }]).references).toEqual([]);
  });
  it('keeps an unknown-age program as a reference rather than claiming a fit', () => {
    const result = bind([{ ...raw, age_evidence: 'Not on this page' }]);
    expect(result.picks).toEqual([]);
    expect(result.references[0]).toMatchObject({
      ageFit: null,
      sourceUrl: url,
      status: 'unconfirmed',
    });
  });
  it('never turns a price without its actual quote into free', () => {
    expect(
      bind([{ ...raw, price: 'Free', price_evidence: 'Admission is free' }]).picks[0]?.price,
    ).toBeNull();
  });
  it.each(['Free', '$99', '$2', 'approximately US$15'])(
    'uses published price wording instead of a separately generated value (%s)',
    (price) => {
      expect(bind([{ ...raw, price }]).picks[0]?.price).toBe(raw.price_evidence);
    },
  );
  it('does not fall back to free-form when after rejecting invalid or out-of-month sessions', () => {
    for (const date of ['2020-10-16', '2026-11-16', '2026-02-31']) {
      const result = bind([
        { ...raw, when: 'October 16 at 10:30', sessions: [{ ...raw.sessions[0]!, date }] },
      ]);
      expect(result.picks).toEqual([]);
      expect(result.references[0]?.when).toBeNull();
    }
  });
  it('distinguishes archived evidence from a current program with an unknown schedule', () => {
    const evidence = 'October 16, 2020, 10:30-11:30.';
    const archived = bindActivityFacts(
      [{ ...raw, sessions: [{ ...raw.sessions[0]!, date: '2020-10-16', evidence }] }],
      [{ url, text: `${text} ${evidence}` }],
      'October 2026',
      now,
    );
    expect(archived.references[0]?.status).toBe('historical');
    const unknown = bind([{ ...raw, sessions: [] }]);
    expect(unknown.references[0]?.status).toBe('unconfirmed');
  });
  it('preserves explicitly evidenced regular hours without inventing dated sessions', () => {
    const regular = {
      ...raw,
      sessions: undefined,
      when: '10:30-11:30',
      schedule_kind: 'hours' as const,
      when_evidence: 'Regular hours: 10:30-11:30.',
    };
    expect(bind([regular], null).picks[0]?.when).toBe(regular.when_evidence);
  });
  it('never replaces a published recurring schedule with a model generated weekday', () => {
    const evidence = 'Mondays 10:30-11:30.';
    const regular = {
      ...raw,
      sessions: [],
      when: 'Fridays 10:30-11:30',
      schedule_kind: 'recurring' as const,
      when_evidence: evidence,
    };
    const result = bindActivityFacts([regular], [{ url, text: `${text} ${evidence}` }], null, now);
    expect(result.picks[0]?.when).toBe(evidence);
    expect(result.picks[0]?.when).not.toContain('Friday');
  });
  it('does not discard historical evidence or its existing attendance metadata', () => {
    const evidence = 'October 16, 2020, 10:30-11:30.';
    const archived = bindActivityFacts(
      [{ ...raw, sessions: [{ ...raw.sessions[0]!, date: '2020-10-16', evidence }] }],
      [{ url, text: `${text} ${evidence}` }],
      'October 2026',
      now,
    );
    expect(archived.references[0]).toMatchObject({
      status: 'historical',
      access: 'register_at_venue',
      indoorOutdoor: 'indoor',
      evidence: { sessions: [evidence] },
    });
  });
  it('does not call the previous UTC day historical without source-timezone evidence', () => {
    const result = bind([{ ...raw, sessions: [{ ...raw.sessions[0]!, date: '2026-10-14' }] }]);
    expect(result.references[0]?.status).toBe('unconfirmed');
  });
  it('does not infer current applicability from a free-form term range', () => {
    const result = bind([
      {
        ...raw,
        sessions: undefined,
        schedule_kind: 'term',
        when: 'October 16, 2026, 10:30-11:30.',
        when_evidence: 'October 16, 2026, 10:30-11:30.',
      },
    ]);
    expect(result.picks).toEqual([]);
    expect(result.references[0]?.when).toBe('October 16, 2026, 10:30-11:30.');
  });
  it.each([
    ['October 2026', { start: '2026-10-01', end: '2026-10-31' }],
    ['October 16 to 21, 2026', { start: '2026-10-16', end: '2026-10-21' }],
    ['2026-10-16 to 2026-10-21', { start: '2026-10-16', end: '2026-10-21' }],
    ['this month', { start: '2026-10-01', end: '2026-10-31' }],
    ['next month', { start: '2026-11-01', end: '2026-11-30' }],
    ['2026', { start: '2026-01-01', end: '2026-12-31' }],
    ['this fall', null],
    ['2026-10-21 to 2026-10-16', null],
    ['February 31, 2026', null],
    ['October 16 and 21, 2026', null],
    ['October 2026 or October 2027', null],
  ])('resolves only unambiguous date windows: %s', (window, expected) => {
    expect(activityDateRange(window, now)).toEqual(expected);
  });
  it('retains published sessions as unconfirmed references for an unresolved request window', () => {
    const result = bind([raw], 'this fall');
    expect(result.picks).toEqual([]);
    expect(result.references[0]).toMatchObject({
      when: '2026-10-16 10:30–11:30; 2026-10-21 09:30–10:30',
      evidence: { windowConfirmed: false },
    });
  });
});
