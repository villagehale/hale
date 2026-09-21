import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  type TravelDetectOutcome,
  type TravelDetectPorts,
  detectTravelBookingsForSweep,
} from './detect';
import type { TravelExtraction } from './extract';

/**
 * THE DETECT PASS AGAINST REAL POSTGRES.
 *
 * The invariants this feature rests on are writes and non-writes, and neither is
 * observable through a Drizzle chain fake: "a solo booking writes no row" is a claim about
 * what `select count(*)` returns, and "a dark family's mailbox is never opened" is a claim
 * about a port that must not be CALLED. Both are held here.
 *
 * pglite boots in `beforeAll` and the data is truncated in `afterEach` — never a boot
 * inside `it()`, which is the recorded 5000ms "flake".
 */

const TZ = 'America/Toronto';
const NOW = new Date('2026-09-01T15:00:00.000Z');
const INTEGRATION_ID = '99999999-9999-4999-8999-999999999999';

let db: TestDb;
let database: Database;
let familyId: string;
let parentUserId: string;

beforeAll(async () => {
  db = await createTestDb();
  database = db.database;
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  vi.stubEnv('F14_ENABLED', 'true');
  vi.stubEnv('TRAVEL_BRIEF_ENABLED', 'true');
  vi.stubEnv('TRAVEL_BRIEF_FAMILY_ALLOWLIST', '');
  const [family] = await database
    .insert(schema.families)
    .values({ displayName: 'Chen', provinceOrState: 'ON', areaCoarse: 'M4K' })
    .returning({ id: schema.families.id });
  familyId = family?.id as string;
  const [user] = await database
    .insert(schema.users)
    .values({ externalAuthId: `sms:${familyId}`, name: 'Sarah', timezone: TZ })
    .returning({ id: schema.users.id });
  parentUserId = user?.id as string;
  await database
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });
  await database
    .insert(schema.children)
    .values({ familyId, name: 'Mia', dateOfBirth: '2022-04-01' });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await db.exec('truncate table families, users cascade');
});

/** A booking-shaped envelope: a booking noun in the subject and a travel co-token. */
function envelope(overrides: Partial<{ messageId: string; subject: string; snippet: string }> = {}) {
  return {
    messageId: overrides.messageId ?? 'msg-1',
    subject: overrides.subject ?? 'Your itinerary for AC 704',
    from: 'Air Canada <noreply@aircanada.ca>',
    snippet: overrides.snippet ?? 'Departure Toronto YYZ, boarding 8:10',
    receivedAt: '2026-09-01T12:00:00.000Z',
  };
}

const GOOD: TravelExtraction = {
  destinationCity: 'New York',
  destinationRegion: 'NY',
  startDate: '2026-09-12',
  endDate: '2026-09-15',
  childEvidence: 'named_traveller',
  confidence: 0.9,
  usage: { promptTokens: 1, completionTokens: 1 },
};

interface Spy {
  ports: TravelDetectPorts;
  bodyFetches: string[];
  extractions: number;
}

function ports(
  extraction: Partial<TravelExtraction> | (() => Promise<TravelExtraction>) = {},
  opts: { fetchBody?: () => Promise<string> } = {},
): Spy {
  const bodyFetches: string[] = [];
  const spy: Spy = {
    bodyFetches,
    extractions: 0,
    ports: {
      fetchBody: async (messageId) => {
        bodyFetches.push(messageId);
        if (opts.fetchBody) return opts.fetchBody();
        return 'Toronto to New York, Sep 12, return Sep 15. Passengers: SARAH CHEN, MIA CHEN.';
      },
      extract: async () => {
        spy.extractions += 1;
        if (typeof extraction === 'function') return extraction();
        return { ...GOOD, ...extraction };
      },
      childFirstNames: async () => ['Mia'],
      householdNames: async () => ['Mia', 'Sarah'],
      timeZone: async () => TZ,
    },
  };
  return spy;
}

function run(
  spy: Spy,
  input: Partial<{ seeding: boolean; envelopes: ReturnType<typeof envelope>[]; parentUserId: string | null }> = {},
): Promise<readonly TravelDetectOutcome[]> {
  return detectTravelBookingsForSweep(
    database,
    {
      familyId,
      parentUserId: input.parentUserId === undefined ? parentUserId : input.parentUserId,
      integrationId: INTEGRATION_ID,
      seeding: input.seeding ?? false,
      envelopes: input.envelopes ?? [envelope()],
      now: NOW,
    },
    spy.ports,
  );
}

