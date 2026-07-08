import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { toggleVillageSave } from './save.js';

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_FAMILY_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '55555555-5555-4555-8555-555555555555';
const CANDIDATE_ID = '44444444-4444-4444-8444-444444444444';
const TEEN_CHILD_ID = '77777777-7777-4777-8777-777777777777';
// Born > 13y ago → deriveStage === 'teenager'.
const TEEN_DOB = '2009-01-01';

interface CandidateRow {
  id: string;
  familyId: string;
  childId?: string | null;
}

/**
 * Fakes the chains toggleVillageSave runs, in call order:
 *   1. select candidate by id                → select(villageCandidates).from().where().limit()
 *   (teen candidate only:)
 *   1b. select child DOB                      → select(children).from().where().limit()
 *   1c. select existing save row              → select(villageSaves).from().where().limit()
 *       (present → allowed unsave; absent → 403 refuse the create)
 *   2. insert save (idempotent, non-teen)     → insert().values().onConflictDoNothing().returning()
 *   3a. (fresh save)  insert audit row        → insert().values()
 *   3b. (unsave)      delete().where()  then  insert audit row
 *
 * `insertedRows` controls whether the save insert "won" (new row → SAVE) or hit the
 * unique conflict (empty → the family already saved it → this tap is an UNSAVE). The
 * select mock keys on the queried table so the teen-path lookups return their own rows.
 */
function fakeDb(opts: {
  candidate: CandidateRow | undefined;
  insertedRows: Array<{ id: string }>;
  childDob?: string;
  existingSaveRows?: Array<{ id: string }>;
}) {
  const select = vi.fn().mockImplementation((projection?: Record<string, unknown>) => {
    const from = vi.fn().mockImplementation((table: unknown) => {
      let rows: unknown[] = [];
      if (table === schema.villageCandidates) rows = opts.candidate ? [opts.candidate] : [];
      else if (table === schema.children)
        rows = opts.childDob ? [{ dateOfBirth: opts.childDob }] : [];
      else if (table === schema.villageSaves) rows = opts.existingSaveRows ?? [];
      const limit = vi.fn().mockResolvedValue(rows);
      const where = vi.fn().mockReturnValue({ limit });
      return { where };
    });
    void projection;
    return { from };
  });

  const returning = vi.fn().mockResolvedValue(opts.insertedRows);
  const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
  const auditValues = vi.fn().mockResolvedValue(undefined);
  const saveValues = vi.fn().mockReturnValue({ onConflictDoNothing });
  const insert = vi.fn().mockImplementation((table: unknown) =>
    table === schema.villageSaves ? { values: saveValues } : { values: auditValues },
  );

  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  const del = vi.fn().mockReturnValue({ where: deleteWhere });

  return {
    db: { select, insert, delete: del } as never,
    spies: { insert, saveValues, auditValues, del, deleteWhere },
  };
}

