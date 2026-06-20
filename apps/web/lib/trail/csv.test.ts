import { describe, expect, it } from 'vitest';
import type { TrailView } from '~/lib/dashboard/mappers';
import { TRAIL_CSV_HEADER, trailToCsv } from './csv';

function entry(overrides: Partial<TrailView> = {}): TrailView {
  return {
    id: 'a',
    time: '14:05',
    category: 'actions',
    tone: 'done',
    actor: 'hale',
    summary: 'booked the 6-month checkup',
    detail: 'actions · 123',
    ...overrides,
  };
}

describe('trailToCsv', () => {
  it('emits the header then one quoted row per entry, in order', () => {
    const csv = trailToCsv([entry({ id: '1' }), entry({ id: '2', actor: 'you', time: '09:30' })]);
    const lines = csv.split('\n');
    expect(lines[0]).toBe(TRAIL_CSV_HEADER.join(','));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('"14:05","hale","actions","booked the 6-month checkup","actions · 123"');
    expect(lines[2]).toBe('"09:30","you","actions","booked the 6-month checkup","actions · 123"');
  });

  it('escapes embedded quotes by doubling and keeps commas inside the quoted cell', () => {
    const csv = trailToCsv([entry({ summary: 'said "hi, there"', detail: 'a, b, c' })]);
    const row = csv.split('\n')[1];
    expect(row).toContain('"said ""hi, there"""');
    expect(row).toContain('"a, b, c"');
  });

  it('exports only what it is given (the visible rows) — empty in, header only out', () => {
    expect(trailToCsv([])).toBe(TRAIL_CSV_HEADER.join(','));
  });
});
