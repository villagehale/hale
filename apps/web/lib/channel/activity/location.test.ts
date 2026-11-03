import { describe, expect, it } from 'vitest';
import {
  activityLocationMatches,
  activitySourceLocationScore,
  qualifyActivityLocation,
} from './location';

describe('activity location evidence', () => {
  it.each([
    'Montréal, Québec, Canada',
    'Montréal (Québec) H2S 0C4',
    'Montreal (Quebec) H2S 0C4',
    'Montréal (QC) H2S 0C4',
    'Montre\u0301al (Que\u0301bec) H2S 0C4',
  ])('accepts a French Canadian address: %s', (address) => {
    expect(activityLocationMatches('Montréal, Quebec, Canada', address)).toBe(true);
  });

  it('qualifies an accented province without changing the city spelling', () => {
    expect(qualifyActivityLocation('Montréal', 'Québec')).toBe('Montréal, Quebec, Canada');
  });

  it.each([
    'Montréal (Ontario) Canada',
    'Montréal, Texas, United States',
    'NewMontréal (Québec) Canada',
    'Montréal — Québec history collection',
    'Ville de Montréal — Heure du conte (3 à 6 ans)',
  ])('does not loosen location proof for %s', (text) => {
    expect(activityLocationMatches('Montréal, Quebec, Canada', text)).toBe(false);
  });

  it('prioritizes regional source hints without treating a domain as location proof', () => {
    const town = 'Burlington, Ontario, Canada';
    expect(
      activitySourceLocationScore(town, 'https://attend.bpl.on.ca/event/123', 'Storytime'),
    ).toBeGreaterThan(
      activitySourceLocationScore(
        town,
        'https://burlington.librarycalendar.com/event/123',
        'Storytime',
      ),
    );
    expect(activityLocationMatches(town, 'Storytime on a Canadian website')).toBe(false);
  });
  it('keeps province and country in the search location', () => {
    expect(qualifyActivityLocation('Burlington', 'ON')).toBe('Burlington, Ontario, Canada');
    expect(qualifyActivityLocation('Burlington', 'VT', 'United States')).toBe(
      'Burlington, VT, United States',
    );
    expect(qualifyActivityLocation('Paris', null, 'France')).toBe('Paris, France');
    expect(qualifyActivityLocation('  ', 'ON', 'Canada')).toBe('');
  });

  it('rejects the actual Washington source for Burlington Ontario', () => {
    const wrongPage =
      'Burlington Public Library 820 E Washington Ave. Burlington , WA 98233 United States View on Google Maps';
    expect(activityLocationMatches('Burlington, Ontario, Canada', wrongPage)).toBe(false);
    expect(activityLocationMatches('Burlington, WA, United States', wrongPage)).toBe(true);
  });

  it.each([
    'Burlington, Ontario, Canada',
    '2331 New Street, Burlington, ON L7R 1J4',
    'Burlington, ON, L7R 1J4',
  ])('accepts a published Canadian address: %s', (address) => {
    expect(activityLocationMatches('Burlington, Ontario, Canada', address)).toBe(true);
  });

  it('does not accept a matching city plus unrelated province/country words', () => {
    expect(
      activityLocationMatches(
        'Burlington, Ontario, Canada',
        'Burlington, WA 98233 United States. Read on for our Canada and Ontario book collection.',
      ),
    ).toBe(false);
    expect(activityLocationMatches('Burlington, Ontario, Canada', 'Burlington on Wednesday')).toBe(
      false,
    );
    expect(activityLocationMatches('Burlington, Ontario, Canada', 'Burlington ON WEDNESDAY')).toBe(
      false,
    );
    expect(activityLocationMatches('Burlington, Ontario, Canada', 'NewBurlington, Ontario')).toBe(
      false,
    );
    expect(
      activityLocationMatches('Burlington, Ontario, Canada', 'Burlington, Quebec, Canada'),
    ).toBe(false);
  });

  it('holds a bare city or a source without published location evidence', () => {
    expect(activityLocationMatches('Burlington', 'Burlington Public Library')).toBe(false);
    expect(activityLocationMatches('Burlington, Ontario, Canada', 'Storytime for ages 3-6')).toBe(
      false,
    );
  });

  it('retains a nearby address in the correct province, including a village within a municipality', () => {
    expect(activityLocationMatches('Halton Hills, Ontario, Canada', 'Georgetown, ON L7G 4S6')).toBe(
      true,
    );
    expect(activityLocationMatches('Burlington, Ontario, Canada', 'Oakville, ON L6H 0H3')).toBe(
      true,
    );
    expect(activityLocationMatches('Burlington, Ontario, Canada', 'Victoria, BC V8W 1P6')).toBe(
      false,
    );
  });

  it('matches other explicit countries and rejects the same city abroad', () => {
    expect(activityLocationMatches('Paris, France', 'Paris, France')).toBe(true);
    expect(activityLocationMatches('Paris, France', 'Paris, Texas, United States')).toBe(false);
  });
});
