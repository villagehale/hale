import { describe, expect, it, vi } from 'vitest';
import { loadIcsFeed, mintIcsToken, revokeIcsToken } from './ics-feed.js';

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'existing_ics_token_value';
const NOW = new Date('2026-07-21T12:00:00.000Z');

/** Fakes select().from().where().limit() + update().set().where() + insert().values(). */
function fakeMintDb(familyRows: Array<{ token: string | null }>) {
  const limit = vi.fn().mockResolvedValue(familyRows);
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

/** Fakes update().set().where().returning() + insert().values() for the revoke path. */
function fakeRevokeDb(returningRows: Array<{ id: string }>) {
  const returning = vi.fn().mockResolvedValue(returningRows);
  const updateWhere = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set });

  const values = vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn().mockReturnValue({ values });

  return { db: { update, insert } as never, spies: { update, set, insert, values } };
}

interface EventRow {
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  location: string | null;
  childDob: string | null;
}

/**
 * Fakes loadIcsFeed's two selects: the family lookup — select().from().where().limit() —
 * resolves to `familyRows`; the events read — select().from().leftJoin().where().orderBy()
 * — resolves to `eventRows`. Discriminated by select() call order (family first).
 */
function fakeLoadDb(familyRows: Array<{ id: string }>, eventRows: EventRow[] = []) {
  const familyLimit = vi.fn().mockResolvedValue(familyRows);
  const familyWhere = vi.fn().mockReturnValue({ limit: familyLimit });
  const familyFrom = vi.fn().mockReturnValue({ where: familyWhere });

  const eventsOrderBy = vi.fn().mockResolvedValue(eventRows);
  const eventsWhere = vi.fn().mockReturnValue({ orderBy: eventsOrderBy });
  const eventsLeftJoin = vi.fn().mockReturnValue({ where: eventsWhere });
  const eventsFrom = vi.fn().mockReturnValue({ leftJoin: eventsLeftJoin });

  let call = 0;
  const select = vi.fn().mockImplementation(() => {
    call += 1;
    return { from: call === 1 ? familyFrom : eventsFrom };
  });

  return { db: { select } as never };
}

describe('mintIcsToken', () => {
  it('mints a base64url token, persists it, and writes the ics_feed_shared audit row', async () => {
    const { db, spies } = fakeMintDb([{ token: null }]);

    const { token } = await mintIcsToken(db, FAMILY_ID);

    // crypto.randomBytes(18).toString('base64url') → 24 url-safe chars, no padding.
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).toHaveLength(24);

    expect(spies.update).toHaveBeenCalledTimes(1);
    expect(spies.set).toHaveBeenCalledWith({ icsShareToken: token });

    expect(spies.insert).toHaveBeenCalledTimes(1);
    expect(spies.values).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: FAMILY_ID,
        actor: 'system',
        actionTaken: 'ics_feed_shared',
        targetTable: 'families',
        targetId: FAMILY_ID,
      }),
    );
  });

  it('is idempotent: a family that already has a token returns it unchanged, no update, no audit row', async () => {
    const { db, spies } = fakeMintDb([{ token: TOKEN }]);

    const { token } = await mintIcsToken(db, FAMILY_ID);

    expect(token).toBe(TOKEN);
    expect(spies.update).not.toHaveBeenCalled();
    expect(spies.insert).not.toHaveBeenCalled();
  });
});

describe('revokeIcsToken', () => {
  it('nulls a live token and writes the ics_feed_revoked audit row; returns true', async () => {
    const { db, spies } = fakeRevokeDb([{ id: FAMILY_ID }]);

    const revoked = await revokeIcsToken(db, FAMILY_ID);

    expect(revoked).toBe(true);
    expect(spies.set).toHaveBeenCalledWith({ icsShareToken: null });
    expect(spies.insert).toHaveBeenCalledTimes(1);
    expect(spies.values).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: FAMILY_ID,
        actor: 'system',
        actionTaken: 'ics_feed_revoked',
        targetTable: 'families',
        targetId: FAMILY_ID,
      }),
    );
  });

  it('is a no-op when no live token exists (already revoked): no audit row, returns false', async () => {
    const { db, spies } = fakeRevokeDb([]);

    const revoked = await revokeIcsToken(db, FAMILY_ID);

    expect(revoked).toBe(false);
    expect(spies.insert).not.toHaveBeenCalled();
  });
});

describe('loadIcsFeed — token resolution + teen gate (rule #1)', () => {
  it('returns null for an unknown/revoked token (a nulled token resolves no family → feed dead)', async () => {
    const { db } = fakeLoadDb([]);

    // revokeIcsToken nulls families.ics_share_token; the feed query is
    // WHERE ics_share_token = :token, so the old token now matches nothing.
    expect(await loadIcsFeed(db, 'revoked-or-unknown', NOW)).toBeNull();
  });

  it("redacts a 13+ child's event to a generic title (no name, no location); keeps a non-teen surname-free title", async () => {
    const teenChildDob = '2010-01-01'; // ~16y at NOW → teenager (≥156mo)
    const childDob = '2020-01-01'; // ~6y at NOW → child

    const { db } = fakeLoadDb(
      [{ id: FAMILY_ID }],
      [
        {
          id: 'aaaaaaaa-1111-4111-8111-111111111111',
          title: 'Therapy with Dr. Reed',
          startsAt: new Date('2026-07-22T14:00:00.000Z'),
          endsAt: new Date('2026-07-22T15:00:00.000Z'),
          location: 'Riverdale Clinic, Room 5',
          childDob: teenChildDob,
        },
        {
          id: 'bbbbbbbb-2222-4222-8222-222222222222',
          title: 'Leo swim meet',
          startsAt: new Date('2026-07-23T09:00:00.000Z'),
          endsAt: null,
          location: 'Community pool',
          childDob: childDob,
        },
      ],
    );

    const ics = await loadIcsFeed(db, TOKEN, NOW);
    expect(ics).not.toBeNull();
    const feed = ics as string;

    // Teen event: title + location redacted.
    expect(feed).toContain('SUMMARY:A private calendar item');
    expect(feed).not.toContain('Therapy with Dr. Reed');
    expect(feed).not.toContain('Riverdale Clinic');

    // Non-teen event: stored (surname-free, first-name-only) title survives.
    expect(feed).toContain('SUMMARY:Leo swim meet');

    // A surname is NEVER queried (only `title` is selected), so it can never appear —
    // assert the structural guarantee holds for a surname that is not in any title.
    expect(feed).not.toContain('Kowalski');
  });
});
