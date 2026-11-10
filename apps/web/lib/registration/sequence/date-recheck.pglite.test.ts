import type { AgentClient } from '@hale/agent';
import { type Municipality, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import type { LiveRegistrationReading } from '~/lib/registration/live-reading';
import type { RegistrationReader, RegistrationTarget } from '~/lib/registration/read';
import type { FetchPage } from '~/lib/registration/verify-sweep';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import type { DateMovedInput } from './date-moved-compose.js';
import type { EveningComposeInput } from './evening-compose.js';
import type { HeadsUpComposeInput } from './heads-up-compose.js';
import {
  type SequenceRunDeps,
  dateMovedDedupeKey,
  defaultSequenceRunDeps,
  runRegistrationSequenceCron,
} from './run.js';

/**
 * VIL-423 · slice 4b — the scheduled re-read of a watched registration page, through
 * the DEFAULT loader and the default `saveDateWatch` against the real DDL. Faked only
 * at the ports: the page reader (one hand-built reading per URL, so the page's date is
 * the fixture), the composers (their model output is the evals'), the gate and the
 * recipients.
 */

const TZ = 'America/Edmonton';
const PAGE = 'https://larchmere.example.org/register';
const OTHER_PAGE = 'https://fernvale.example.org/register';
/** Sunday 20 Sept 2026, 10:00 in Edmonton: the catalog row's opening. */
const STORED = new Date('2026-09-20T16:00:00.000Z');
/** Friday 18 Sept 2026, 10:00 in Edmonton: where the page moves it. */
const MOVED = new Date('2026-09-18T16:00:00.000Z');
/** Thursday 10 Sept, 10:00 local: before any leg of either date is due. */
const QUIET = new Date('2026-09-10T16:00:00.000Z');
/** Monday 14 Sept, 11:00 local: the heads-up interval for the 20th. */
const HEADS_UP = new Date('2026-09-14T17:00:00.000Z');
/** Tuesday 15 Sept, 12:00 local: a day later, when the page shows the 18th. */
const MOVE_SEEN = new Date('2026-09-15T18:00:00.000Z');
/** Thursday 17 Sept, 19:30 local: the evening before the 18th. Under the 20th this is
 * still the heads-up's interval, already spent, so nothing would go. */
const EVENING_BEFORE_MOVED = new Date('2026-09-18T01:30:00.000Z');

let db: TestDb;
let info: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv('F14_ENABLED', 'true');
  vi.stubEnv('REGISTRATION_DATE_CHECK', 'enforce');
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllEnvs();
  info.mockRestore();
  await db.exec('truncate table families, users, registration_windows cascade');
});

async function seedWindow(municipality: string, sourceUrl: string): Promise<string> {
  const [window] = await db.database
    .insert(schema.registrationWindows)
    .values({
      municipality: municipality as Municipality,
      programDomain: 'rec_program',
      cycleLabel: 'Fall 2026',
      openAt: STORED,
      ageMinMonths: null,
      ageMaxMonths: null,
      sourceUrl,
      verifiedAt: new Date('2026-08-01T00:00:00.000Z'),
    })
    .returning({ id: schema.registrationWindows.id });
  return window?.id as string;
}

/** A household with one child and an approved ladder on `windowId`. */
async function seedLadder(
  name: string,
  windowId: string,
): Promise<{ familyId: string; parentUserId: string; sequenceId: string }> {
  const { familyId, parentUserId } = await seedFamily(db.database, name);
  await db.database
    .update(schema.users)
    .set({ timezone: TZ })
    .where(eq(schema.users.id, parentUserId));
  await db.database
    .update(schema.families)
    .set({ areaCoarse: null })
    .where(eq(schema.families.id, familyId));
  await db.database
    .insert(schema.children)
    .values({ familyId, name: 'Wren', dateOfBirth: '2022-03-01', dobPrecision: 'exact' });
  const [event] = await db.database
    .insert(schema.events)
    .values({
      familyId,
      source: 'test',
      eventType: 'registration_shortlist',
      dedupHash: `recheck-${Math.random()}`,
    })
    .returning({ id: schema.events.id });
  const [action] = await db.database
    .insert(schema.actions)
    .values({
      eventId: event?.id as string,
      familyId,
      actionType: 'send_message',
      payload: {},
      userVisibleState: 'autonomous',
      reviewerVerdict: 'approved',
      draftedAt: new Date('2026-09-01T10:00:00.000Z'),
      executedAt: new Date('2026-09-01T10:05:00.000Z'),
    })
    .returning({ id: schema.actions.id });
  const [row] = await db.database
    .insert(schema.registrationSequences)
    .values({ familyId, windowId, parentUserId, actionId: action?.id as string })
    .returning({ id: schema.registrationSequences.id });
  return { familyId, parentUserId, sequenceId: row?.id as string };
}

