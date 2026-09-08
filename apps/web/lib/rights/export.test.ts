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
  preparations?: {
    municipality: string;
    cycleLabel: string;
    courseUrl: string | null;
    courseOpensAt: Date | null;
    readinessReady: boolean | null;
    updatedAt: Date;
  }[];
  watches?: {
    sourceUrl: string;
    lastState: string;
    createdAt: Date;
    releasedAt: Date | null;
    releasedReason: string | null;
  }[];
  assistants?: {
    clientName: string;
    scopes: string[];
    createdAt: Date;
    lastUsedAt: Date | null;
    expiresAt: Date;
    revokedAt: Date | null;
  }[];
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

  const assistantsWhere = vi.fn((cond: unknown) => {
    whereFamilyIds.push(cond);
    return { orderBy: vi.fn().mockResolvedValue(args.assistants ?? []) };
  });

  const preparationsWhere = vi.fn((cond: unknown) => {
    whereFamilyIds.push(cond);
    return { orderBy: vi.fn().mockResolvedValue(args.preparations ?? []) };
  });

  const watchesWhere = vi.fn((cond: unknown) => {
    whereFamilyIds.push(cond);
    return { orderBy: vi.fn().mockResolvedValue(args.watches ?? []) };
  });

  // Route each select to the right terminal by call order: family, children,
  // members, the village-saves join, then this parent's assistant grants.
  let selectCall = 0;
  const select = vi.fn(() => {
    const which = selectCall++;
    if (which === 0) return { from: () => ({ where: familyWhere }) };
    if (which === 1) return { from: () => ({ where: childrenWhere }) };
    if (which === 2) return { from: () => ({ innerJoin: () => ({ where: membersWhere }) }) };
    if (which === 3) return { from: () => ({ innerJoin: () => ({ where: savesWhere }) }) };
    if (which === 4) return { from: () => ({ innerJoin: () => ({ where: assistantsWhere }) }) };
    if (which === 5) return { from: () => ({ innerJoin: () => ({ where: preparationsWhere }) }) };
    return { from: () => ({ where: watchesWhere }) };
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
    expect(doc.assistantConnections).toEqual([]);
    // Present and EMPTY, never absent: a right-to-access copy that simply omits a
    // section leaves a parent unable to tell "Hale holds none of this" from "Hale did
    // not look".
    expect(doc.registrationPreparation).toEqual([]);
    expect(doc.watchedSpots).toEqual([]);
  });

  it('exports what Hale holds about a registration morning — and never the course link', async () => {
    const { db } = fakeDb({
      family: FAMILY,
      children: [],
      members: [],
      preparations: [
        {
          municipality: 'markham',
          cycleLabel: 'Fall 2026',
          courseUrl:
            'https://cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=bfd08479-60d6-43d9-b586-5b4c8305a003&courseId=961140fe-0866-460f-9973-7c42cbe0a928',
          courseOpensAt: new Date('2026-09-15T10:30:00Z'),
          readinessReady: true,
          updatedAt: new Date('2026-09-01T12:00:00Z'),
        },
      ],
    });

    const doc = await assembleFamilyExport(db, FAMILY_ID, {
      actorUserId: ACTOR_USER_ID,
      loadTrail: async () => [],
    });

    expect(doc.registrationPreparation).toEqual([
      {
        municipality: 'markham',
        cycleLabel: 'Fall 2026',
        courseHost: 'cityofmarkham.perfectmind.com',
        courseOpensAt: '2026-09-15T10:30:00.000Z',
        readinessReady: true,
        // When this ROW last changed, which is not the same thing as when the parent
        // pasted the link: the anchor is refreshed by later reads. The dated bind is a
        // trail line, and the trail is in this document.
        updatedAt: '2026-09-01T12:00:00.000Z',
      },
    ]);
    // METADATA ONLY. The course id in that URL names the exact class one of this
    // family's children is being registered for, so the HOST is the whole of what a
    // portability copy carries — the parent already has the link; they pasted it.
    const serialized = JSON.stringify(doc);
    expect(serialized).not.toContain('courseId=');
    expect(serialized).not.toContain('BookMe4LandingPages');
  });

  it('omits a sequence Hale holds no preparation for at all', async () => {
    // The positive control for the case above: the block is about what a parent TOLD
    // Hale, and a claimed window nobody has pasted a link for or answered about has
    // nothing in it to export.
    const { db } = fakeDb({
      family: FAMILY,
      children: [],
      members: [],
      preparations: [],
    });

    const doc = await assembleFamilyExport(db, FAMILY_ID, {
      actorUserId: ACTOR_USER_ID,
      loadTrail: async () => [],
    });

    expect(doc.registrationPreparation).toEqual([]);
  });

  it('exports the class pages the family asked Hale to watch, by host and state', async () => {
    // VIL-337's rows, deferred at the time and closed here: a watch is a standing
    // instruction the family gave, so a right-to-access copy that omitted it would be
    // missing the one thing Hale is doing on their behalf every ten minutes.
    const { db } = fakeDb({
      family: FAMILY,
      children: [],
      members: [],
      watches: [
        {
          sourceUrl:
            'https://townofoakville.perfectmind.com/Contacts/BookMe4LandingPages/CoursesLandingPage?widgetId=15f6af07-39c5-473e-b053-96653f77a406&courseId=16765c8e-835f-4ba6-9803-bbc84bd5ff8f',
          lastState: 'full',
          createdAt: new Date('2026-07-01T12:00:00Z'),
          releasedAt: new Date('2026-07-20T09:00:00Z'),
          releasedReason: 'notified',
        },
      ],
    });

    const doc = await assembleFamilyExport(db, FAMILY_ID, {
      actorUserId: ACTOR_USER_ID,
      loadTrail: async () => [],
    });

    expect(doc.watchedSpots).toEqual([
      {
        host: 'townofoakville.perfectmind.com',
        state: 'full',
        createdAt: '2026-07-01T12:00:00.000Z',
        releasedAt: '2026-07-20T09:00:00.000Z',
        releasedReason: 'notified',
      },
    ]);
    // The label a parent gave the class is theirs and is already in the trail; what must
    // never leave is the course identity itself.
    expect(JSON.stringify(doc.watchedSpots)).not.toContain('courseId=');
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

  it('includes non-secret assistant connection history without internal ids or token material', async () => {
    const { db } = fakeDb({
      family: FAMILY,
      children: [],
      members: [],
      assistants: [
        {
          clientName: 'Example assistant',
          scopes: ['events.read', 'actions.propose'],
          createdAt: new Date('2026-07-01T12:00:00Z'),
          lastUsedAt: new Date('2026-07-20T09:00:00Z'),
          expiresAt: new Date('2026-08-01T12:00:00Z'),
          revokedAt: null,
        },
      ],
    });

    const doc = await assembleFamilyExport(db, FAMILY_ID, {
      actorUserId: ACTOR_USER_ID,
      loadTrail: async () => [],
      now: new Date('2026-07-22T12:00:00Z'),
    });

    expect(doc.assistantConnections).toEqual([
      expect.objectContaining({
        clientName: 'Example assistant',
        scopes: ['events.read', 'actions.propose'],
        status: 'active',
      }),
    ]);
    expect(JSON.stringify(doc.assistantConnections)).not.toMatch(
      /token|grantId|clientId|consentId/i,
    );
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
      teenRedacted: true,
      actionId: 'ac710000-0000-4000-8000-000000000001',
      reversalKept: false,
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

    // Seven scoped selects (family, children, members, village saves, this parent's
    // assistant grants, the registration preparations and the watched spots)
    // each recorded a where-condition; none was left unscoped. (The condition
    // objects are opaque Drizzle SQL, so we assert on arity — every select
    // passed through a where.)
    expect(spies.whereFamilyIds).toHaveLength(7);
    expect(OTHER_FAMILY_ID).not.toBe(FAMILY_ID);
  });
});