describe('toggleVillageSave — private bookmark + audit (rule #6)', () => {
  it('a first tap SAVES: inserts the row, audits village_candidate_saved, returns saved:true', async () => {
    const { db, spies } = fakeDb({
      candidate: { id: CANDIDATE_ID, familyId: FAMILY_ID },
      insertedRows: [{ id: 'save-1' }],
    });

    const result = await toggleVillageSave(db, {
      candidateId: CANDIDATE_ID,
      familyId: FAMILY_ID,
      userId: USER_ID,
    });

    expect(result).toEqual({ status: 200, saved: true });
    expect(spies.del).not.toHaveBeenCalled();
    expect(spies.auditValues).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: FAMILY_ID,
        actor: USER_ID,
        actionTaken: 'village_candidate_saved',
        targetTable: 'village_candidates',
        targetId: CANDIDATE_ID,
      }),
    );
  });

  it('a second tap UNSAVES: the insert conflicts, the row is deleted, audits village_candidate_unsaved, returns saved:false', async () => {
    const { db, spies } = fakeDb({
      candidate: { id: CANDIDATE_ID, familyId: FAMILY_ID },
      insertedRows: [], // unique conflict → already saved → this is an unsave
    });

    const result = await toggleVillageSave(db, {
      candidateId: CANDIDATE_ID,
      familyId: FAMILY_ID,
      userId: USER_ID,
    });

    expect(result).toEqual({ status: 200, saved: false });
    // The delete ran, and the unsave is audited too (rule #6: both directions).
    expect(spies.del).toHaveBeenCalledTimes(1);
    expect(spies.auditValues).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: FAMILY_ID,
        actor: USER_ID,
        actionTaken: 'village_candidate_unsaved',
        targetTable: 'village_candidates',
        targetId: CANDIDATE_ID,
      }),
    );
  });

  it('returns 404 for a candidate that does not exist — no insert, no delete, no audit', async () => {
    const { db, spies } = fakeDb({ candidate: undefined, insertedRows: [] });

    const result = await toggleVillageSave(db, {
      candidateId: CANDIDATE_ID,
      familyId: FAMILY_ID,
      userId: USER_ID,
    });

    expect(result).toEqual({ status: 404, error: 'candidate_not_found' });
    expect(spies.insert).not.toHaveBeenCalled();
    expect(spies.del).not.toHaveBeenCalled();
  });

  it("returns 403 for another family's candidate — cannot bookmark another family's discovery", async () => {
    const { db, spies } = fakeDb({
      candidate: { id: CANDIDATE_ID, familyId: OTHER_FAMILY_ID },
      insertedRows: [],
    });

    const result = await toggleVillageSave(db, {
      candidateId: CANDIDATE_ID,
      familyId: FAMILY_ID,
      userId: USER_ID,
    });

    expect(result).toEqual({ status: 403, error: 'candidate_belongs_to_another_family' });
    expect(spies.insert).not.toHaveBeenCalled();
    expect(spies.del).not.toHaveBeenCalled();
  });

  it('refuses a NEW save of a teen-attributed candidate (rule #1 backstop) — no insert, no save row created', async () => {
    // Own family, but the candidate is tied to a 13+ child → deriveStage teenager.
    // A direct POST must not create a teen save even though the UI hides the surface.
    const { db, spies } = fakeDb({
      candidate: { id: CANDIDATE_ID, familyId: FAMILY_ID, childId: TEEN_CHILD_ID },
      insertedRows: [],
      childDob: TEEN_DOB,
      existingSaveRows: [], // not currently saved → this is a CREATE, which is blocked
    });

    const result = await toggleVillageSave(db, {
      candidateId: CANDIDATE_ID,
      familyId: FAMILY_ID,
      userId: USER_ID,
    });

    expect(result).toEqual({ status: 403, error: 'candidate_teen_redacted' });
    expect(spies.insert).not.toHaveBeenCalled();
    expect(spies.del).not.toHaveBeenCalled();
  });

  it('still ALLOWS unsaving a teen-attributed candidate saved before the child turned 13 (never stuck)', async () => {
    // The gate blocks only the CREATE direction. An existing save row → the tap is
    // an unsave: delete it + audit, so a row saved pre-13 can always be removed.
    const { db, spies } = fakeDb({
      candidate: { id: CANDIDATE_ID, familyId: FAMILY_ID, childId: TEEN_CHILD_ID },
      insertedRows: [],
      childDob: TEEN_DOB,
      existingSaveRows: [{ id: 'save-1' }],
    });

    const result = await toggleVillageSave(db, {
      candidateId: CANDIDATE_ID,
      familyId: FAMILY_ID,
      userId: USER_ID,
    });

    expect(result).toEqual({ status: 200, saved: false });
    expect(spies.del).toHaveBeenCalledTimes(1);
    // No new save row is ever inserted for a teen candidate.
    expect(spies.saveValues).not.toHaveBeenCalled();
    expect(spies.auditValues).toHaveBeenCalledWith(
      expect.objectContaining({ actionTaken: 'village_candidate_unsaved' }),
    );
  });
});
