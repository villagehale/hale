import { describe, expect, it, vi } from 'vitest';
import { endorseVillageCandidate } from './endorse.js';

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_FAMILY_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '55555555-5555-4555-8555-555555555555';
const CANDIDATE_ID = '44444444-4444-4444-8444-444444444444';

interface CandidateRow {
  id: string;
  familyId: string;
}

/**
 * Fakes the chains endorseVillageCandidate runs, in call order:
 *   1. select candidate by id            → select().from().where().limit()
 *   2. insert endorsement (idempotent)   → insert().values().onConflictDoNothing().returning()
 *   3. (only on first endorse) insert audit row → insert().values()
 *   4. select count() of endorsements    → select().from().where()
 *
 * `insertedRows` controls whether the endorsement insert "won" (new row) or hit
 * the unique conflict (empty → already endorsed). `freshCount` is what the final
 * count query resolves.
 */
function fakeDb(opts: {
  candidate: CandidateRow | undefined;
  insertedRows: Array<{ id: string }>;
  freshCount: number;
}) {
  const candidateLimit = vi.fn().mockResolvedValue(opts.candidate ? [opts.candidate] : []);
  const countWhere = vi.fn().mockResolvedValue([{ value: opts.freshCount }]);

  let selectCall = 0;
  const select = vi.fn().mockImplementation(() => {
    const call = selectCall;
    selectCall += 1;
    if (call === 0) {
      // candidate lookup
      const where = vi.fn().mockReturnValue({ limit: candidateLimit });
      const from = vi.fn().mockReturnValue({ where });
      return { from };
    }
    // count() lookup
    const where = countWhere;
    const from = vi.fn().mockReturnValue({ where });
    return { from };
  });

  const returning = vi.fn().mockResolvedValue(opts.insertedRows);
  const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
  // The endorsement insert returns the conflict chain; the audit insert resolves
  // a bare promise. We distinguish by the table passed to insert().
  const auditValues = vi.fn().mockResolvedValue(undefined);
  const endorseValues = vi.fn().mockReturnValue({ onConflictDoNothing });
  const insert = vi.fn().mockImplementation(() => {
    // First insert call is the endorsement, second is the audit row.
    return insert.mock.calls.length === 1
      ? { values: endorseValues }
      : { values: auditValues };
  });

  return {
    db: { select, insert } as never,
    spies: { insert, endorseValues, auditValues, onConflictDoNothing },
  };
}

describe('endorseVillageCandidate — hybrid trust + audit (rule #6)', () => {
  it('records a first endorsement, writes the audit row, and returns the fresh count', async () => {
    const { db, spies } = fakeDb({
      candidate: { id: CANDIDATE_ID, familyId: FAMILY_ID },
      insertedRows: [{ id: 'endo-1' }],
      freshCount: 3,
    });

    const result = await endorseVillageCandidate(db, {
      candidateId: CANDIDATE_ID,
      familyId: FAMILY_ID,
      userId: USER_ID,
    });

    expect(result).toEqual({ status: 200, count: 3, alreadyEndorsed: false });
    // Two inserts: the endorsement, then the audit row.
    expect(spies.insert).toHaveBeenCalledTimes(2);
    expect(spies.auditValues).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: FAMILY_ID,
        actor: USER_ID,
        actionTaken: 'village_candidate_endorsed',
        targetTable: 'village_candidates',
        targetId: CANDIDATE_ID,
      }),
    );
  });

  it('is idempotent: a duplicate endorsement writes NO audit row and reports alreadyEndorsed', async () => {
    const { db, spies } = fakeDb({
      candidate: { id: CANDIDATE_ID, familyId: FAMILY_ID },
      insertedRows: [], // unique conflict → no new row
      freshCount: 3,
    });

    const result = await endorseVillageCandidate(db, {
      candidateId: CANDIDATE_ID,
      familyId: FAMILY_ID,
      userId: USER_ID,
    });

    expect(result).toEqual({ status: 200, count: 3, alreadyEndorsed: true });
    // Only the endorsement insert ran; the audit insert did NOT.
    expect(spies.insert).toHaveBeenCalledTimes(1);
    expect(spies.auditValues).not.toHaveBeenCalled();
  });

  it('returns 404 for a candidate that does not exist — no insert, no audit', async () => {
    const { db, spies } = fakeDb({
      candidate: undefined,
      insertedRows: [],
      freshCount: 0,
    });

    const result = await endorseVillageCandidate(db, {
      candidateId: CANDIDATE_ID,
      familyId: FAMILY_ID,
      userId: USER_ID,
    });

    expect(result).toEqual({ status: 404, error: 'candidate_not_found' });
    expect(spies.insert).not.toHaveBeenCalled();
  });

  it("returns 403 for another family's candidate — cannot pad another family's social proof", async () => {
    const { db, spies } = fakeDb({
      candidate: { id: CANDIDATE_ID, familyId: OTHER_FAMILY_ID },
      insertedRows: [],
      freshCount: 0,
    });

    const result = await endorseVillageCandidate(db, {
      candidateId: CANDIDATE_ID,
      familyId: FAMILY_ID,
      userId: USER_ID,
    });

    expect(result).toEqual({ status: 403, error: 'candidate_belongs_to_another_family' });
    expect(spies.insert).not.toHaveBeenCalled();
  });
});
