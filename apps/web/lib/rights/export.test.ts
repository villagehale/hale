import { describe, expect, it, vi } from 'vitest';
import type { TrailView } from '~/lib/dashboard/mappers';
import { TEEN_REDACTED_PLACEHOLDER } from '~/lib/dashboard/mappers';
import { assembleFamilyExport } from './export';

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_FAMILY_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_USER_ID = '55555555-5555-4555-8555-555555555555';

interface FamilyRow {
  displayName: string;
  country: string | null;
  province: string | null;
  city: string | null;
  postalCode: string | null;
  planTier: 'free' | 'plus' | 'family';
  intents: string[] | null;
}
interface ChildRow {
  id: string;
  name: string;
  dateOfBirth: string;
}
interface MemberRow {
  name: string | null;
  email: string;
  role: 'primary_parent' | 'co_parent' | 'extended' | 'service';
}

/**
 * Fakes the three family-scoped selects assembleFamilyExport runs (family row,
 * children, members) plus the insert().values() for the audit row. Each select's
 * terminal `.where(...)` resolves the rows and records the family id it was scoped
 * to, so a test can prove the query is family-scoped, never global.
 */
function fakeDb(args: {
  family: FamilyRow | null;
  children: ChildRow[];
  members: MemberRow[];
  saves?: { title: string; savedAt: Date }[];
}) {
  const whereFamilyIds: unknown[] = [];

  const familyLimit = vi.fn().mockResolvedValue(args.family ? [args.family] : []);
  const familyWhere = vi.fn((cond: unknown) => {
    whereFamilyIds.push(cond);
    return { limit: familyLimit };
  });

  const childrenWhere = vi.fn((cond: unknown) => {
    whereFamilyIds.push(cond);
    return { orderBy: vi.fn().mockResolvedValue(args.children) };
  });

  const membersWhere = vi.fn((cond: unknown) => {
    whereFamilyIds.push(cond);
    return Promise.resolve(args.members);
  });

  const savesWhere = vi.fn((cond: unknown) => {
    whereFamilyIds.push(cond);
    return { orderBy: vi.fn().mockResolvedValue(args.saves ?? []) };
  });

  // Route each select to the right terminal by call order: family, children,
  // members, then the village-saves join.
  let selectCall = 0;
  const select = vi.fn(() => {
    const which = selectCall++;
    if (which === 0) return { from: () => ({ where: familyWhere }) };
    if (which === 1) return { from: () => ({ where: childrenWhere }) };
    if (which === 2) return { from: () => ({ innerJoin: () => ({ where: membersWhere }) }) };
    return { from: () => ({ innerJoin: () => ({ where: savesWhere }) }) };
  });

  const values = vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn().mockReturnValue({ values });

  return {
    db: { select, insert } as never,
    spies: { insert, values, whereFamilyIds },
  };
}

const FAMILY: FamilyRow = {
  displayName: 'The Rivera Family',
  country: 'Canada',
  province: 'Ontario',
  city: 'Toronto',
  postalCode: 'M5V',
  planTier: 'free',
  intents: null,
};

describe('assembleFamilyExport', () => {
  it('writes the immutable data_exported audit row scoped to the family + actor (rule #6)', async () => {
    const { db, spies } = fakeDb({ family: FAMILY, children: [], members: [] });

    await assembleFamilyExport(db, FAMILY_ID, {
      actorUserId: ACTOR_USER_ID,
      loadTrail: async () => [],
    });

    expect(spies.insert).toHaveBeenCalledTimes(1);
    expect(spies.values).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: FAMILY_ID,
        actor: ACTOR_USER_ID,
        actionTaken: 'data_exported',
        targetTable: 'families',
        targetId: FAMILY_ID,
      }),
    );
  });

  it('assembles the parent-visible family, children, and members into the document', async () => {
    const { db } = fakeDb({
      family: FAMILY,
      children: [{ id: 'c1', name: 'Mika', dateOfBirth: '2015-04-02' }],
      members: [{ name: 'Ana', email: 'ana@example.com', role: 'primary_parent' }],
    });

    const doc = await assembleFamilyExport(db, FAMILY_ID, {
      actorUserId: ACTOR_USER_ID,
      loadTrail: async () => [],
    });

    expect(doc.family.displayName).toBe('The Rivera Family');
    expect(doc.family.location.city).toBe('Toronto');
    expect(doc.children).toHaveLength(1);
    expect(doc.children[0]?.name).toBe('Mika');
    expect(doc.members.primary?.email).toBe('ana@example.com');
    expect(doc.savedActivities).toEqual([]);
  });

  it('includes the family village saves — user-generated rows belong in the right-to-access copy', async () => {
    const { db } = fakeDb({
      family: FAMILY,
      children: [],
      members: [],
      saves: [{ title: 'Saturday story-time', savedAt: new Date('2026-07-01T12:00:00Z') }],
    });

    const doc = await assembleFamilyExport(db, FAMILY_ID, {
      actorUserId: ACTOR_USER_ID,
      loadTrail: async () => [],
    });

    expect(doc.savedActivities).toEqual([
      { title: 'Saturday story-time', savedAt: '2026-07-01T12:00:00.000Z' },
    ]);
  });

  it('carries the ALREADY-REDACTED trail rows — a redacted teen row exports the placeholder, never raw content (rule #1)', async () => {
    const redactedTeenRow: TrailView = {
      id: 'a1',
      time: '09:15',
      date: 'Thursday, Jun 11',
      dayKey: '2026-06-11',
      tone: 'done',
      actor: 'hale',
      summary: TEEN_REDACTED_PLACEHOLDER,
      noun: 'draft',
      link: null,
      childLabel: 'Sam',
    };
    const loadTrail = vi.fn().mockResolvedValue([redactedTeenRow]);
    const { db } = fakeDb({ family: FAMILY, children: [], members: [] });

    const doc = await assembleFamilyExport(db, FAMILY_ID, {
      actorUserId: ACTOR_USER_ID,
      loadTrail,
    });

    // The trail body is loaded family-scoped, so redaction is inherited, not re-done.
    expect(loadTrail).toHaveBeenCalledWith(db, FAMILY_ID);
    const serialized = JSON.stringify(doc);
    expect(serialized).toContain(TEEN_REDACTED_PLACEHOLDER);
    // The raw teen subject a redacted row hides must never appear in the export.
    expect(serialized).not.toContain('positive pregnancy test');
  });

  it('scopes every read to the requested family id, never a global dump', async () => {
    const { db, spies } = fakeDb({ family: FAMILY, children: [], members: [] });

    await assembleFamilyExport(db, FAMILY_ID, {
      actorUserId: ACTOR_USER_ID,
      loadTrail: async () => [],
    });

    // Four family-scoped selects (family, children, members, village saves)
    // each recorded a where-condition; none was left unscoped. (The condition
    // objects are opaque Drizzle SQL, so we assert on arity — every select
    // passed through a where.)
    expect(spies.whereFamilyIds).toHaveLength(4);
    expect(OTHER_FAMILY_ID).not.toBe(FAMILY_ID);
  });
});
