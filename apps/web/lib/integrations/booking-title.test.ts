import { describe, expect, it } from 'vitest';
import { bookingDedupeKey, bookingTitlesMatch, canonicalBookingTitle } from './booking';

describe('canonicalBookingTitle', () => {
  it('folds case and whitespace', () => {
    expect(canonicalBookingTitle('  swim   LEVEL 2 ')).toBe('swim level 2');
  });

  it('expands a weekday abbreviation and does not merge different classes', () => {
    expect(canonicalBookingTitle('Parent and Tot (Tues)')).toBe('parent and tot tuesday');
    expect(bookingTitlesMatch('Parent and Tot Tues', 'Parent and Tot Tuesday')).toBe(true);
    expect(bookingTitlesMatch('Swim Level 2', 'Swim Level 1')).toBe(false);
    expect(bookingTitlesMatch('Art Tues', 'Art Thursday')).toBe(false);
    expect(bookingTitlesMatch('Swim Level 2', 'Swim Level 2 Tuesday')).toBe(false);
    expect(bookingTitlesMatch('---', 'Swim Level 2')).toBe(false);
  });
});

describe('bookingDedupeKey', () => {
  const first = new Date('2026-09-26T13:00:00.000Z');

  it('is the host, the canonical title, and the UTC date', () => {
    const key = bookingDedupeKey({
      providerHost: 'Recreation.Northwind.Example',
      title: 'Tadpole Swim (Tues)',
      firstSessionAt: first,
    });
    expect(key).toBe('recreation.northwind.example|tadpole swim tuesday|2026-09-26');
    expect(
      bookingDedupeKey({
        providerHost: 'recreation.northwind.example',
        title: 'Tadpole Swim Tuesday',
        firstSessionAt: new Date('2026-09-26T13:30:00.000Z'),
      }),
    ).toBe(key);
  });

  it('does not fold a different day or a different class into the same key', () => {
    const base = {
      providerHost: 'recreation.northwind.example',
      title: 'Tadpole Swim',
      firstSessionAt: first,
    };
    const key = bookingDedupeKey(base);
    expect(
      bookingDedupeKey({ ...base, firstSessionAt: new Date('2026-09-27T13:00:00.000Z') }),
    ).not.toBe(key);
    expect(bookingDedupeKey({ ...base, title: 'Otter Swim' })).not.toBe(key);
    expect(bookingDedupeKey({ ...base, title: '   ' })).toBeNull();
  });
});
