import type { FamilyStage } from '@hale/types';
import { describe, expect, it, vi } from 'vitest';
import type { DiscoveryProvider } from '../agents/discovery-providers/types.js';
import { runVillageDiscovery, selectDiscoveryInputs } from './village-discovery.js';

/**
 * FIX 1 (rule #1): a teen child must never reach village discovery. Teens are
 * excluded at the source — no teen stage is queried and no teen-only interest
 * enters the candidate pool — and a teen-only family produces no public
 * candidates or routine at all.
 *
 * Hard rule #8: the LLM is never mocked. The teen-only path skips routine
 * generation entirely (no candidates, nothing to arrange), so no Anthropic call
 * is made. The stage/interest selection is a pure function, tested directly.
 */

function dobForStage(stage: FamilyStage, now = new Date('2026-06-17T00:00:00.000Z')): string {
  const yearsAgo: Record<FamilyStage, number> = {
    newborn: 0,
    toddler: 2,
    preschool: 4,
    child: 7,
    teenager: 15,
  };
  const d = new Date(now);
  d.setFullYear(d.getFullYear() - yearsAgo[stage]);
  return d.toISOString().slice(0, 10);
}

const NOW = new Date('2026-06-17T00:00:00.000Z');

describe('selectDiscoveryInputs (FIX 1, rule #1)', () => {
  it('excludes the teen stage and teen-only interests for a teen + toddler family', () => {
    const result = selectDiscoveryInputs(
      [
        { dateOfBirth: dobForStage('teenager', NOW), interests: ['coding', 'volunteering'] },
        { dateOfBirth: dobForStage('toddler', NOW), interests: ['swimming', 'music'] },
      ],
      NOW,
    );

    expect(result.stages).toEqual(['toddler']);
    expect(result.stages).not.toContain('teenager');
    expect([...result.interests].sort()).toEqual(['music', 'swimming']);
    expect(result.interests).not.toContain('coding');
    expect(result.interests).not.toContain('volunteering');
  });

  it('returns empty stages and interests for a teen-only family', () => {
    const result = selectDiscoveryInputs(
      [{ dateOfBirth: dobForStage('teenager', NOW), interests: ['coding'] }],
      NOW,
    );

    expect(result.stages).toEqual([]);
    expect(result.interests).toEqual([]);
  });

  /**
   * VIL-266 — discovery runs once per stage, so the age it carries must belong to
   * a child IN that stage. A single family-wide age would hand the school-age run
   * a preschooler's age, which is the bug this ticket exists to remove.
   */
  // Explicit day-1 birthdates rather than dobForStage: its whole-year arithmetic
  // lands a "4-year-old" exactly ON the 48-month anniversary, where a one-day
  // timezone shift flips preschool to toddler. Day-1 births clear every boundary.
  const PRESCHOOL_DOB = '2022-06-01'; // 48mo at NOW
  const SCHOOL_AGE_DOB = '2019-06-01'; // 84mo at NOW
  const TODDLER_DOB = '2024-06-01'; // 24mo at NOW

  it('pairs every stage with the age of its own youngest child', () => {
    const result = selectDiscoveryInputs(
      [
        { dateOfBirth: SCHOOL_AGE_DOB, interests: [] },
        { dateOfBirth: PRESCHOOL_DOB, interests: [] },
      ],
      NOW,
    );

    expect([...result.ageMonthsByStage.keys()].sort()).toEqual(['child', 'preschool']);
    expect(result.ageMonthsByStage.get('preschool')).toBe(48);
    expect(result.ageMonthsByStage.get('child')).toBe(84);
  });

  it('keeps the age map keyed 1:1 with stages so a per-stage run can never miss one', () => {
    const result = selectDiscoveryInputs(
      [
        { dateOfBirth: TODDLER_DOB, interests: [] },
        { dateOfBirth: PRESCHOOL_DOB, interests: [] },
        { dateOfBirth: dobForStage('teenager', NOW), interests: [] },
      ],
      NOW,
    );

    expect([...result.ageMonthsByStage.keys()]).toEqual(result.stages);
    expect(result.ageMonthsByStage.has('teenager')).toBe(false);
  });

  it('reports the YOUNGEST age when two children share a stage', () => {
    const result = selectDiscoveryInputs(
      [
        { dateOfBirth: '2021-06-01', interests: [] }, // 60mo → child
        { dateOfBirth: '2018-06-01', interests: [] }, // 96mo → child
      ],
      NOW,
    );

    expect(result.stages).toEqual(['child']);
    expect(result.ageMonthsByStage.get('child')).toBe(60);
  });
});

interface FakeRow {
  [key: string]: unknown;
}

/**
 * Fakes the two select chains runVillageDiscovery runs (families row, then
 * children rows) and exposes the insert spy, so a skipped run can be asserted to
 * write nothing. Mirrors the public.test fakeDb shape.
 */
function fakeDb(familyRows: FakeRow[], childRows: FakeRow[]) {
  let call = 0;
  const select = vi.fn().mockImplementation(() => {
    const rows = call === 0 ? familyRows : childRows;
    call += 1;
    const limit = vi.fn().mockResolvedValue(rows);
    // The families query ends in .limit(); the children query awaits .where()
    // directly, so make the where() result both awaitable and .limit()-able.
    const whereResolvable = Object.assign(Promise.resolve(rows), { limit });
    const from = vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue(whereResolvable) });
    return { from };
  });
  const insert = vi.fn().mockReturnValue({
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'x' }]),
  });
  return { db: { select, insert } as never, insert };
}

describe('runVillageDiscovery (FIX 1, rule #1)', () => {
  it('writes no candidates or routine for a teen-only family (no LLM call)', async () => {
    const { db, insert } = fakeDb(
      [{ areaCoarse: 'M4L' }],
      [{ dateOfBirth: dobForStage('teenager', NOW), interests: ['coding'] }],
    );

    const spyProvider: DiscoveryProvider = {
      name: 'spy',
      discover: vi.fn().mockResolvedValue([]),
    };

    await runVillageDiscovery(
      { familyId: '11111111-1111-4111-8111-111111111111', weekOf: '2026-06-15' },
      db,
      { provider: spyProvider },
    );

    expect(spyProvider.discover).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
});