async function tripCount(): Promise<number> {
  return (await database.select({ id: schema.familyTrips.id }).from(schema.familyTrips)).length;
}

async function auditRows(verb: string) {
  return database
    .select({ after: schema.auditLog.after, targetTable: schema.auditLog.targetTable })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.actionTaken, verb));
}

describe('the detect pass writes a trip', () => {
  it('turns one booking email into one row, and one enum-only audit line', async () => {
    const spy = ports();
    expect(await run(spy)).toEqual(['trip_written']);

    const [trip] = await database.select().from(schema.familyTrips);
    expect(trip).toMatchObject({
      familyId,
      parentUserId,
      integrationId: INTEGRATION_ID,
      messageId: 'msg-1',
      destinationCity: 'New York',
      destinationRegion: 'NY',
      startsOn: '2026-09-12',
      endsOn: '2026-09-15',
      childEvidence: 'named_traveller',
      closedAt: null,
      closedReason: null,
      briefChannelMessageId: null,
    });

    // THE BODY IS NOWHERE. The extractor held it in one stack frame and the table has no
    // column that could take it — asserted over the whole serialised row rather than a
    // field list, so a column added later cannot quietly carry it.
    const serialised = JSON.stringify(trip);
    expect(serialised).not.toContain('Passengers');
    expect(serialised).not.toContain('MIA CHEN');
    expect(serialised).not.toContain('AC 704');

    const [noticed] = await auditRows('travel_trip_noticed');
    expect(noticed?.targetTable).toBe('family_trips');
    // Enums and counts only — never the city, never the dates.
    expect(noticed?.after).toEqual({ childEvidence: 'named_traveller', nights: 3 });
    const auditText = JSON.stringify(noticed?.after);
    expect(auditText).not.toContain('New York');
    expect(auditText).not.toContain('2026-09');
  });

  it('the same message twice is one row and an `already_seen`', async () => {
    expect(await run(ports())).toEqual(['trip_written']);
    expect(await run(ports())).toEqual(['already_seen']);
    expect(await tripCount()).toBe(1);
  });
});

describe('the flags gate collection, not just the send', () => {
  /**
   * A dark family's mailbox is NOT OPENED. The assertion is on the body fetch's call
   * count, because "nothing was written" would also be true of a family whose mail was
   * read and then discarded — and reading it is the thing the flag exists to prevent.
   */
  it('reads nothing and writes nothing while dark', async () => {
    vi.stubEnv('TRAVEL_BRIEF_ENABLED', '');
    const spy = ports();
    expect(await run(spy)).toEqual(['dark']);
    expect(spy.bodyFetches).toEqual([]);
    expect(spy.extractions).toBe(0);
    expect(await tripCount()).toBe(0);
  });

  it('F14 being off is dark too, and it is checked first', async () => {
    vi.stubEnv('F14_ENABLED', '');
    vi.stubEnv('F14_FAMILY_ALLOWLIST', '');
    const spy = ports();
    expect(await run(spy)).toEqual(['dark']);
    expect(spy.bodyFetches).toEqual([]);
  });

  /** The allowlist arms exactly this family — the live probe's own mechanism. */
  it('the allowlist arms one household while the global flag stays off', async () => {
    vi.stubEnv('TRAVEL_BRIEF_ENABLED', '');
    vi.stubEnv('TRAVEL_BRIEF_FAMILY_ALLOWLIST', familyId);
    const spy = ports();
    expect(await run(spy)).toEqual(['trip_written']);
    expect(spy.bodyFetches).toEqual(['msg-1']);
  });

  it('a seeding run reads the mailbox history and writes nothing', async () => {
    const spy = ports();
    expect(await run(spy, { seeding: true })).toEqual(['seeding_run']);
    expect(spy.bodyFetches).toEqual([]);
    expect(await tripCount()).toBe(0);
  });

  it('a connection with no user has nobody to text, which is an outcome', async () => {
    const spy = ports();
    expect(await run(spy, { parentUserId: null })).toEqual(['no_parent_user']);
    expect(spy.bodyFetches).toEqual([]);
  });
});

