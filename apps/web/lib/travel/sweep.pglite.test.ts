import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityFindResult, ActivityPick } from '~/lib/channel/activity/lane';
import type { ActivityQuery } from '~/lib/channel/activity/deidentify';
import { dedupeActive } from '~/lib/channel/ledger';
import {
  PROACTIVE_CAP,
  PROACTIVE_CATEGORY,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
} from '~/lib/channel/outbound-gate';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  type TravelBriefDeps,
  type TravelBriefResult,
  defaultTravelBriefDeps,
  runTravelBriefSweep,
  travelBriefDedupeKey,
  travelBriefHoldKey,
} from './sweep';

/**
 * THE SEND SWEEP THROUGH ITS OWN PRODUCTION WIRING, against real Postgres.
 *
 * Everything this sweep is judged on is a query or a write: which trips are due on the
 * PARENT's calendar day, which overlapping rows fold into one text, whether a held trip
 * comes back, whether a closed one does not, and how many receipt rows a week of quiet
 * hours leaves behind. None of that is observable through a Drizzle chain fake.
 *
 * Only four things are ports here: the phone network, the web, and the two pieces of
 * consent/enrolment state the gate reads from tables this file does not seed. The due
 * query, the collapse, the dedupe keys, the ledger writes, the children read, the
 * de-identification and the composer are all production code.
 *
 * pglite boots in `beforeAll`, data is truncated in `afterEach` — never a boot inside
 * `it()`.
 */

const TORONTO = 'America/Toronto';
const VANCOUVER = 'America/Vancouver';
/** 09:00 Toronto on Saturday 5 September 2026 — inside everyone's waking window. */
const MORNING = new Date('2026-09-05T13:00:00.000Z');
/** 22:30 Toronto the same evening: inside the 21:00-08:00 proactive quiet window. */
const LATE = new Date('2026-09-06T02:30:00.000Z');

let db: TestDb;
let database: Database;

beforeAll(async () => {
  db = await createTestDb();
  database = db.database;
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv('F14_ENABLED', 'true');
  vi.stubEnv('TRAVEL_BRIEF_ENABLED', 'true');
  vi.stubEnv('TRAVEL_BRIEF_FAMILY_ALLOWLIST', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await db.exec('truncate table families, users cascade');
});

async function seedFamily(
  input: {
    timeZone?: string;
    children?: Array<{ name: string; dateOfBirth: string }>;
  } = {},
) {
  const [family] = await database
    .insert(schema.families)
    .values({ displayName: 'Chen', provinceOrState: 'ON', onboardingStage: 'sms_active' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const [user] = await database
    .insert(schema.users)
    .values({
      externalAuthId: `sms:${familyId}`,
      name: 'Sarah',
      timezone: input.timeZone ?? TORONTO,
    })
    .returning({ id: schema.users.id });
  const parentUserId = user?.id as string;
  await database
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });
  for (const child of input.children ?? [{ name: 'Mia', dateOfBirth: '2022-04-01' }]) {
    await database.insert(schema.children).values({ familyId, ...child });
  }
  return { familyId, parentUserId };
}

let tripSeq = 0;
async function seedTrip(input: {
  familyId: string;
  parentUserId: string;
  startsOn: string;
  endsOn: string;
  city?: string;
  region?: string | null;
}) {
  tripSeq += 1;
  const [trip] = await database
    .insert(schema.familyTrips)
    .values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      integrationId: '99999999-9999-4999-8999-999999999999',
      messageId: `gmail-${tripSeq}`,
      destinationCity: input.city ?? 'New York',
      destinationRegion: input.region === undefined ? 'NY' : input.region,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      childEvidence: 'named_traveller',
    })
    .returning({ id: schema.familyTrips.id });
  return trip?.id as string;
}

const PICKS: ActivityPick[] = [
  {
    name: 'American Museum of Natural History',
    ageFit: 'all ages',
    when: 'open daily 10am-5:30pm',
    price: 'USD 28 adults / 16 kids',
    sourceName: 'American Museum of Natural History',
    source: 'web',
  },
  {
    name: 'Central Park Zoo',
    ageFit: 'all ages',
    when: '10am-5pm',
    price: 'USD 20',
    sourceName: 'Central Park Zoo',
    source: 'web',
  },
];

interface Harness {
  deps: TravelBriefDeps;
  sent: Array<{ to: string; body: string }>;
  queries: ActivityQuery[];
}

/** The real deps, with only the phone network, the web and the gate's two consent reads
 * standing in. The cap, the timezone and the quiet-hours floor are the real ones. */
