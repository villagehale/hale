import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadWeekdayCareContext } from '~/lib/care/weekday';
import type { OutboundGatePorts } from '~/lib/channel/outbound-gate';
import { queueCheckInForDecider } from '~/lib/channel/proactive/queue';
import { SCHOOL_BREAK_ASK_TEMPLATE_KEY, parseWeekdayAskKey } from '~/lib/channel/weekday-care/key';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { SCHOOL_BREAK_FACT_KEY, loadSchoolBreak, recordSchoolBreak } from './facts';
import { SCHOOL_BREAK_ENABLED_ENV } from './flag';
import type { BoardLookupDeps } from './lookup';
import type { BreakPageReading } from './read';
import type { CalendarSearch } from './search';
import {
  SCHOOL_BREAK_ASK_KIND,
  type SchoolBreakSweepDeps,
  defaultSchoolBreakSweepDeps,
  runSchoolBreakSweep,
} from './sweep';

/**
 * The winter-break sweep against real Postgres: the per-board cache, the family fact,
 * the decider queue and the audit rows are the real ones, and so is the weekday context
 * the break question reads. The search and the page reader are scripted ports (their
 * model work is the school-break eval's, hard rule #8); the gate's consent reads are a
 * port (outbound-gate.test.ts owns them).
 */

/** Thursday Nov 12, 10:00 in Ontario. */
const NOW = new Date('2026-11-12T15:00:00Z');
const BOARD = 'board.example';
const PAGE = 'https://www.board.example/calendar/2026-2027';
const OTHER_BOARD = 'other-board.example';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv(SCHOOL_BREAK_ENABLED_ENV, '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await db.exec('truncate table families, users, school_break_readings cascade');
});

const openGate = (): OutboundGatePorts => ({
  channelEnrolled: async () => true,
  watchConsentGranted: async () => true,
  countProactiveSends: async () => 0,
  proactiveSentSince: async () => true,
  parentTimeZone: async () => 'America/Toronto',
});

const WINTER: BreakPageReading = {
  status: 'verified',
  sourceUrl: PAGE,
  name: 'Winter Break',
  firstDay: { date: '2026-12-21', quote: 'Winter Break: December 21, 2026 to January 1, 2027' },
  lastDay: { date: '2027-01-01', quote: 'Winter Break: December 21, 2026 to January 1, 2027' },
};

function scripted(
  over: { search?: (host: string) => CalendarSearch; read?: () => BreakPageReading } = {},
) {
  const searches: string[] = [];
  const reads: string[] = [];
  const lookup: BoardLookupDeps = {
    search: async (host) => {
      searches.push(host);
      return over.search
        ? over.search(host)
        : { outcome: 'pages', boardName: 'Example District School Board', urls: [PAGE] };
    },
    read: async ({ url }) => {
      reads.push(url);
      return over.read ? over.read() : WINTER;
    },
  };
  return { lookup, searches, reads };
}

function deps(
  lookup: BoardLookupDeps | null,
  over: Partial<SchoolBreakSweepDeps> = {},
): SchoolBreakSweepDeps {
  return {
    ...defaultSchoolBreakSweepDeps(null),
    lookup,
    buildGate: openGate,
    queueCandidate: queueCheckInForDecider,
    f14For: () => true,
    recipients: async (database, familyId) =>
      (
        await database
          .select({ parentUserId: schema.familyMembers.userId, role: schema.familyMembers.role })
          .from(schema.familyMembers)
          .where(eq(schema.familyMembers.familyId, familyId))
      ).map((row) => ({
        parentUserId: row.parentUserId,
        timeZone: 'America/Toronto',
        role: row.role as 'primary_parent' | 'co_parent',
      })),
    ...over,
  };
}

let seq = 0;

async function seedFamily(
  input: { senders?: string[]; dateOfBirth?: string; parents?: number } = {},
): Promise<{ familyId: string; parentIds: string[] }> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Test household' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const parentIds: string[] = [];
  for (let i = 0; i < (input.parents ?? 1); i++) {
    const [user] = await db.database
      .insert(schema.users)
      .values({ name: `Parent ${i}`, timezone: 'America/Toronto' })
      .returning({ id: schema.users.id });
    parentIds.push(user?.id as string);
    await db.database.insert(schema.familyMembers).values({
      familyId,
      userId: user?.id as string,
      role: i === 0 ? 'primary_parent' : 'co_parent',
    });
  }
  await db.database
    .insert(schema.children)
    .values({ familyId, name: 'Robin', dateOfBirth: input.dateOfBirth ?? '2019-03-01' });
  for (const senderDomain of input.senders ?? []) {
    seq += 1;
    await db.database.insert(schema.familyForwardSenders).values({
      familyId,
      senderDomain,
      ref: seq.toString(16).padStart(8, '0'),
      state: 'allowed',
      decidedAt: NOW,
    });
  }
  return { familyId, parentIds };
}