describe('the pre-filter spends nothing on a mailbox', () => {
  it('a non-booking envelope never reaches the body fetch', async () => {
    const spy = ports();
    const outcomes = await run(spy, {
      envelopes: [
        envelope({ messageId: 'm1', subject: 'Your order has shipped', snippet: 'tracking' }),
        envelope({ messageId: 'm2' }),
      ],
    });
    expect([...outcomes].sort()).toEqual(['not_booking_shaped', 'trip_written']);
    // Only the booking-shaped one was paid for.
    expect(spy.bodyFetches).toEqual(['m2']);
  });

  it('caps the extractions per connection per sweep, newest first', async () => {
    const spy = ports();
    const envelopes = [1, 2, 3, 4].map((n) => ({
      ...envelope({ messageId: `m${n}` }),
      receivedAt: `2026-09-0${n}T12:00:00.000Z`,
    }));
    const outcomes = await run(spy, { envelopes });
    expect(outcomes.filter((o) => o === 'over_sweep_cap')).toHaveLength(1);
    expect(spy.extractions).toBe(3);
    // Newest first: m1 (the oldest) is the one that falls off.
    expect(spy.bodyFetches.sort()).toEqual(['m2', 'm3', 'm4']);
  });
});

describe('the parse boundary refuses before it writes', () => {
  /**
   * A confirmation number or a property line in the city column. Refused at the PARSE
   * boundary — the point is the WRITE, not the string: at the query boundary the value
   * would already be persisted and served to the rights export.
   */
  it('a reference, a property line or a room number is `destination_unusable`, with no row', async () => {
    for (const city of ['Marriott #4471', 'ABC123', 'Room 412', '1535 Broadway']) {
      expect(await run(ports({ destinationCity: city }))).toEqual(['destination_unusable']);
    }
    expect(await tripCount()).toBe(0);
    // Positive control: a real city on the same path does write.
    expect(await run(ports())).toEqual(['trip_written']);
    expect(await tripCount()).toBe(1);
  });

  it('a household member in the city column is refused before it is stored', async () => {
    expect(await run(ports({ destinationCity: 'Mia' }))).toEqual(['destination_unusable']);
    expect(await tripCount()).toBe(0);
  });

  it('an unusable REGION refuses the whole row, not just the field', async () => {
    expect(
      await run(ports({ destinationCity: 'New York', destinationRegion: 'Suite 14B' })),
    ).toEqual(['destination_unusable']);
    expect(await tripCount()).toBe(0);
  });
});

describe('the rules that decide whether a trip is a trip', () => {
  /**
   * A home-metro list is an absence assertion and fails open, so the positive control
   * sits in the same `it`: Ottawa is away and writes.
   */
  it('a Scarborough hotel is `not_away`, and Ottawa is not', async () => {
    expect(await run(ports({ destinationCity: 'Scarborough' }))).toEqual(['not_away']);
    expect(await tripCount()).toBe(0);
    expect(await run(ports({ destinationCity: 'Ottawa' }))).toEqual(['trip_written']);
    expect(await tripCount()).toBe(1);
  });

  it('a 30-night stay is a lease, not a trip', async () => {
    expect(await run(ports({ startDate: '2026-09-12', endDate: '2026-10-12' }))).toEqual([
      'implausible_window',
    ]);
    expect(await tripCount()).toBe(0);
  });

  it('a trip that has already started is in the past', async () => {
    expect(await run(ports({ startDate: '2026-08-20', endDate: '2026-08-25' }))).toEqual([
      'in_the_past',
    ]);
  });

  it('a one-way flight has no end, so it is `no_dates`', async () => {
    expect(await run(ports({ endDate: null }))).toEqual(['no_dates']);
    expect(await tripCount()).toBe(0);
  });

  it('a restaurant booking that got past the filter simply has no city', async () => {
    expect(await run(ports({ destinationCity: null }))).toEqual(['no_destination']);
  });

  it('a doubtful read is silence rather than a fault', async () => {
    expect(await run(ports({ confidence: 0.4 }))).toEqual(['low_confidence']);
    expect(await tripCount()).toBe(0);
    // Positive control: the same answer above the floor writes.
    expect(await run(ports({ confidence: 0.6 }))).toEqual(['trip_written']);
  });
});