function harness(options: { find?: ActivityFindResult } = {}): Harness {
  const sent: Array<{ to: string; body: string }> = [];
  const queries: ActivityQuery[] = [];
  return {
    sent,
    queries,
    deps: {
      ...defaultTravelBriefDeps(),
      finder: {
        find: async (query) => {
          queries.push(query);
          return options.find ?? { found: true, picks: PICKS };
        },
      },
      buildGate: (d) => ({
        ...buildOutboundGatePorts(d),
        channelEnrolled: async () => true,
        watchConsentGranted: async () => true,
      }),
      resolvePhone: async () => '+14165550100',
      transport: {
        send: async (input) => {
          sent.push(input);
          return { providerMessageId: `prov-${sent.length}` };
        },
      },
    },
  };
}

function run(h: Harness, now = MORNING): Promise<TravelBriefResult> {
  return runTravelBriefSweep(database, h.deps, now);
}

async function tripRow(id: string) {
  const [row] = await database
    .select()
    .from(schema.familyTrips)
    .where(eq(schema.familyTrips.id, id));
  return row;
}

async function ledgerRows(familyId: string) {
  return database
    .select({
      dedupeKey: schema.channelMessages.dedupeKey,
      status: schema.channelMessages.status,
      body: schema.channelMessages.body,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, familyId),
        eq(schema.channelMessages.category, 'travel_brief'),
      ),
    );
}

describe('who is due, and on whose clock', () => {
  /**
   * The lead window is seven days, measured on the PARENT's calendar day. A boundary
   * computed on UTC is wrong for seven hours of every day, which is why the family here
   * sits in Vancouver on a run clock where the UTC date and the local date differ.
   */
  it('is due at exactly seven days and not at eight, in the parent zone', async () => {
    // 2026-09-06T02:00Z is the 6th in UTC and still the 5th (19:00) in Vancouver — late
    // enough that the two dates disagree, early enough to be outside quiet hours.
    const at = new Date('2026-09-06T02:00:00.000Z');
    const family = await seedFamily({ timeZone: VANCOUVER });
    // Seven days from the parent's local today (the 5th).
    const due = await seedTrip({ ...family, startsOn: '2026-09-12', endsOn: '2026-09-15' });
    const h = harness();
    const result = await run(h, at);
    expect(result.due).toBe(1);
    expect(result.sent).toBe(1);
    expect((await tripRow(due))?.closedReason).toBe('sent');
  });

  it('is not due at eight days — the control the boundary above needs', async () => {
    const at = new Date('2026-09-06T02:00:00.000Z');
    const family = await seedFamily({ timeZone: VANCOUVER });
    await seedTrip({ ...family, startsOn: '2026-09-13', endsOn: '2026-09-16' });
    const h = harness();
    const result = await run(h, at);
    expect(result.due).toBe(0);
    expect(h.sent).toEqual([]);
    // And computing it on UTC instead would have called the 13th seven days out, because
    // the UTC date is already the 6th.
  });

  it('a trip detected INSIDE the lead window is due immediately', async () => {
    const family = await seedFamily();
    await seedTrip({ ...family, startsOn: '2026-09-07', endsOn: '2026-09-09' });
    expect((await run(harness())).sent).toBe(1);
  });
});

