import { describe, expect, it, vi } from 'vitest';
import { ensureActivityShareToken, ensureShareToken } from './share.js';

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_USER_ID = '55555555-5555-4555-8555-555555555555';
const PROPOSAL_ID = '44444444-4444-4444-8444-444444444444';
const EXISTING_TOKEN = 'already_shared_token';

interface ProposalRow {
  id: string;
  shareToken: string | null;
}

/**
 * Fakes the latest-proposal select chain plus update().set().where() and
 * insert().values() so the test exercises the token + audit logic without a real
 * db. `update`/`insert` record their calls for assertions.
 */
function fakeDb(rows: ProposalRow[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ orderBy, limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });

  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set });

  const values = vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn().mockReturnValue({ values });

  return {
    db: { select, update, insert } as never,
    spies: { select, update, set, updateWhere, insert, values },
  };
}

describe('ensureShareToken', () => {
  it('generates a base64url token, persists it, and writes the week_plan_shared audit row', async () => {
    const { db, spies } = fakeDb([{ id: PROPOSAL_ID, shareToken: null }]);

    const result = await ensureShareToken(db, { familyId: FAMILY_ID, actorUserId: ACTOR_USER_ID });

    expect(result).not.toBeNull();
    const token = result?.shareToken ?? '';
    // crypto.randomBytes(18).toString('base64url') → 24 url-safe chars, no padding.
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).toHaveLength(24);

    // Persisted to the proposal row.
    expect(spies.update).toHaveBeenCalledTimes(1);
    expect(spies.set).toHaveBeenCalledWith({ shareToken: token });

    // Rule #6: an immutable audit_log row for the share.
    expect(spies.insert).toHaveBeenCalledTimes(1);
    expect(spies.values).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: FAMILY_ID,
        actor: ACTOR_USER_ID,
        actionTaken: 'week_plan_shared',
        targetTable: 'routine_proposals',
        targetId: PROPOSAL_ID,
      }),
    );
  });

  it('is idempotent: a proposal that already has a token returns it unchanged, no update, no new audit row', async () => {
    const { db, spies } = fakeDb([{ id: PROPOSAL_ID, shareToken: EXISTING_TOKEN }]);

    const result = await ensureShareToken(db, { familyId: FAMILY_ID, actorUserId: ACTOR_USER_ID });

    expect(result?.shareToken).toBe(EXISTING_TOKEN);
    expect(spies.update).not.toHaveBeenCalled();
    expect(spies.insert).not.toHaveBeenCalled();
  });

  it('returns null when the family has no routine proposal to share', async () => {
    const { db, spies } = fakeDb([]);

    const result = await ensureShareToken(db, { familyId: FAMILY_ID, actorUserId: ACTOR_USER_ID });

    expect(result).toBeNull();
    expect(spies.update).not.toHaveBeenCalled();
    expect(spies.insert).not.toHaveBeenCalled();
  });
});

const CANDIDATE_ID = '99999999-9999-4999-8999-999999999999';
const OTHER_FAMILY_ID = '22222222-2222-4222-8222-222222222222';

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