describe('a booking with no child evidence', () => {
  /**
   * THE PRECISION TRADE, and the row that measures it. No trip is stored — a parent's
   * destination and travel dates for a trip Hale had already decided never to mention is
   * a fact with no purpose (PIPEDA) and the single row a co-parent's export would
   * otherwise carry — and the miss is countable for a month on an enum-only audit line.
   */
  it('writes NO trip, and exactly one enum-only audit row', async () => {
    expect(await run(ports({ childEvidence: 'none' }))).toEqual(['no_child_evidence']);
    expect(await tripCount()).toBe(0);

    const rows = await auditRows('travel_booking_passed_over');
    expect(rows).toHaveLength(1);
    // The positive control FIRST: without it, `not.toContain('New York')` passes on an
    // empty object and this test proves nothing at all.
    expect(rows[0]?.after).toEqual({ childEvidence: 'none' });
    expect(rows[0]?.targetTable).toBeNull();
    const serialised = JSON.stringify(rows[0]?.after);
    expect(serialised).not.toContain('New York');
    expect(serialised).not.toContain('2026-09');
  });

  it("'none' is unwritable by anybody — the CHECK, not just the code path", async () => {
    await expect(
      database.insert(schema.familyTrips).values({
        familyId,
        parentUserId,
        integrationId: INTEGRATION_ID,
        messageId: 'hand-written',
        destinationCity: 'New York',
        startsOn: '2026-09-12',
        endsOn: '2026-09-15',
        childEvidence: 'none',
      }),
    ).rejects.toThrow();
    // Positive control: the same row with real evidence is accepted, so the rejection
    // above is about the value rather than about the insert.
    await database.insert(schema.familyTrips).values({
      familyId,
      parentUserId,
      integrationId: INTEGRATION_ID,
      messageId: 'hand-written',
      destinationCity: 'New York',
      startsOn: '2026-09-12',
      endsOn: '2026-09-15',
      childEvidence: 'child_fare',
    });
    expect(await tripCount()).toBe(1);
  });
});

describe('the boundaries around the two things that can fail', () => {
  it('a refused body fetch is its own outcome, distinct from a model that said nothing', async () => {
    const spy = ports(
      {},
      {
        fetchBody: async () => {
          throw new Error('gmail messages.get 404');
        },
      },
    );
    expect(await run(spy)).toEqual(['body_fetch_failed']);
    expect(spy.extractions).toBe(0);
  });

  it('a thrown extraction is `extract_failed`, and nothing is written', async () => {
    const spy = ports(async () => {
      throw new Error('travel_booking: tool call truncated at max_tokens (1024)');
    });
    expect(await run(spy)).toEqual(['extract_failed']);
    expect(await tripCount()).toBe(0);
  });
});

describe('the terminal CHECK', () => {
  /**
   * The assertion that catches the NULL-CHECK trap. A CHECK that evaluates to NULL PASSES
   * in Postgres, so the natural non-COALESCE form is vacuously true on every open row —
   * and both halves of this `it` would pass under it. It is the FIRST half that fails
   * without the COALESCE.
   */
  it("refuses a 'sent' close with no message behind it, and accepts one with", async () => {
    const [trip] = await database
      .insert(schema.familyTrips)
      .values({
        familyId,
        parentUserId,
        integrationId: INTEGRATION_ID,
        messageId: 'terminal',
        destinationCity: 'New York',
        startsOn: '2026-09-12',
        endsOn: '2026-09-15',
        childEvidence: 'child_fare',
      })
      .returning({ id: schema.familyTrips.id });

    await expect(
      database
        .update(schema.familyTrips)
        .set({ closedAt: NOW, closedReason: 'sent', briefChannelMessageId: null })
        .where(eq(schema.familyTrips.id, trip?.id as string)),
    ).rejects.toThrow();

    const [message] = await database
      .insert(schema.channelMessages)
      .values({
        familyId,
        parentUserId,
        channel: 'sms',
        direction: 'out',
        category: 'travel_brief',
        status: 'queued',
      })
      .returning({ id: schema.channelMessages.id });
    await database
      .update(schema.familyTrips)
      .set({ closedAt: NOW, closedReason: 'sent', briefChannelMessageId: message?.id as string })
      .where(eq(schema.familyTrips.id, trip?.id as string));
    const [closed] = await database.select().from(schema.familyTrips);
    expect(closed?.closedReason).toBe('sent');
  });

  it("an `overtaken` close carries NO message id, and that is permitted", async () => {
    const [trip] = await database
      .insert(schema.familyTrips)
      .values({
        familyId,
        parentUserId,
        integrationId: INTEGRATION_ID,
        messageId: 'overtaken',
        destinationCity: 'New York',
        startsOn: '2026-09-12',
        endsOn: '2026-09-15',
        childEvidence: 'child_fare',
      })
      .returning({ id: schema.familyTrips.id });
    await database
      .update(schema.familyTrips)
      .set({ closedAt: NOW, closedReason: 'overtaken' })
      .where(eq(schema.familyTrips.id, trip?.id as string));
    const [closed] = await database.select().from(schema.familyTrips);
    expect(closed?.closedReason).toBe('overtaken');
    expect(closed?.briefChannelMessageId).toBeNull();
  });
});