describe('what the parent actually gets', () => {
  it('names the city and both picks, and writes one audit row of counts', async () => {
    const family = await seedFamily();
    const trip = await seedTrip({ ...family, startsOn: '2026-09-12', endsOn: '2026-09-15' });
    const h = harness();
    const result = await run(h);

    expect(result.sent).toBe(1);
    expect(h.sent).toHaveLength(1);
    const body = h.sent[0]?.body ?? '';
    expect(body).toContain('New York');
    expect(body).toContain('American Museum of Natural History');
    expect(body).toContain('Central Park Zoo');
    expect(body).toContain('Mia');
    // The CASL line is on the wire.
    expect(body).toContain('Reply STOP');

    // The query that crossed the border carried a place, a coarse window with no year and
    // a stage band — and no name.
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0]?.town).toBe('New York, NY');
    expect(h.queries[0]?.window).toBe('September 12 to 15');
    expect(h.queries[0]?.stage).toBe('preschool');
    expect(JSON.stringify(h.queries[0])).not.toContain('Mia');

    const closed = await tripRow(trip);
    expect(closed?.closedReason).toBe('sent');
    expect(closed?.closedAt).not.toBeNull();
    expect(closed?.briefChannelMessageId).not.toBeNull();

    const [audit] = await database
      .select({ after: schema.auditLog.after, targetTable: schema.auditLog.targetTable })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'travel_brief_sent'));
    expect(audit?.targetTable).toBe('channel_messages');
    // Counts, not names.
    expect(audit?.after).toEqual({ picks: 2, merged: 0 });
    expect(JSON.stringify(audit?.after)).not.toContain('New York');

    // The composed sentence is threaded for the coach to re-read, WITHOUT the CASL line:
    // the opt-out belongs on the wire, and the coach re-reads this row next turn.
    const [threaded] = await database
      .select({ content: schema.messages.content })
      .from(schema.messages);
    expect(threaded?.content).toContain('American Museum of Natural History');
    expect(threaded?.content).not.toContain('Reply STOP');
  });

  /**
   * R4 · THE FLIGHT AND THE HOTEL ARE ONE PIECE OF NEWS. Two emails, two extractions, two
   * rows, dates a day apart — and one text. The calendar alert's series collapse applied
   * to the same problem.
   */
  it('folds an overlapping trip into the same text, and both rows carry that message', async () => {
    const family = await seedFamily();
    const flight = await seedTrip({ ...family, startsOn: '2026-09-12', endsOn: '2026-09-15' });
    const hotel = await seedTrip({ ...family, startsOn: '2026-09-13', endsOn: '2026-09-16' });

    const h = harness();
    const result = await run(h);
    expect(result.sent).toBe(1);
    expect(result.merged).toBe(1);
    expect(h.sent).toHaveLength(1);

    const a = await tripRow(flight);
    const b = await tripRow(hotel);
    // The earliest carried the text; the other closed into it.
    expect(a?.closedReason).toBe('sent');
    expect(b?.closedReason).toBe('merged');
    expect(b?.briefChannelMessageId).toBe(a?.briefChannelMessageId);

    const [audit] = await database
      .select({ after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'travel_brief_sent'));
    expect(audit?.after).toEqual({ picks: 2, merged: 1 });
  });

  it('leaves a NON-overlapping second trip open — the control for the collapse', async () => {
    const family = await seedFamily();
    await seedTrip({ ...family, startsOn: '2026-09-07', endsOn: '2026-09-08' });
    const later = await seedTrip({ ...family, startsOn: '2026-09-11', endsOn: '2026-09-12' });
    const result = await run(harness());
    expect(result.merged).toBe(0);
    expect((await tripRow(later))?.closedAt).toBeNull();
  });
});

