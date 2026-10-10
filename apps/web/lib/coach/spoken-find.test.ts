import { describe, expect, it } from 'vitest';
import { spokenFind } from './spoken-find';

describe('spokenFind', () => {
  it('keeps a programme title and a different place', () => {
    expect(spokenFind('Central Library story time', 'Bloor/Gladstone branch')).toEqual({
      title: 'Central Library story time',
      venue: 'Bloor/Gladstone branch',
    });
  });

  it('drops a venue the title already is, and a generic tail like visit', () => {
    expect(spokenFind('Riverdale Farm visit', 'Riverdale Farm')).toEqual({
      title: 'Riverdale Farm',
      venue: null,
    });
    expect(spokenFind('Riverdale Farm', 'Riverdale Farm')).toEqual({
      title: 'Riverdale Farm',
      venue: null,
    });
  });

  it('keeps a programme that already names its place, without a second venue', () => {
    expect(spokenFind('Toddler swim at the library', 'the library')).toEqual({
      title: 'Toddler swim at the library',
      venue: null,
    });
  });

  it('has no venue to repeat when the place is blank', () => {
    expect(spokenFind('High Park', '  ')).toEqual({ title: 'High Park', venue: null });
  });
});
