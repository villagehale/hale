import { describe, expect, it, vi } from 'vitest';
import { ensureActivityShareToken } from './share.js';

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_USER_ID = '55555555-5555-4555-8555-555555555555';
const CANDIDATE_ID = '99999999-9999-4999-8999-999999999999';
const OTHER_FAMILY_ID = '22222222-2222-4222-8222-222222222222';
const EXISTING_TOKEN = 'already_shared_token';

interface CandidateRow {
  id: string;
  familyId: string;
  childId: string | null;
  shareToken: string | null;
}

/** Fakes the candidate lookup chain + update().set().where() + insert().values(). */
function fakeCandidateDb(rows: CandidateRow[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });

  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set });

  const values = vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn().mockReturnValue({ values });

  return { db: { select, update, insert } as never, spies: { update, set, insert, values } };
}

describe('ensureActivityShareToken — per-activity public card', () => {
  it('mints a token, persists it, and writes the village_activity_shared audit row', async () => {
    const { db, spies } = fakeCandidateDb([
      { id: CANDIDATE_ID, familyId: FAMILY_ID, childId: null, shareToken: null },
    ]);

    const result = await ensureActivityShareToken(db, {
      candidateId: CANDIDATE_ID,
      familyId: FAMILY_ID,
      actorUserId: ACTOR_USER_ID,
    });

    const token = 'shareToken' in result ? result.shareToken : '';
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).toHaveLength(24);
    expect(spies.update).toHaveBeenCalledTimes(1);
    expect(spies.set).toHaveBeenCalledWith({ shareToken: token });
    expect(spies.values).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: FAMILY_ID,
        actor: ACTOR_USER_ID,
        actionTaken: 'village_activity_shared',
        targetTable: 'village_candidates',
        targetId: CANDIDATE_ID,
      }),
    );
  });

  it('is idempotent: an already-tokened candidate returns it, no update, no new audit row', async () => {
    const { db, spies } = fakeCandidateDb([
      { id: CANDIDATE_ID, familyId: FAMILY_ID, childId: null, shareToken: EXISTING_TOKEN },
    ]);

    const result = await ensureActivityShareToken(db, {
      candidateId: CANDIDATE_ID,
      familyId: FAMILY_ID,
      actorUserId: ACTOR_USER_ID,
    });

    expect(result).toEqual({ shareToken: EXISTING_TOKEN });
    expect(spies.update).not.toHaveBeenCalled();
    expect(spies.insert).not.toHaveBeenCalled();
  });

  it('refuses a child-attributed candidate (rule #1) — never mints a public token', async () => {
    const { db, spies } = fakeCandidateDb([
      { id: CANDIDATE_ID, familyId: FAMILY_ID, childId: 'child-1', shareToken: null },
    ]);

    const result = await ensureActivityShareToken(db, {
      candidateId: CANDIDATE_ID,
      familyId: FAMILY_ID,
      actorUserId: ACTOR_USER_ID,
    });

    expect(result).toEqual({ error: 'candidate_belongs_to_another_family' });
    expect(spies.update).not.toHaveBeenCalled();
    expect(spies.insert).not.toHaveBeenCalled();
  });

  it("refuses another family's candidate (403) and a missing candidate (404)", async () => {
    const other = fakeCandidateDb([
      { id: CANDIDATE_ID, familyId: OTHER_FAMILY_ID, childId: null, shareToken: null },
    ]);
    expect(
      await ensureActivityShareToken(other.db, {
        candidateId: CANDIDATE_ID,
        familyId: FAMILY_ID,
        actorUserId: ACTOR_USER_ID,
      }),
    ).toEqual({ error: 'candidate_belongs_to_another_family' });

    const missing = fakeCandidateDb([]);
    expect(
      await ensureActivityShareToken(missing.db, {
        candidateId: CANDIDATE_ID,
        familyId: FAMILY_ID,
        actorUserId: ACTOR_USER_ID,
      }),
    ).toEqual({ error: 'candidate_not_found' });
  });
});