describe('the searches that never run', () => {
  it('a teen-only household is never searched for', async () => {
    const family = await seedFamily({ children: [{ name: 'Ari', dateOfBirth: '2010-01-01' }] });
    await seedTrip({ ...family, startsOn: '2026-09-12', endsOn: '2026-09-15' });
    const h = harness();
    const result = await run(h);
    expect(result.teenOnlyHousehold).toBe(1);
    // R6 is about NOT SEARCHING, not about not sending.
    expect(h.queries).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it('a family with no children on file is not searched for either', async () => {
    const family = await seedFamily({ children: [] });
    await seedTrip({ ...family, startsOn: '2026-09-12', endsOn: '2026-09-15' });
    const h = harness();
    const result = await run(h);
    expect(result.noChildrenOnFile).toBe(1);
    expect(h.queries).toEqual([]);
  });

  /** A child called Paris, and a trip to Paris. Refused at the query gate as well as at
   * the parse boundary, because the household can change between the two. */
  it('refuses a destination that names a child, by reason', async () => {
    const family = await seedFamily({ children: [{ name: 'Paris', dateOfBirth: '2022-04-01' }] });
    await seedTrip({
      ...family,
      startsOn: '2026-09-12',
      endsOn: '2026-09-15',
      city: 'Paris',
      region: 'France',
    });
    const h = harness();
    const result = await run(h);
    expect(result.queryRefused.names_a_person).toBe(1);
    expect(h.queries).toEqual([]);
  });

  it('a search that found nothing sends nothing and leaves the trip OPEN', async () => {
    const family = await seedFamily();
    const trip = await seedTrip({ ...family, startsOn: '2026-09-12', endsOn: '2026-09-15' });
    const h = harness({ find: { found: false, reason: 'no_picks' } });
    const result = await run(h);
    expect(result.noPicks).toBe(1);
    expect(h.sent).toEqual([]);
    // A search that found nothing is not a brief the parent received.
    expect((await tripRow(trip))?.closedAt).toBeNull();
  });
});

describe('the hold, and how many rows a week of it leaves', () => {
  /**
   * A due trip is re-selected HOURLY FOR UP TO SEVEN DAYS. The email alert's unkeyed
   * suppression row would write ~11 of these in one night and up to 168 per trip — a
   * receipts ledger full of noise on the one surface a support agent reads.
   */
  it('writes ONE receipt per trip per reason, however many ticks run', async () => {
    const family = await seedFamily();
    const trip = await seedTrip({ ...family, startsOn: '2026-09-12', endsOn: '2026-09-15' });
    const h = harness();

    const first = await run(h, LATE);
    expect(first.held.quiet_hours).toBe(1);
    expect(h.sent).toEqual([]);
    // A hold is not a close: the trip comes back next tick.
    expect((await tripRow(trip))?.closedAt).toBeNull();

    // ELEVEN MORE TICKS, the shape of one night. `channel_messages.dedupe_key` is unique
    // over non-null keys, so the KEY alone already stops a twelfth ROW — what
    // `.onConflictDoNothing()` buys on top of it is that the second tick is a clean
    // no-op rather than a raise the sweep has to catch. So `failed` is the assertion that
    // matters here: without it, dropping the clause would leave this test green while
    // every tick after the first counted as a failure and the hold stopped being counted
    // at all.
    for (let tick = 0; tick < 11; tick += 1) {
      const again = await run(h, LATE);
      expect(again.failed, `tick ${tick}`).toBe(0);
      expect(again.held.quiet_hours, `tick ${tick}`).toBe(1);
    }
    const rows = await ledgerRows(family.familyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dedupeKey).toBe(travelBriefHoldKey(trip, 'quiet_hours'));
    expect(rows[0]?.status).toBe('suppressed_quiet_hours');

    // A DIFFERENT reason on the same trip mints a SECOND row, not a twelfth — the key is
    // per reason, so the ledger still records each distinct decision exactly once.
    await database
      .insert(schema.channelMessages)
      .values({
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        channel: 'sms',
        direction: 'out',
        category: 'travel_brief',
        templateKey: 'travel:brief',
        dedupeKey: travelBriefHoldKey(trip, 'frequency_cap'),
        status: 'suppressed_cap',
      })
      .onConflictDoNothing();
    expect(await ledgerRows(family.familyId)).toHaveLength(2);

    // AND THE HOLD CANNOT BLOCK THE SEND IT RECORDS. Two independent reasons: the send's
    // key is a different string, and `dedupeActive` reads CONSUMED_SEND_STATUSES only,
    // which no `suppressed_*` status is in.
    expect(await dedupeActive(travelBriefDedupeKey(trip), database)).toBe(false);
    const morning = await run(h, MORNING);
    expect(morning.sent).toBe(1);
  });

  /**
   * `urgent: true` at the call site must not widen the class. URGENCY_ALLOWED is read per
   * CLASS precisely so a caller cannot reach the exemption with a flag.
   */
  it('stays held at 22:30 even when the CALLER claims urgency', async () => {
    const family = await seedFamily();
    await seedTrip({ ...family, startsOn: '2026-09-12', endsOn: '2026-09-15' });
    const h = harness();
    expect((await run(h, LATE)).held.quiet_hours).toBe(1);
    expect(h.sent).toEqual([]);

    // The sweep has no `urgent` argument, so the mutation this pins is one a maker would
    // make AT THE GATE CALL: URGENCY_ALLOWED is read per CLASS precisely so a flag at a
    // call site cannot widen the exemption. Asked directly, with the flag set, the same
    // gate still refuses.
    const urgent = await assertProactiveSendAllowed(
      {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        kind: 'travel_brief',
        now: LATE,
        urgent: true,
      },
      h.deps.buildGate(database),
    );
    expect(urgent).toEqual({ allowed: false, reason: 'quiet_hours' });

    // The positive control: the same class, the same ports, in the morning.
    const morning = await assertProactiveSendAllowed(
      {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        kind: 'travel_brief',
        now: MORNING,
      },
      h.deps.buildGate(database),
    );
    expect(morning.allowed).toBe(true);

    // And the budget the class was forced to choose.
    expect(PROACTIVE_CAP.travel_brief).toEqual({ max: 1, windowHours: 168 });
    expect(PROACTIVE_CATEGORY.travel_brief).toBe('travel_brief');
  });
});

describe('a trip closes exactly once', () => {
  it('is absent from the due set on the next tick', async () => {
    const family = await seedFamily();
    await seedTrip({ ...family, startsOn: '2026-09-12', endsOn: '2026-09-15' });
    const h = harness();
    expect((await run(h)).sent).toBe(1);

    const second = await run(h);
    expect(second.due).toBe(0);
    expect(second.sent).toBe(0);
    expect(h.sent).toHaveLength(1);
  });

  /**
   * SENT TWICE. Two ticks racing the same trip resolve at the claim, not at the read — one
   * ledger row, one transport call. The dedupe read is the cost guard; the insert is the
   * correctness one.
   */
  it('claims the send, so a concurrent tick cannot double it', async () => {
    const family = await seedFamily();
    const trip = await seedTrip({ ...family, startsOn: '2026-09-12', endsOn: '2026-09-15' });
    const h = harness();
    // Both ticks pass the cost guard, because neither has written a row yet.
    // BOTH RAILS IN FRONT OF THE CLAIM ARE TAKEN OUT OF THE WAY, on purpose: the cost
    // guard (`dedupeActive`) and the weekly cap would each stop the second tick before it
    // reached the insert, so leaving either in place would make this test pass on a claim
    // that had no conflict clause at all. What is under test is the LAST guard.
    const blind: TravelBriefDeps = {
      ...h.deps,
      dedupeActive: async () => false,
      buildGate: (d) => ({ ...h.deps.buildGate(d), countProactiveSends: async () => 0 }),
    };
    const first = await runTravelBriefSweep(database, blind, MORNING);
    expect(first.sent).toBe(1);
    // The trip is closed now, so force the second tick at the same row by reopening it —
    // which is exactly the state a crash between the send and the close would leave.
    await database
      .update(schema.familyTrips)
      .set({ closedAt: null, closedReason: null, briefChannelMessageId: null })
      .where(eq(schema.familyTrips.id, trip));
    const second = await runTravelBriefSweep(database, blind, MORNING);

    // The unique index on `dedupe_key` is what makes at-most-once true; what
    // `.onConflictDoNothing()` adds is that the losing tick RETURNS rather than raising.
    // Both are asserted, because a claim that raised would still send only once and would
    // still leave this household counted as a failure every tick, forever.
    expect(second.sent).toBe(0);
    expect(second.failed).toBe(0);
    expect(h.sent).toHaveLength(1);
    const rows = (await ledgerRows(family.familyId)).filter(
      (row) => row.dedupeKey === travelBriefDedupeKey(trip),
    );
    expect(rows).toHaveLength(1);
  });

  /**
   * OVERTAKEN. `starts_on` passed while the trip was still open, so it closes with a NULL
   * message id — which the COALESCE'd CHECK permits and the other two reasons forbid.
   */
  it('closes a trip whose start has passed, once, with no message behind it', async () => {
    const family = await seedFamily();
    const past = await seedTrip({ ...family, startsOn: '2026-09-04', endsOn: '2026-09-06' });
    const h = harness();
    const result = await run(h);
    expect(result.overtaken).toBe(1);
    expect(result.due).toBe(0);
    expect(h.sent).toEqual([]);

    const row = await tripRow(past);
    expect(row?.closedReason).toBe('overtaken');
    expect(row?.briefChannelMessageId).toBeNull();

    // Counted at the write that closes it, so it is counted exactly once and does not come
    // back on the next tick.
    expect((await run(h)).overtaken).toBe(0);
  });
});

describe('the flags', () => {
  it('does nothing at all while the travel flag is off, even with F14 on', async () => {
    vi.stubEnv('TRAVEL_BRIEF_ENABLED', '');
    const family = await seedFamily();
    await seedTrip({ ...family, startsOn: '2026-09-12', endsOn: '2026-09-15' });
    const h = harness();
    const result = await run(h);
    expect(result).toEqual(expect.objectContaining({ enabled: false, due: 0 }));
    expect(h.queries).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it('the allowlist arms one household and not the one beside it', async () => {
    vi.stubEnv('TRAVEL_BRIEF_ENABLED', '');
    const armed = await seedFamily();
    const other = await seedFamily();
    vi.stubEnv('TRAVEL_BRIEF_FAMILY_ALLOWLIST', armed.familyId);
    await seedTrip({ ...armed, startsOn: '2026-09-12', endsOn: '2026-09-15' });
    const dark = await seedTrip({ ...other, startsOn: '2026-09-12', endsOn: '2026-09-15' });

    const h = harness();
    const result = await run(h);
    expect(result.sent).toBe(1);
    expect((await tripRow(dark))?.closedAt).toBeNull();
  });
});
