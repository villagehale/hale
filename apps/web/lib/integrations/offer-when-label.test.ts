import { describe, expect, it } from 'vitest';
import { offerWhenLabel } from './offer-when-label';

const NOW = new Date('2026-09-17T15:00:00.000Z');
const SUNDAY = new Date('2026-10-04T13:00:00.000Z');

describe('offerWhenLabel', () => {
  it('keeps the English label the receipts already copy', () => {
    expect(offerWhenLabel(SUNDAY, 'America/Toronto', NOW, 'en')).toBe('Sunday, Oct 4 at 9:00 a.m.');
  });

  it('renders French in fr-CA and folds the accent a month cannot send', () => {
    expect(offerWhenLabel(SUNDAY, 'America/Toronto', NOW, 'fr')).toBe('dimanche 4 oct. à 9 h');
    expect(offerWhenLabel(new Date('2026-10-04T13:30:00.000Z'), 'America/Toronto', NOW, 'fr')).toBe(
      'dimanche 4 oct. à 9 h 30',
    );
    expect(offerWhenLabel(new Date('2026-08-01T13:00:00.000Z'), 'America/Toronto', NOW, 'fr')).toBe(
      'samedi 1 aout à 9 h',
    );
    expect(offerWhenLabel(new Date('2027-01-05T14:00:00.000Z'), 'America/Toronto', NOW, 'fr')).toBe(
      'mardi 5 janv. 2027 à 9 h',
    );
  });
});