function verified(url: string, opensAt: Date): LiveRegistrationReading {
  const local = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(opensAt);
  return {
    sourceUrl: url,
    checkedAt: QUIET,
    reader: 'ai',
    status: 'verified',
    timeZone: TZ,
    dates: [{ kind: 'general_open', date: local, time: '10:00', evidence: ['opens at 10 a.m.'] }],
    partialDates: [],
  };
}

const unreadable = (url: string): LiveRegistrationReading => ({
  sourceUrl: url,
  checkedAt: QUIET,
  reader: 'ai',
  status: 'unreadable',
  reason: 'http_status',
});

interface Ports {
  deps: SequenceRunDeps;
  transport: FakeTransport;
  /** What each page says right now, by URL. */
  pages: Map<string, LiveRegistrationReading>;
  /** Every target the reader was asked for, uncached. */
  asked: RegistrationTarget[];
  moved: DateMovedInput[];
  headsUp: HeadsUpComposeInput[];
  evenings: EveningComposeInput[];
}

function ports(parents: Map<string, string>): Ports {
  const transport = new FakeTransport();
  const pages = new Map<string, LiveRegistrationReading>();
  const asked: RegistrationTarget[] = [];
  const moved: DateMovedInput[] = [];
  const headsUp: HeadsUpComposeInput[] = [];
  const evenings: EveningComposeInput[] = [];
  const reader: RegistrationReader = async (target) => {
    asked.push(target);
    const reading = pages.get(target.sourceUrl);
    if (!reading) throw new Error(`no page for ${target.sourceUrl}`);
    return reading;
  };
  const deps: SequenceRunDeps = {
    ...defaultSequenceRunDeps(),
    transport,
    loadRecipients: async (_db, familyId) => [
      { parentUserId: parents.get(familyId) as string, timeZone: TZ, role: 'primary_parent' },
    ],
    buildGate: () => ({
      channelEnrolled: async () => true,
      watchConsentGranted: async () => true,
      countProactiveSends: async () => 0,
      proactiveSentSince: async () => false,
      parentTimeZone: async () => TZ,
    }),
    resolveSendablePhone: async () => '+15555550100',
    client: {
      messages: {
        create: async () => {
          throw new Error('compose is injected');
        },
      },
    } as unknown as AgentClient,
    loadLanguage: async () => 'en',
    composeHeadsUp: async (_client, facts) => {
      headsUp.push(facts);
      return `heads-up ${facts.opensOn}`;
    },
    composeEvening: async (_client, facts) => {
      evenings.push(facts);
      return `evening ${facts.opensOn}`;
    },
    composeMorning: async () => {
      throw new Error('unexpected morning text');
    },
    writeNote: async (_db, _familyId, facts) => {
      throw new Error(`unexpected registration note: ${facts.kind}`);
    },
    composeDateUnconfirmed: async () => {
      throw new Error('unexpected dateless text');
    },
    composeDateMoved: async (_client, facts) => {
      moved.push(facts);
      return `moved to ${facts.opens.date}`;
    },
    createDateReader: () => reader,
    fetchBody: (async (url: string) => {
      throw new Error(`unexpected course read: ${url}`);
    }) as unknown as FetchPage,
    refreshCourseAnchor: async () => {
      throw new Error('unexpected anchor refresh');
    },
  };
  return { deps, transport, pages, asked, moved, headsUp, evenings };
}

