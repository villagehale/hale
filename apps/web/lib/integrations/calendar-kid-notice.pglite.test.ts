import { type CalendarStanding, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import {
  type SpokenLineRequest,
  type SpokenLineWriter,
  setSharedSpokenLineWriter,
} from '~/lib/channel/spoken-line';
import {
  type TestDb,
  createTestDb,
  seedChild,
  seedFamily,
  seedIntegration,
} from '~/lib/testing/pglite';
import { scriptedSpokenLineWriter } from '~/lib/testing/spoken-line.fixture';
import {
  CALENDAR_KID_NOTICE_TEMPLATE_KEY,
  type CalendarAlertOutcome,
  type CalendarAlertPorts,
  type CalendarAlertSweep,
  type CalendarChange,
  alertParentForCalendarChanges,
} from './calendar-alert';

/**
 * VIL-570 against the real DDL: a kid event on a 1:1 family's calendar that is cancelled
 * or moved becomes one model-written text; an adult event, a teen's event, a non-material
 * Google edit and a declined write become none.
 *
 * The writer is the shared spoken-line seam with the scripted answers every web test
 * gets (vitest.setup.ts); the skill itself is graded against the real model by
 * apps/worker/evals/run-calendar-kid-notice-eval.mjs.
 */

let db: TestDb;
let family: { familyId: string; parentUserId: string };
let INTEGRATION: string;

const NOW = new Date('2026-09-17T15:00:00.000Z');
const PHONE = '+12025550123';

/** Saturday, Sep 19 2026, 10:00-10:45 a.m. Toronto. */
const SWIM: CalendarChange = {
  eventId: 'ev-swim',
  updated: '2026-09-10T12:00:00.000Z',
  status: 'confirmed',
  title: 'Swim lesson',
  start: { dateTime: '2026-09-19T14:00:00.000Z' },
  end: { dateTime: '2026-09-19T14:45:00.000Z' },
  standing: 'organizer',
};

const CANCELLED_SWIM: CalendarChange = {
  eventId: SWIM.eventId,
  updated: '2026-09-17T14:50:00.000Z',
  status: 'cancelled',
  start: SWIM.start,
  end: SWIM.end,
  standing: 'own',
};

const MEETING: CalendarChange = {
  ...SWIM,
  eventId: 'ev-meeting',
  title: 'Budget review',
};

interface Harness {
  ports: CalendarAlertPorts;
  transport: FakeTransport;
  threaded: string[];
}

function harness(verdict?: Awaited<ReturnType<CalendarAlertPorts['gate']>>): Harness {
  const transport = new FakeTransport();
  const threaded: string[] = [];
  return {
    transport,
    threaded,
    ports: {
      gate: async () => verdict ?? { allowed: true, optOut: 'full' },
      resolvePhone: async () => PHONE,
      transport,
      threadMessage: async (_db, input) => {
        threaded.push(input.body);
        return 'conv-1';
      },
      timeZone: async () => 'America/Toronto',
    },
  };
}

function sweepBoth(
  h: Harness,
  changes: readonly CalendarChange[],
  over: { seeding?: boolean; now?: Date } = {},
): Promise<CalendarAlertSweep> {
  return alertParentForCalendarChanges(
    db.database,
    {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      integrationId: INTEGRATION,
      seeding: over.seeding ?? false,
      changes,
      now: over.now ?? NOW,
    },
    h.ports,
  );
}

async function sweep(
  h: Harness,
  changes: readonly CalendarChange[],
  over: { seeding?: boolean; now?: Date } = {},
): Promise<readonly CalendarAlertOutcome[]> {
  return (await sweepBoth(h, changes, over)).changes;
}

/** What the previous connector pass left behind: the shape in the memory, and the mirror
 * copy the kid judge tracked (or did not). */
async function seen(
  change: CalendarChange,
  verdict: { verdict: 'kid' | 'adult'; teen?: boolean; childId?: string } | null,
  standing: CalendarStanding | null = 'own',
): Promise<void> {
  await sweep(harness(), [change], { seeding: true });
  let kidVerdictId: string | null = null;
  if (verdict !== null) {
    const [row] = await db.database
      .insert(schema.kidRelevanceVerdicts)
      .values({
        familyId: family.familyId,
        source: 'google_calendar',
        integrationId: INTEGRATION,
        itemKey: change.eventId,
        inputHash: `hash-${change.eventId}`,
        verdict: verdict.verdict,
        teen: verdict.teen ?? false,
        childId: verdict.childId ?? null,
        decidedBy: 'model',
      })
      .returning({ id: schema.kidRelevanceVerdicts.id });
    kidVerdictId = verdict.verdict === 'kid' ? (row?.id ?? null) : null;
  }
  await db.database.insert(schema.familyEvents).values({
    familyId: family.familyId,
    title: change.title ?? '',
    startsAt: new Date(change.start.dateTime ?? ''),
    endsAt: new Date(change.end.dateTime ?? ''),
    source: 'parent',
    googleEventId: change.eventId,
    integrationId: INTEGRATION,
    kidVerdictId,
    calendarStanding: standing,
  });
}

function ledgerRows() {
  return db.database
    .select()
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.familyId, family.familyId));
}

