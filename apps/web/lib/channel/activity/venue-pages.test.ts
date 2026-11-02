import { describe, expect, it } from 'vitest';
import type { FollowUpPick } from './followup-note';
import {
  ACTIVITY_HELD_TOPIC,
  OUTBOUND_TEXT_MAX,
  attachNamedVenueLinks,
  heldOptionsNote,
  venuePage,
  withVenuePages,
} from './venue-pages';

const US = 'https://www.ymca.org/youth-programs';
const CA = 'https://haltonhillsgymnastics.ca/programs';
const RETIRED = `https://app.villagehale.com/${'a'}/tok3n`;

function pick(over: Partial<FollowUpPick> & { sourceUrl?: string } = {}): FollowUpPick & {
  sourceUrl?: string;
} {
  return {
    name: 'Halton Hills Gymnastics',
    ageFit: '18 months - 3 years',
    when: 'Saturdays 9:15',
    price: '$142',
    sourceName: 'Halton Hills Gymnastics Centre',
    source: 'web',
    ...over,
  };
}

describe('venue pages', () => {
  it('appends a US page and a Canadian page, and never a retired Hale share address', () => {
    const body = withVenuePages('Halton Hills Gymnastics runs Saturdays.', [CA, US, RETIRED]);
    expect(body).toContain(CA);
    expect(body).toContain(US);
    expect(body).not.toContain('villagehale.com');
    expect(body.endsWith(US)).toBe(true);
  });

  it('reads the deep citation ahead of a shallow url', () => {
    expect(venuePage({ sourceUrl: CA, url: US })).toBe(CA);
    expect(venuePage({ url: US })).toBe(US);
    expect(venuePage({ sourceUrl: 'javascript:alert(1)' })).toBeNull();
    expect(venuePage({ url: RETIRED })).toBeNull();
  });

  it('drops a whole page rather than cutting one to fit the text cap', () => {
    const room = OUTBOUND_TEXT_MAX - 1 - CA.length;
    const body = 'x'.repeat(room);
    const fitted = withVenuePages(body, [CA, US]);
    expect(fitted).toContain(CA);
    expect(fitted).not.toContain(US);
    expect(fitted.length).toBeLessThanOrEqual(OUTBOUND_TEXT_MAX);
  });

  it('remembers held options as JSON, whole options only', () => {
    const note = heldOptionsNote([
      pick({ name: 'Mini Gym, Cartwheels Gym Centre', sourceUrl: CA }),
      pick({ name: 'Tumble, Cartwheels Gym Centre', url: US }),
    ]);
    expect(note).not.toBeNull();
    const parsed = JSON.parse(note ?? '{}') as {
      unsent_activity_options: { name: string; source_url: string }[];
    };
    expect(parsed.unsent_activity_options.map((option) => option.source_url)).toEqual([CA, US]);
    expect(ACTIVITY_HELD_TOPIC).toBe('activity_held');
  });

  it('keeps source evidence in the private held-options note', () => {
    const evidence = {
      program: 'Mini Gym',
      age: 'ages 2-5',
      sessions: ['October 23 at 10:30'],
      schedule: null,
      price: null,
      history: null,
      windowConfirmed: true,
    };
    const note = heldOptionsNote([pick({ sourceUrl: CA, evidence })]);
    expect(JSON.parse(note ?? '{}').unsent_activity_options[0]).toMatchObject({
      source_url: CA,
      evidence,
    });
  });

  it('appends a venue page only when the reply names that option in full', () => {
    const held = [
      { name: 'Mini Gym, Cartwheels Gym Centre', source_url: CA },
      { name: 'Gym', source_url: US },
    ];
    expect(attachNamedVenueLinks('What about Mini Gym?', held)).toBe('What about Mini Gym?');
    const named = attachNamedVenueLinks(
      'Mini Gym, Cartwheels Gym Centre is Mondays at 10:15.',
      held,
    );
    expect(named).toContain(CA);
    expect(named).not.toContain(US);
    expect(attachNamedVenueLinks(`Already linked.\n${CA}`, held)).toBe(`Already linked.\n${CA}`);
  });
});
