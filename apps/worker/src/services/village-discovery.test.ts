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
