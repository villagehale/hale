import { describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@hale/db';
import { listSharedLinks, revokeShareLink } from './share-revoke';

/**
 * The shared-links list + Revoke (rules #1, #6). Revoke nulls the token, which is
 * the whole mechanism: every public loader resolves WHERE share_token = token, so a
 * nulled token resolves nothing and the public page fails closed. These tests drive
 * the fake db through the list (family-scoped, live tokens only) and the revoke
 * (nulls the token + audits when the family owns it; no write when it does not).
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_USER_ID = '55555555-5555-4555-8555-555555555555';
const PROPOSAL_ID = '22222222-2222-4222-8222-222222222222';
const CANDIDATE_ID = '33333333-3333-4333-8333-333333333333';

/** Fakes the two list selects (routine_proposals + village_candidates), keyed by
 *  the table the select reads from, plus update().set().where().returning() and
 *  insert().values() for revoke. Spies capture the SET payload + the audit insert. */
function fakeDb(config: {
  weekPlans?: Array<{ id: string; token: string | null; weekOf: string }>;
  activities?: Array<{ id: string; token: string | null; title: string }>;
  revokeReturns?: Array<{ token: string | null }>;
}) {
  const set = vi.fn();
  const values = vi.fn().mockResolvedValue(undefined);

  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          orderBy: async () =>
            table === schema.routineProposals ? (config.weekPlans ?? []) : (config.activities ?? []),
        }),
      }),
    }),
    update: () => ({
      set: (payload: unknown) => {
        set(payload);
        return { where: () => ({ returning: async () => config.revokeReturns ?? [] }) };
      },
    }),
    insert: () => ({ values }),
  };

  return { db: db as unknown as Database, spies: { set, values } };
}

describe('listSharedLinks', () => {
  it('returns live week-plan and activity links, labelled, newest first within each kind', async () => {
    const { db } = fakeDb({
      weekPlans: [{ id: PROPOSAL_ID, token: 'wtok', weekOf: '2026-07-06' }],
      activities: [{ id: CANDIDATE_ID, token: 'atok', title: 'Toddler music at the library' }],
    });

    const links = await listSharedLinks(db, FAMILY_ID);

    expect(links).toEqual([
      { kind: 'week_plan', id: PROPOSAL_ID, token: 'wtok', title: 'week of 2026-07-06' },
      { kind: 'activity', id: CANDIDATE_ID, token: 'atok', title: 'Toddler music at the library' },
    ]);
  });

  it('returns an empty list when the family has shared nothing', async () => {
    const { db } = fakeDb({});
    expect(await listSharedLinks(db, FAMILY_ID)).toEqual([]);
  });
});

describe('revokeShareLink', () => {
  it('nulls the week-plan token and writes the immutable audit row when the family owns it', async () => {
    const { db, spies } = fakeDb({ revokeReturns: [{ token: null }] });

    const ok = await revokeShareLink(db, {
      kind: 'week_plan',
      id: PROPOSAL_ID,
      familyId: FAMILY_ID,
      actorUserId: ACTOR_USER_ID,
    });

    expect(ok).toBe(true);
    expect(spies.set).toHaveBeenCalledWith({ shareToken: null });
    expect(spies.values).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: FAMILY_ID,
        actor: ACTOR_USER_ID,
        actionTaken: 'share_link_revoked',
        targetTable: 'routine_proposals',
        targetId: PROPOSAL_ID,
      }),
    );
  });

  it('nulls an activity token against the village_candidates table', async () => {
    const { db, spies } = fakeDb({ revokeReturns: [{ token: null }] });

    const ok = await revokeShareLink(db, {
      kind: 'activity',
      id: CANDIDATE_ID,
      familyId: FAMILY_ID,
      actorUserId: ACTOR_USER_ID,
    });

    expect(ok).toBe(true);
    expect(spies.values).toHaveBeenCalledWith(
      expect.objectContaining({ targetTable: 'village_candidates', targetId: CANDIDATE_ID }),
    );
  });

  it('is a no-op when no live link with that id belongs to the family — no audit row (rule #1)', async () => {
    // returning() empty = the WHERE (id + family + token IS NOT NULL) matched nothing.
    const { db, spies } = fakeDb({ revokeReturns: [] });

    const ok = await revokeShareLink(db, {
      kind: 'week_plan',
      id: PROPOSAL_ID,
      familyId: FAMILY_ID,
      actorUserId: ACTOR_USER_ID,
    });

    expect(ok).toBe(false);
    expect(spies.values).not.toHaveBeenCalled();
  });
});
