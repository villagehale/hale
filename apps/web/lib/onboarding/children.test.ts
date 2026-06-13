import { describe, expect, it } from 'vitest';
import { buildChildInserts, unionStages, validateChild } from './children.js';

/**
 * Expectations are hand-derived from STAGE_BOUNDARIES_MONTHS = [12, 48, 156]:
 *   newborn <12mo, toddler 12–47mo, child 48–155mo, teenager 156mo+;
 *   18y = 216mo ceiling. `now` is pinned to 2026-06-15 so every age is exact.
 * Birthdates use a day-15 birth so anniversaries land cleanly.
 */
const NOW = new Date(2026, 5, 15); // 2026-06-15
const FAMILY_ID = '11111111-1111-4111-8111-111111111111';

describe('validateChild', () => {
  it('rejects a blank name', () => {
    const result = validateChild({ name: '   ', dateOfBirth: '2026-01-15' }, NOW);
    expect(result).toEqual({ ok: false, error: 'name_required' });
  });

  it('rejects a missing birthdate', () => {
    const result = validateChild({ name: 'Maya', dateOfBirth: '' }, NOW);
    expect(result).toEqual({ ok: false, error: 'dob_required' });
  });

  it('rejects a malformed birthdate', () => {
    expect(validateChild({ name: 'Maya', dateOfBirth: '15/01/2026' }, NOW).ok).toBe(false);
    expect(validateChild({ name: 'Maya', dateOfBirth: '2026-02-30' }, NOW)).toEqual({
      ok: false,
      error: 'dob_invalid',
    });
  });

  it('rejects a future birthdate (one day after now)', () => {
    const result = validateChild({ name: 'Maya', dateOfBirth: '2026-06-16' }, NOW);
    expect(result).toEqual({ ok: false, error: 'dob_future' });
  });

  it('accepts a birthdate of exactly today (0mo → newborn)', () => {
    const result = validateChild({ name: 'Maya', dateOfBirth: '2026-06-15' }, NOW);
    expect(result).toEqual({
      ok: true,
      child: { name: 'Maya', dateOfBirth: '2026-06-15', stage: 'newborn' },
    });
  });

  it('rejects a child past the 18-year ceiling (216mo: born 2008-06-15)', () => {
    // 2008-06-15 → exactly 216mo on 2026-06-15 → at/over the ceiling.
    const result = validateChild({ name: 'Older', dateOfBirth: '2008-06-15' }, NOW);
    expect(result).toEqual({ ok: false, error: 'dob_too_old' });
  });

  it('accepts a 17-year-old just under the ceiling (born 2008-07-15 → teenager)', () => {
    const result = validateChild({ name: 'Teen', dateOfBirth: '2008-07-15' }, NOW);
    expect(result).toEqual({
      ok: true,
      child: { name: 'Teen', dateOfBirth: '2008-07-15', stage: 'teenager' },
    });
  });

  it('derives each stage at its lower boundary', () => {
    // 2025-06-15 = 12mo → toddler; 2022-06-15 = 48mo → child; 2013-06-15 = 156mo → teenager.
    expect((validateChild({ name: 'a', dateOfBirth: '2025-06-15' }, NOW) as { child: { stage: string } }).child.stage).toBe('toddler');
    expect((validateChild({ name: 'b', dateOfBirth: '2022-06-15' }, NOW) as { child: { stage: string } }).child.stage).toBe('child');
    expect((validateChild({ name: 'c', dateOfBirth: '2013-06-15' }, NOW) as { child: { stage: string } }).child.stage).toBe('teenager');
  });

  it('trims the name', () => {
    const result = validateChild({ name: '  Maya  ', dateOfBirth: '2026-01-15' }, NOW);
    expect(result.ok && result.child.name).toBe('Maya');
  });
});

describe('unionStages', () => {
  it('newborn + teenager dedupes and orders by childhood', () => {
    const stages = unionStages([{ stage: 'teenager' }, { stage: 'newborn' }, { stage: 'newborn' }]);
    expect(stages).toEqual(['newborn', 'teenager']);
  });

  it('spans all four when each is present, in childhood order', () => {
    const stages = unionStages([
      { stage: 'child' },
      { stage: 'teenager' },
      { stage: 'newborn' },
      { stage: 'toddler' },
    ]);
    expect(stages).toEqual(['newborn', 'toddler', 'child', 'teenager']);
  });

  it('is empty for no children', () => {
    expect(unionStages([])).toEqual([]);
  });
});

describe('buildChildInserts', () => {
  it('scopes each child to the family and writes only name + date_of_birth (no stage)', () => {
    const inserts = buildChildInserts(FAMILY_ID, [
      { name: 'Maya', dateOfBirth: '2026-01-15' },
      { name: 'Theo', dateOfBirth: '2013-06-15' },
    ]);
    expect(inserts).toEqual([
      { familyId: FAMILY_ID, name: 'Maya', dateOfBirth: '2026-01-15' },
      { familyId: FAMILY_ID, name: 'Theo', dateOfBirth: '2013-06-15' },
    ]);
  });
});
