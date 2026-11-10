import { describe, expect, it } from 'vitest';
import { labelled, otherCountry } from './run-intake-ground-eval.mjs';

describe('intake-ground gates', () => {
  it('refuses a Canadian source for a US family, by host or by name', () => {
    expect(otherCountry('United States', 'Find care.', ['https://www.ontario.ca/page/x'])).toBe(
      'cites www.ontario.ca',
    );
    expect(otherCountry('United States', 'Call 811 any time.', [])).toBe('says "811"');
    expect(otherCountry('United States', 'Caring for Kids has a page.', [])).toBe(
      'says "Caring for Kids"',
    );
  });

  it('passes a US source that also covers Canada (positive control)', () => {
    expect(
      otherCountry(
        'United States',
        'Its directory lists providers in the United States and Canada.',
        ['https://postpartum.net/get-help/provider-directory/'],
      ),
    ).toBeNull();
  });

  it('refuses a US government source for a Canadian family', () => {
    expect(otherCountry('Canada', 'The CDC says two naps.', [])).toBe('says "CDC"');
    expect(otherCountry('Canada', 'Two naps.', ['https://www.cdc.gov/x'])).toBe(
      'cites www.cdc.gov',
    );
  });

  it('reads a heading or a list number as a label, and an answer as none', () => {
    expect(labelled('Research notes (Washington): 1. A line.')).toBe(true);
    expect(labelled('1. A line.')).toBe(true);
    expect(labelled('You can call the hotline any time.')).toBe(false);
    expect(labelled('NO CURRENT SOURCE')).toBe(false);
  });
});