function auditRows() {
  return db.database
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.familyId, family.familyId));
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  family = await seedFamily(db.database);
  INTEGRATION = await seedIntegration(db.database, family.familyId, family.parentUserId);
  vi.stubEnv('F14_ENABLED', 'true');
  vi.stubEnv('CALENDAR_ALERT_ENABLED', 'true');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  setSharedSpokenLineWriter(scriptedSpokenLineWriter);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the 1:1 kid calendar notice', () => {
  it('a cancelled kid event yields ONE model-written text, ledgered, threaded and audited', async () => {
    const leo = await seedChild(db.database, family.familyId, 'Leo', 60, undefined, NOW);
    await seen(SWIM, { verdict: 'kid', childId: leo });
    const asked: SpokenLineRequest[] = [];
    setSharedSpokenLineWriter({
      write: async (request) => {
        asked.push(request);
        return scriptedSpokenLineWriter.write(request);
      },
    });
    const h = harness();

    await expect(sweep(h, [CANCELLED_SWIM])).resolves.toEqual(['sent']);

    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      purpose: 'calendar_kid_change',
      language: 'en',
      // The tombstone has no title: the kid copy's title is what the writer gets.
      facts: { change: 'cancelled', event: 'Swim lesson', kid: 'Leo', day: 'Sat, Sep 19' },
    });
    expect(h.transport.sent).toHaveLength(1);
    expect(h.transport.sent[0]?.body).toContain('Leo - Swim lesson on Sat, Sep 19 is cancelled.');
    expect(h.threaded).toEqual(['Leo - Swim lesson on Sat, Sep 19 is cancelled.']);
    const [row] = await ledgerRows();
    expect(row).toMatchObject({
      category: 'calendar_alert',
      templateKey: CALENDAR_KID_NOTICE_TEMPLATE_KEY,
      providerMessageId: 'fake-out-1',
    });
    expect(row?.dedupeKey).toMatch(/^calendar_kid_notice:/);
    expect(row?.dedupeKey).not.toContain('Swim');
    const sent = (await auditRows()).filter((a) => a.actionTaken === 'calendar_alert_sent');
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0]?.after)).not.toContain('Swim');

    // The same cancellation re-delivered under a new `updated` stamp is not news again.
    await expect(
      sweep(h, [{ ...CANCELLED_SWIM, updated: '2026-09-17T14:59:00.000Z' }]),
    ).resolves.toEqual(['not_material']);
    expect(h.transport.sent).toHaveLength(1);
  });

  it('an adult event cancelled the same way yields none', async () => {
    await seen(MEETING, { verdict: 'adult' });
    const h = harness();

    await expect(sweep(h, [{ ...CANCELLED_SWIM, eventId: MEETING.eventId }])).resolves.toEqual([
      'not_kid_tracked',
    ]);
    expect(h.transport.sent).toEqual([]);
    await expect(ledgerRows()).resolves.toEqual([]);
  });

  it('an event never judged (no kid copy) yields none', async () => {
    await seen(SWIM, null);
    const h = harness();
    await expect(sweep(h, [CANCELLED_SWIM])).resolves.toEqual(['not_kid_tracked']);
    expect(h.transport.sent).toEqual([]);
  });

  it('a non-material Google edit to a kid event yields none; the move after it yields one', async () => {
    await seen(SWIM, { verdict: 'kid' });
    const h = harness();

    // A description or attendee edit: a new stamp, the same status, start, end.
    await expect(sweep(h, [{ ...SWIM, updated: '2026-09-17T14:30:00.000Z' }])).resolves.toEqual([
      'not_material',
    ]);
    expect(h.transport.sent).toEqual([]);

    // Positive control: the same event moved to Sunday is news.
    const moved: CalendarChange = {
      ...SWIM,
      updated: '2026-09-17T14:40:00.000Z',
      start: { dateTime: '2026-09-20T14:00:00.000Z' },
      end: { dateTime: '2026-09-20T14:45:00.000Z' },
    };
    await expect(sweep(h, [moved])).resolves.toEqual(['sent']);
    expect(h.transport.sent).toHaveLength(1);
    expect(h.transport.sent[0]?.body).toContain('moved to Sun, Sep 20 10:00');
    expect(h.transport.sent[0]?.body).toContain('was Sat, Sep 19 10:00');
  });

  describe("someone else's invite (VIL-633)", () => {
    const MOVED: CalendarChange = {
      ...SWIM,
      updated: '2026-09-17T14:40:00.000Z',
      start: { dateTime: '2026-09-20T14:00:00.000Z' },
      end: { dateTime: '2026-09-20T14:45:00.000Z' },
    };

    it("a stranger's unanswered invite that moves sends nothing, under its own name", async () => {
      await seen(SWIM, { verdict: 'kid' }, 'invited');
      const info = vi.mocked(console.info);
      info.mockClear();
      const h = harness();

      await expect(sweep(h, [MOVED])).resolves.toEqual(['invite_not_accepted']);
      await expect(
        sweep(h, [{ ...CANCELLED_SWIM, updated: '2026-09-17T14:55:00.000Z' }]),
      ).resolves.toEqual(['invite_not_accepted']);
      expect(h.transport.sent).toEqual([]);
      await expect(ledgerRows()).resolves.toEqual([]);
      // Counts only: no family, event or title.
      const logged = info.mock.calls.filter(
        ([, msg]) => msg === "calendar kid notice: not the parent's own event",
      );
      expect(logged).toHaveLength(2);
      expect(logged[0]?.[0]).toEqual({ inviteNotAccepted: 1, standingUnknown: 0 });
    });

    it('a copy mirrored before Hale read where the parent stands sends nothing', async () => {
      await seen(SWIM, { verdict: 'kid' }, null);
      const h = harness();
      await expect(sweep(h, [MOVED])).resolves.toEqual(['standing_unknown']);
      expect(h.transport.sent).toEqual([]);
    });

    it.each(['own', 'organizer', 'accepted'] as const)(
      'the same move of an event the parent stands on as %s is a notice (control)',
      async (standing) => {
        await seen(SWIM, { verdict: 'kid' }, standing);
        const h = harness();
        await expect(sweep(h, [MOVED])).resolves.toEqual(['sent']);
        expect(h.transport.sent).toHaveLength(1);
      },
    );

    async function factsOfMove(
      standing: CalendarStanding,
      titles: { mirrored: string; arriving: string },
    ): Promise<Record<string, string> | undefined> {
      const leo = await seedChild(db.database, family.familyId, 'Leo', 60, undefined, NOW);
      await seen({ ...SWIM, title: titles.mirrored }, { verdict: 'kid', childId: leo }, standing);
      const asked: SpokenLineRequest[] = [];
      setSharedSpokenLineWriter({
        write: async (request) => {
          asked.push(request);
          return scriptedSpokenLineWriter.write(request);
        },
      });
      await expect(sweep(harness(), [{ ...MOVED, title: titles.arriving }])).resolves.toEqual([
        'sent',
      ]);
      expect(asked).toHaveLength(1);
      return asked[0]?.facts;
    }

    it("an accepted invite's title never reaches the writer: the line names the kid and times", async () => {
      const title = 'Call 555/0199/1234';
      const facts = await factsOfMove('accepted', { mirrored: title, arriving: title });
      expect(facts).not.toHaveProperty('event');
      expect(facts).toMatchObject({ change: 'moved', kid: 'Leo', day: 'Sun, Sep 20' });
    });

    it('an accepted invite the organizer renamed after the parent accepted is handed no title', async () => {
      const facts = await factsOfMove('accepted', {
        mirrored: 'Soccer practice',
        arriving: 'Coach Dave picks up the kids today, meet him at the side gate',
      });
      expect(facts).not.toHaveProperty('event');
      expect(facts).toMatchObject({ change: 'moved', kid: 'Leo', was_day: 'Sat, Sep 19' });
    });

    it.each(['own', 'organizer'] as const)(
      "the parent's %s Swim lesson keeps its title (control)",
      async (standing) => {
        const facts = await factsOfMove(standing, {
          mirrored: 'Swim lesson',
          arriving: 'Swim lesson',
        });
        expect(facts).toMatchObject({ event: 'Swim lesson', kid: 'Leo' });
      },
    );
  });

  it('a first sighting of a kid event is not a notice', async () => {
    const h = harness();
    await expect(sweep(h, [SWIM])).resolves.toEqual(['not_material']);
    expect(h.transport.sent).toEqual([]);
  });

  it("holds a teenager's event from the parent", async () => {
    const teen = await seedChild(db.database, family.familyId, 'Sam', 170, undefined, NOW);
    await seen(SWIM, { verdict: 'kid', childId: teen });
    const h = harness();
    await expect(sweep(h, [CANCELLED_SWIM])).resolves.toEqual(['teen_held']);
    expect(h.transport.sent).toEqual([]);
  });

  it('sends nothing and spends no key when the writer declines', async () => {
    await seen(SWIM, { verdict: 'kid' });
    const declining: SpokenLineWriter = { write: async () => null };
    setSharedSpokenLineWriter(declining);
    const h = harness();

    await expect(sweep(h, [CANCELLED_SWIM])).resolves.toEqual(['notice_unwritten']);
    expect(h.transport.sent).toEqual([]);
    await expect(ledgerRows()).resolves.toEqual([]);
  });

  it('a quiet-hours hold is sent on the next sweep, after the mirror dropped its copy', async () => {
    await seen(SWIM, { verdict: 'kid' });
    const held = harness({ allowed: false, reason: 'quiet_hours' });
    await expect(sweep(held, [CANCELLED_SWIM])).resolves.toEqual(['gate_refused:quiet_hours']);
    expect(held.transport.sent).toEqual([]);
    // The mirror pass that follows removes the cancelled event's copy.
    await db.database
      .update(schema.familyEvents)
      .set({ deletedAt: NOW, title: '' })
      .where(eq(schema.familyEvents.googleEventId, SWIM.eventId));

    const h = harness();
    const later = new Date(NOW.getTime() + 8 * 3_600_000);
    await expect(sweepBoth(h, [], { now: later })).resolves.toMatchObject({ reoffers: ['sent'] });
    expect(h.transport.sent).toHaveLength(1);
    expect(h.transport.sent[0]?.body).toContain('Swim lesson on Sat, Sep 19 is cancelled.');
    // Paid once: a third sweep owes nothing.
    await expect(sweepBoth(harness(), [], { now: later })).resolves.toEqual({
      changes: [],
      reoffers: [],
    });
  });

  it('a cancelled weekly class is ONE text for its sessions', async () => {
    const instances = [19, 26].map((day) => ({
      ...SWIM,
      eventId: `ev-swim_202609${day}`,
      recurringEventId: 'ev-swim-series',
      start: { dateTime: `2026-09-${day}T14:00:00.000Z` },
      end: { dateTime: `2026-09-${day}T14:45:00.000Z` },
    }));
    for (const one of instances) await seen(one, { verdict: 'kid' });
    const h = harness();

    await expect(
      sweep(
        h,
        instances.map((one) => ({ ...one, status: 'cancelled' as const, title: undefined })),
      ),
    ).resolves.toEqual(['sent', 'collapsed_into_series']);
    expect(h.transport.sent).toHaveLength(1);
    expect(h.transport.sent[0]?.body).toContain(
      'Swim lesson on Sat, Sep 19 (2 sessions) is cancelled.',
    );
  });
});