async function sequenceRow(sequenceId: string) {
  const [row] = await db.database
    .select()
    .from(schema.registrationSequences)
    .where(eq(schema.registrationSequences.id, sequenceId));
  if (!row) throw new Error('no sequence row');
  return row;
}

async function audits(familyId: string) {
  return db.database
    .select({ actionTaken: schema.auditLog.actionTaken, after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.familyId, familyId));
}

describe('the scheduled re-read of a watched registration page', () => {
  it('moves the unsent legs when the page moves the date, and tells the household once', async () => {
    const windowId = await seedWindow('larchmere', PAGE);
    const family = await seedLadder('Moved Date Family', windowId);
    const p = ports(new Map([[family.familyId, family.parentUserId]]));

    // The page agrees with the row: the heads-up goes out naming the 20th.
    p.pages.set(PAGE, verified(PAGE, STORED));
    const first = await runRegistrationSequenceCron(db.database, p.deps, HEADS_UP);
    expect(first.dateRecheck.unchanged).toBe(1);
    expect(p.headsUp.map((facts) => facts.opensOn)).toEqual(['Sunday, September 20, 2026']);
    expect(first.dateMovedSent).toBe(0);

    // The page moves the opening to the 18th. The next scheduled read catches it.
    p.pages.set(PAGE, verified(PAGE, MOVED));
    const moved = await runRegistrationSequenceCron(db.database, p.deps, MOVE_SEEN);
    expect(moved.dateRecheck.moved).toBe(1);
    expect(moved.dateMovedSent).toBe(1);
    expect(p.moved).toHaveLength(1);
    expect(p.moved[0]).toMatchObject({
      was: { date: 'Sunday, September 20, 2026', time: '10:00 a.m.' },
      opens: { date: 'Friday, September 18, 2026', time: '10:00 a.m.' },
      who: 'Wren',
    });
    const bodies = p.transport.bodies();
    expect(bodies).toHaveLength(2);
    // The writer's words, then the page on its own line, added by code.
    expect(bodies[1]?.split('\n').slice(0, 2)).toEqual([
      'moved to Friday, September 18, 2026',
      PAGE,
    ]);

    const row = await sequenceRow(family.sequenceId);
    expect(row.lastReading).toMatchObject({ openAt: MOVED.toISOString(), sourceUrl: PAGE });
    expect(row.lastReadAt?.toISOString()).toBe(MOVE_SEEN.toISOString());
    expect(row.pendingChange).toBeNull();
    const trail = await audits(family.familyId);
    expect(trail.find((a) => a.actionTaken === 'registration_date_moved')?.after).toEqual({
      windowId,
      from: STORED.toISOString(),
      to: MOVED.toISOString(),
    });
    expect(trail.filter((a) => a.actionTaken === 'registration_date_moved_sent')).toHaveLength(1);

    // Once: five minutes later nothing is re-read and nothing more is said.
    const askedBefore = p.asked.length;
    const again = await runRegistrationSequenceCron(
      db.database,
      p.deps,
      new Date(MOVE_SEEN.getTime() + 5 * 60_000),
    );
    expect(again.dateMovedSent).toBe(0);
    expect(p.asked).toHaveLength(askedBefore);
    expect(p.transport.bodies()).toHaveLength(2);
    const [noted] = await db.database
      .select({ id: schema.channelMessages.id })
      .from(schema.channelMessages)
      .where(
        eq(
          schema.channelMessages.dedupeKey,
          dateMovedDedupeKey(family.familyId, windowId, MOVED.toISOString(), family.parentUserId),
        ),
      );
    expect(noted).toBeDefined();

    // The evening before the 18th, the plan goes out for the 18th. On the row's 20th
    // this hour is still the spent heads-up's, and nothing would be sent.
    const evening = await runRegistrationSequenceCron(db.database, p.deps, EVENING_BEFORE_MOVED);
    expect(evening.sent).toBe(1);
    expect(p.evenings.map((facts) => facts.opensOn)).toEqual(['Friday, September 18, 2026']);
  });

  it('changes nothing when the page cannot be read, and logs why by name', async () => {
    const windowId = await seedWindow('larchmere', PAGE);
    const blocked = await seedLadder('Blocked Page Family', windowId);
    // Positive control: a second ladder on a readable page that moved, same tick.
    const otherWindowId = await seedWindow('fernvale', OTHER_PAGE);
    const control = await seedLadder('Readable Page Family', otherWindowId);
    const p = ports(
      new Map([
        [blocked.familyId, blocked.parentUserId],
        [control.familyId, control.parentUserId],
      ]),
    );
    p.pages.set(PAGE, unreadable(PAGE));
    p.pages.set(OTHER_PAGE, verified(OTHER_PAGE, MOVED));

    const result = await runRegistrationSequenceCron(db.database, p.deps, QUIET);

    expect(result.dateRecheck).toEqual({ unchanged: 0, moved: 1, already_open: 0, unread: 1 });
    expect(result.sent).toBe(0);
    expect(p.transport.bodies()).toEqual([]);

    const row = await sequenceRow(blocked.sequenceId);
    expect(row.lastReading).toBeNull();
    expect(row.lastReadAt).toBeNull();
    expect(row.pendingChange).toBeNull();
    // Rescheduled, so a blocked page is not fetched on every tick.
    expect(row.nextCheckAt?.getTime()).toBeGreaterThan(QUIET.getTime());
    expect(await audits(blocked.familyId)).toEqual([]);
    expect(info).toHaveBeenCalledWith(
      {
        outcome: 'registration_date_recheck',
        mode: 'enforce',
        sequenceId: blocked.sequenceId,
        windowId,
        check: 'unread',
        reason: 'unreadable',
        detail: 'http_status',
      },
      'registration date recheck',
    );

    const moved = await sequenceRow(control.sequenceId);
    expect(moved.lastReading).toMatchObject({ openAt: MOVED.toISOString() });
    // No leg has gone out yet, so the household hears the 18th from its first leg.
    expect(moved.pendingChange).toBeNull();
    expect(p.moved).toEqual([]);
  });

  it('reads a page two families watch once, and schedules both from that read', async () => {
    const windowId = await seedWindow('larchmere', PAGE);
    const one = await seedLadder('First Watching Family', windowId);
    const two = await seedLadder('Second Watching Family', windowId);
    const p = ports(
      new Map([
        [one.familyId, one.parentUserId],
        [two.familyId, two.parentUserId],
      ]),
    );
    p.pages.set(PAGE, verified(PAGE, STORED));

    const result = await runRegistrationSequenceCron(db.database, p.deps, QUIET);

    expect(p.asked).toHaveLength(1);
    expect(result.recheckReads).toBe(1);
    expect(result.dateRecheck.unchanged).toBe(2);
    for (const { sequenceId } of [one, two]) {
      const row = await sequenceRow(sequenceId);
      expect(row.lastReading).toMatchObject({ openAt: STORED.toISOString(), sourceUrl: PAGE });
      expect(row.nextCheckAt?.getTime()).toBeGreaterThan(QUIET.getTime());
    }

    await runRegistrationSequenceCron(db.database, p.deps, new Date(QUIET.getTime() + 10 * 60_000));
    expect(p.asked).toHaveLength(1);
  });

  describe('a change note owed when the household stops the ladder', () => {
    /** Heads-up told, then the move is seen on a tick where the gate holds the parent,
     * so the change stays owed on the row for a later tick to send. */
    async function owedChange(name: string) {
      const windowId = await seedWindow('larchmere', PAGE);
      const family = await seedLadder(name, windowId);
      const p = ports(new Map([[family.familyId, family.parentUserId]]));
      p.pages.set(PAGE, verified(PAGE, STORED));
      await runRegistrationSequenceCron(db.database, p.deps, HEADS_UP);
      const open = p.deps.buildGate;
      p.deps.buildGate = (database) => ({ ...open(database), channelEnrolled: async () => false });
      p.pages.set(PAGE, verified(PAGE, MOVED));
      const held = await runRegistrationSequenceCron(db.database, p.deps, MOVE_SEEN);
      expect(held.dateMovedSent).toBe(0);
      expect((await sequenceRow(family.sequenceId)).pendingChange).toMatchObject({
        to: MOVED.toISOString(),
      });
      p.deps.buildGate = open;
      return { windowId, family, p };
    }
    const LATER = new Date(MOVE_SEEN.getTime() + 5 * 60_000);

    it('sends nothing and clears the change once the household opted out', async () => {
      const { windowId, family, p } = await owedChange('Opted Out Family');
      const [sequence] = await db.database
        .select({ actionId: schema.registrationSequences.actionId })
        .from(schema.registrationSequences)
        .where(eq(schema.registrationSequences.id, family.sequenceId));
      await db.database
        .update(schema.actions)
        .set({ revertedAt: MOVE_SEEN })
        .where(eq(schema.actions.id, sequence?.actionId as string));

      const result = await runRegistrationSequenceCron(db.database, p.deps, LATER);

      expect(result.dateMovedSent).toBe(0);
      expect(result.dateMovedDropped).toBe(1);
      expect(p.moved).toEqual([]);
      expect(p.transport.bodies()).toHaveLength(1);
      expect((await sequenceRow(family.sequenceId)).pendingChange).toBeNull();
      const trail = await audits(family.familyId);
      expect(trail.find((a) => a.actionTaken === 'registration_date_moved_dropped')?.after).toEqual(
        { windowId, outcome: 'registration_date_moved_dropped', reason: 'not_opted_in' },
      );
      expect(trail.filter((a) => a.actionTaken === 'registration_date_moved_sent')).toEqual([]);
    });

    it('sends nothing and clears the change once the parent reported an outcome', async () => {
      const { windowId, family, p } = await owedChange('Waitlisted Family');
      await db.database
        .update(schema.registrationSequences)
        .set({ outcome: 'waitlisted' })
        .where(eq(schema.registrationSequences.id, family.sequenceId));

      const result = await runRegistrationSequenceCron(db.database, p.deps, LATER);

      expect(result.dateMovedSent).toBe(0);
      expect(result.dateMovedDropped).toBe(1);
      expect(p.moved).toEqual([]);
      expect(p.transport.bodies()).toHaveLength(1);
      expect((await sequenceRow(family.sequenceId)).pendingChange).toBeNull();
      const trail = await audits(family.familyId);
      expect(trail.find((a) => a.actionTaken === 'registration_date_moved_dropped')?.after).toEqual(
        { windowId, outcome: 'registration_date_moved_dropped', reason: 'outcome_reported' },
      );
    });

    it('still sends one note to a household that stayed opted in', async () => {
      const { family, p } = await owedChange('Still Opted In Family');

      const result = await runRegistrationSequenceCron(db.database, p.deps, LATER);

      expect(result.dateMovedSent).toBe(1);
      expect(result.dateMovedDropped).toBe(0);
      expect(p.moved).toHaveLength(1);
      expect(p.transport.bodies()).toHaveLength(2);
      expect((await sequenceRow(family.sequenceId)).pendingChange).toBeNull();
    });
  });

  it('shadow logs a moved page and stores no date', async () => {
    vi.stubEnv('REGISTRATION_DATE_CHECK', 'shadow');
    const windowId = await seedWindow('larchmere', PAGE);
    const family = await seedLadder('Shadow Family', windowId);
    const p = ports(new Map([[family.familyId, family.parentUserId]]));
    p.pages.set(PAGE, verified(PAGE, MOVED));

    const result = await runRegistrationSequenceCron(db.database, p.deps, QUIET);

    expect(result.dateRecheck.moved).toBe(1);
    const row = await sequenceRow(family.sequenceId);
    expect(row.lastReading).toBeNull();
    expect(row.pendingChange).toBeNull();
    expect(row.nextCheckAt?.getTime()).toBeGreaterThan(QUIET.getTime());
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'shadow', sequenceId: family.sequenceId, check: 'moved' }),
      'registration date recheck',
    );
  });
});