async function asks(familyId: string) {
  return db.database
    .select()
    .from(schema.proactiveCandidates)
    .where(
      and(
        eq(schema.proactiveCandidates.familyId, familyId),
        eq(schema.proactiveCandidates.kind, SCHOOL_BREAK_ASK_KIND),
      ),
    );
}

async function audits(familyId: string, actionTaken: string) {
  return db.database
    .select()
    .from(schema.auditLog)
    .where(
      and(eq(schema.auditLog.familyId, familyId), eq(schema.auditLog.actionTaken, actionTaken)),
    );
}

describe('the winter-break sweep', () => {
  it('reads nothing while the kill switch is off', async () => {
    vi.stubEnv(SCHOOL_BREAK_ENABLED_ENV, 'false');
    const { familyId } = await seedFamily({ senders: [BOARD] });
    const script = scripted();
    const result = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);
    expect(result.skipped).toBe('flag_off');
    expect(script.searches).toEqual([]);
    expect(await asks(familyId)).toEqual([]);
  });

  it("reads the board once for every family on its host and files each family's break with its source", async () => {
    const one = await seedFamily({ senders: [BOARD] });
    const two = await seedFamily({ senders: [BOARD] });
    const script = scripted();

    const result = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);

    expect(script.searches).toEqual([BOARD]);
    expect(result).toMatchObject({ lookedUp: 1, verified: 1, recorded: 2, queued: 0 });
    const [reading] = await db.database.select().from(schema.schoolBreakReadings);
    expect(reading).toMatchObject({
      boardHost: BOARD,
      schoolYear: '2026-27',
      status: 'verified',
      sourceUrl: PAGE,
    });
    for (const { familyId } of [one, two]) {
      expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toMatchObject({
        source: 'board_page',
        firstDay: '2026-12-21',
        lastDay: '2027-01-01',
        sourceUrl: PAGE,
        boardHost: BOARD,
        quotes: ['Winter Break: December 21, 2026 to January 1, 2027'],
      });
      expect(await audits(familyId, 'school_break_recorded')).toHaveLength(1);
      expect(await asks(familyId)).toEqual([]);
    }

    // The next hour: the cache is fresh and the facts already say it.
    const again = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);
    expect(script.searches).toEqual([BOARD]);
    expect(again).toMatchObject({ lookedUp: 0, recorded: 0 });
    expect(await audits(one.familyId, 'school_break_recorded')).toHaveLength(1);
  });

  it('hands the break question the board break, through the production context', async () => {
    const { familyId } = await seedFamily({ senders: [BOARD] });
    await runSchoolBreakSweep(db.database, deps(scripted().lookup), NOW);

    const context = await loadWeekdayCareContext(db.database, familyId, NOW);
    expect(context.verifiedBreak).toEqual({
      eventKey: 'winter-break-2026-12-21',
      label: 'Winter Break',
      date: '2026-12-21',
      source: 'school_calendar',
    });
  });

  it('reads two boards separately, and never takes one board for another', async () => {
    const { familyId } = await seedFamily({ senders: [OTHER_BOARD] });
    const script = scripted({
      search: (host) =>
        host === OTHER_BOARD
          ? { outcome: 'none', reason: 'no_calendar_page' }
          : { outcome: 'pages', boardName: 'Example District School Board', urls: [PAGE] },
    });
    await seedFamily({ senders: [BOARD] });

    const result = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);

    expect([...script.searches].sort()).toEqual([BOARD, OTHER_BOARD]);
    expect(result).toMatchObject({ verified: 1, notFound: 1 });
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toBeNull();
    // No page for their board: the one question instead of the other board's dates.
    expect(await asks(familyId)).toHaveLength(1);
  });

  it('asks once, per family, when no page has the days, and never again this school year', async () => {
    const { familyId, parentIds } = await seedFamily({ parents: 2 });
    const script = scripted();

    const result = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);

    expect(script.searches).toEqual([]);
    expect(result).toMatchObject({ queued: 1 });
    const [ask, ...more] = await asks(familyId);
    expect(more).toEqual([]);
    expect(ask).toMatchObject({
      parentUserId: parentIds[0],
      category: 'nudge',
      templateKey: SCHOOL_BREAK_ASK_TEMPLATE_KEY,
      sourceUrl: null,
      status: 'queued',
    });
    expect(parseWeekdayAskKey(ask?.dedupeKey ?? null)).toEqual({
      scope: 'break_dates',
      schoolYear: '2026-27',
    });
    expect(ask?.worthlessAfter?.toISOString()).toBe('2026-12-15T17:00:00.000Z');
    expect(await audits(familyId, 'proactive_cadence_queued')).toHaveLength(1);

    const again = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);
    expect(again).toMatchObject({ queued: 0, asked: 1 });
    expect(await asks(familyId)).toHaveLength(1);
  });

  it('does not ask while a board lookup has not finished', async () => {
    const { familyId } = await seedFamily({ senders: [BOARD] });
    const script = scripted({ search: () => ({ outcome: 'failed', reason: 'search_failed:x' }) });
    const result = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);
    expect(result).toMatchObject({ retry: 1, waiting: 1, queued: 0 });
    expect(await asks(familyId)).toEqual([]);
    expect(await db.database.select().from(schema.schoolBreakReadings)).toEqual([]);
  });

  it("leaves a parent's own answer alone: no lookup, no question, no board write over it", async () => {
    const { familyId, parentIds } = await seedFamily({ senders: [BOARD] });
    await recordSchoolBreak(db.database, {
      source: 'parent',
      familyId,
      parentUserId: parentIds[0] as string,
      schoolYear: '2026-27',
      name: 'winter break',
      firstDay: '2026-12-18',
      lastDay: '2027-01-04',
      quote: 'dec 18 to jan 4',
      now: NOW,
    });
    const script = scripted();

    const result = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);

    expect(result).toMatchObject({ parentKnown: 1, lookedUp: 0, recorded: 0, queued: 0 });
    expect(script.searches).toEqual([]);
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toMatchObject({
      source: 'parent',
      firstDay: '2026-12-18',
    });
    const context = await loadWeekdayCareContext(db.database, familyId, NOW);
    expect(context.verifiedBreak).toEqual({
      eventKey: 'winter-break-2026-12-18',
      label: 'winter break',
      date: '2026-12-18',
      source: 'parent_said',
    });
  });

  it('skips a family with no child in school or daycare', async () => {
    const { familyId } = await seedFamily({ dateOfBirth: '2024-06-01' });
    const result = await runSchoolBreakSweep(db.database, deps(scripted().lookup), NOW);
    expect(result).toMatchObject({ noSchoolChild: 1, queued: 0 });
    expect(await asks(familyId)).toEqual([]);
  });

  it('asks nothing once the winter break is too close to plan around', async () => {
    const { familyId } = await seedFamily();
    const late = new Date('2026-12-16T15:00:00Z');
    const result = await runSchoolBreakSweep(db.database, deps(scripted().lookup), late);
    expect(result).toMatchObject({ tooLate: 1, queued: 0 });
    expect(await asks(familyId)).toEqual([]);
  });

  it('counts a missing model client by name and asks nothing for a board it could not read', async () => {
    const { familyId } = await seedFamily({ senders: [BOARD] });
    const result = await runSchoolBreakSweep(db.database, deps(null), NOW);
    expect(result).toMatchObject({ noClient: 1, waiting: 1, queued: 0 });
    expect(await asks(familyId)).toEqual([]);
  });

  it('the fact is writer-pinned: a row under the key from another writer is not a break', async () => {
    const { familyId } = await seedFamily();
    await db.database.insert(schema.familyMemoryFacts).values({
      familyId,
      childId: null,
      factType: 'logistic',
      factKey: SCHOOL_BREAK_FACT_KEY,
      factValue: {
        schoolYear: '2026-27',
        name: 'Winter Break',
        firstDay: '2026-12-21',
        lastDay: '2027-01-01',
        source: 'board_page',
        sourceUrl: PAGE,
        boardHost: BOARD,
        quotes: ['x'],
      },
      confidence: 1,
      inferredBy: 'ask-hale',
      validFrom: NOW,
    });
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toBeNull();
    expect((await loadWeekdayCareContext(db.database, familyId, NOW)).verifiedBreak).toBeNull();
  });
});
