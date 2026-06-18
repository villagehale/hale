import { describe, expect, it, vi } from 'vitest';
import { ensureShareToken } from './share.js';

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
