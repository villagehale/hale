import { describe, expect, it } from 'vitest';
import type { TrailView } from '~/lib/dashboard/mappers';
import { TRAIL_CSV_HEADER, trailToCsv } from './csv';

function entry(overrides: Partial<TrailView> = {}): TrailView {
  return {
    id: 'a',
    time: '14:05',
    date: 'Thursday, Jun 11',
    dayKey: '2026-06-11',
    tone: 'done',
    actor: 'hale',
    summary: 'carried out the action',
    noun: 'draft',
    link: '/approvals',
    childLabel: null,
    ...overrides,
  };
}

describe('trailToCsv', () => {
  it('emits the header then one quoted row per entry, in order, with the full day', () => {
    const csv = trailToCsv([entry({ id: '1' }), entry({ id: '2', actor: 'you', time: '09:30' })]);
    const lines = csv.split('\n');
    expect(lines[0]).toBe(TRAIL_CSV_HEADER.join(','));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(
      '"Thursday, Jun 11","14:05","hale","draft","carried out the action","/approvals"',
    );
    expect(lines[2]).toBe(
      '"Thursday, Jun 11","09:30","you","draft","carried out the action","/approvals"',
    );
  });

  it('leaves the link cell empty (never a raw id) when a row has no deep link', () => {
    const row = trailToCsv([entry({ noun: 'signal', link: null })]).split('\n')[1];
    expect(row).toBe(
      '"Thursday, Jun 11","14:05","hale","signal","carried out the action",""',
    );
  });

  it('escapes embedded quotes by doubling and keeps commas inside the quoted cell', () => {
    const csv = trailToCsv([entry({ summary: 'said "hi, there"' })]);
    const row = csv.split('\n')[1];
    expect(row).toContain('"said ""hi, there"""');
  });

  it('exports only what it is given (the visible rows) — empty in, header only out', () => {
    expect(trailToCsv([])).toBe(TRAIL_CSV_HEADER.join(','));
  });
});
