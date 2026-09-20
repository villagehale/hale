import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { recordWatchConsent } from '~/lib/channel/intake/watch-consent';
import { REDRIVE_HOUR_LOCAL } from '~/lib/channel/redrive-slot';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { CO_PARENT_DEPARTED_NOTICE_BY_LANGUAGE } from './copy';
import { departCoParent } from './depart';
import { runDepartureNoticeRedrive } from './departure-redrive';
import {
  DEPARTURE_NOTICE_TEMPLATE_KEY,
  type DepartureNoticePorts,
  departureNoticeDedupeKey,
  departureNoticeReaders,
  tellStayingParent,
} from './departure-notice';

/**
 * B1 · the 23:00 departure that quiet hours held, and the morning that finishes it.
 *
 * `URGENCY_ALLOWED.co_parent_departed` is false on purpose — nobody is woken at 23:00 to
 * be told their co-parent left — and until this sweep existed that made the hold a DROP:
 * the receipt said Hale chose to be quiet and nothing ever chose otherwise, so a parent
 * whose household ended after dark was never told at all. The whole journey is here,
 * against the real DDL and through the real gate, because every step of it is a read of
 * live channel state, the consent ledger and a wall clock.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
/** 23:12 in America/Toronto (EDT, UTC-4) — inside the quiet window. */
const NIGHT = new Date('2026-09-17T03:12:00.000Z');
/** 08:12 the next morning, the same zone — the re-drive hour. */
const MORNING = new Date('2026-09-17T12:12:00.000Z');
/** 12:12 the same day — a tick that is not the re-drive hour. */
const NOON = new Date('2026-09-17T16:12:00.000Z');

let db: TestDb;
let households = 0;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  vi.stubEnv('F14_ENABLED', 'true');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await db.exec('truncate table families, users cascade');
});

interface Household {
  familyId: string;
  stayingUserId: string;
  stayingPhone: string;
  departedUserId: string;
}

async function seedHousehold(options: { timezone?: string } = {}): Promise<Household> {
  households += 1;
  const stayingPhone = `+1416555${7000 + households}`;
  const timezone = options.timezone ?? 'America/Toronto';
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Ana + kids', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;

  const [staying] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:rd-stay-${households}`, name: 'Ana', timezone })
    .returning({ id: schema.users.id });
  const [departed] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:rd-go-${households}`, name: 'Sam', timezone })
    .returning({ id: schema.users.id });
  const stayingUserId = staying?.id as string;
  const departedUserId = departed?.id as string;

  await db.database.insert(schema.familyMembers).values([
    { familyId, userId: stayingUserId, role: 'primary_parent' },
    { familyId, userId: departedUserId, role: 'co_parent' },
  ]);
  await db.database.insert(schema.parentChannels).values({
    userId: stayingUserId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(stayingPhone),
    phoneE164Hash: phoneBlindIndex(stayingPhone),
    verifiedAt: NIGHT,
  });
  await recordWatchConsent(
    db.database,
    {
      familyId,
      userId: stayingUserId,
      granted: true,
      verbatimReply: 'yes',
      interpretation: 'the parent said yes to being watched',
      channelMessageId: null,
    },
    NIGHT,
  );
  return { familyId, stayingUserId, stayingPhone, departedUserId };
}

function ports(transport: FakeTransport): DepartureNoticePorts {
  return {
    ...departureNoticeReaders(db.database),
    transport,
    threadMessage: async () => 'conv-1',
  };
}

/**
 * The departure, on the test's clock rather than the database's.
 *
 * `departCoParent` lets `audit_log.occurred_at` default to `now()`, which in production
 * is the same instant it was handed and under an injected clock is not. The staleness
 * bound reads that column, so a fixture that left it at the wall clock would be testing
 * the machine's date.
 */
async function departAt(household: Household, at: Date) {
  await departCoParent(db.database, {
    familyId: household.familyId,
    actorUserId: household.departedUserId,
    now: at,
  });
  await db.database
    .update(schema.auditLog)
    .set({ occurredAt: at })
    .where(
      and(
        eq(schema.auditLog.familyId, household.familyId),
        eq(schema.auditLog.actionTaken, 'co_parent_departed'),
      ),
    );
}

/** The whole night: the departure, and the notice quiet hours refused. */
async function departAfterDark(household: Household, transport: FakeTransport) {
  await departAt(household, NIGHT);
  const held = await tellStayingParent(
    db.database,
    { familyId: household.familyId, departedUserId: household.departedUserId, now: NIGHT },
    ports(transport),
  );
  expect(held).toBe('gate_refused:quiet_hours');
  expect(transport.sent).toEqual([]);
}

async function noticeRows(familyId: string) {
  return db.database
    .select({
      status: schema.channelMessages.status,
      dedupeKey: schema.channelMessages.dedupeKey,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, familyId),
        eq(schema.channelMessages.templateKey, DEPARTURE_NOTICE_TEMPLATE_KEY),
      ),
    );
}

describe('the morning re-drive of a departure notice quiet hours held', () => {
  it('finishes the 23:00 departure at 08:12, and never sends it twice', async () => {
    const household = await seedHousehold();
    const transport = new FakeTransport();
    await departAfterDark(household, transport);

    const morning = await runDepartureNoticeRedrive(
      db.database,
      { ports: ports(transport) },
      MORNING,
    );

    expect(morning).toMatchObject({ open: 1, due: 1, sent: 1 });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.to).toBe(household.stayingPhone);
    expect(transport.sent[0]?.body).toContain(CO_PARENT_DEPARTED_NOTICE_BY_LANGUAGE.en);
    // The key the night's receipt deliberately did not spend is spent now, once.
    expect(await noticeRows(household.familyId)).toEqual([
      { status: 'suppressed_quiet_hours', dedupeKey: null },
      {
        status: 'queued',
        dedupeKey: departureNoticeDedupeKey(household.familyId, household.departedUserId),
      },
    ]);

    // The same hour, a second tick: the claimed key is what makes this a no-op, and the
    // departure has left the open set entirely.
    const again = await runDepartureNoticeRedrive(
      db.database,
      { ports: ports(transport) },
      new Date(MORNING.getTime() + 40 * 60_000),
    );
    expect(again).toMatchObject({ open: 0, due: 0, sent: 0 });
    expect(transport.sent).toHaveLength(1);
  });

  /**
   * THE NEGATIVE CONTROL'S POSITIVE HALF. A sweep that sends at every hour would pass
   * the test above, so the hour has to be pinned from both sides: nothing at noon, and
   * the same household still owed.
   */
  it('sends nothing outside the re-drive hour, and still owes the notice', async () => {
    const household = await seedHousehold();
    const transport = new FakeTransport();
    await departAfterDark(household, transport);

    const noon = await runDepartureNoticeRedrive(db.database, { ports: ports(transport) }, NOON);

    expect(noon).toMatchObject({ open: 1, due: 0, sent: 0 });
    expect(transport.sent).toEqual([]);
    expect(
      await runDepartureNoticeRedrive(db.database, { ports: ports(transport) }, MORNING),
    ).toMatchObject({ sent: 1 });
  });

  /** The hour is the PARENT's, not the server's — 08:12 Toronto is 05:12 Vancouver. */
  it('reads the re-drive hour on the clock of the parent who stayed', async () => {
    const household = await seedHousehold({ timezone: 'America/Vancouver' });
    const transport = new FakeTransport();
    await departAt(household, NIGHT);

    expect(
      await runDepartureNoticeRedrive(db.database, { ports: ports(transport) }, MORNING),
    ).toMatchObject({ open: 1, due: 0, sent: 0 });
    // Their own 08:12, three hours later.
    expect(
      await runDepartureNoticeRedrive(
        db.database,
        { ports: ports(transport) },
        new Date(MORNING.getTime() + 3 * 3_600_000),
      ),
    ).toMatchObject({ due: 1, sent: 1 });
    expect(REDRIVE_HOUR_LOCAL).toBe(8);
  });

  /**
   * The departure whose notice was never attempted at all — the route commits the
   * transaction and then calls `tellStayingParent`, so a crash between the two leaves a
   * household with a real departure and no receipt of any kind. The sweep reads the
   * DEPARTURE, not the refusal, so this is the same open obligation as a held one.
   */
  it('picks up a departure whose notice never ran', async () => {
    const household = await seedHousehold();
    const transport = new FakeTransport();
    await departAt(household, NIGHT);
    expect(await noticeRows(household.familyId)).toEqual([]);

    const morning = await runDepartureNoticeRedrive(
      db.database,
      { ports: ports(transport) },
      MORNING,
    );

    expect(morning).toMatchObject({ open: 1, due: 1, sent: 1 });
    expect(transport.sent).toHaveLength(1);
  });

  /** A departure older than the staleness bound stops being scanned, and stops being
   * news. Without it every household this sweep can never serve is re-read forever. */
  it('stops re-driving a departure once it is stale', async () => {
    const household = await seedHousehold();
    const transport = new FakeTransport();
    await departAfterDark(household, transport);

    const eightDaysOn = new Date(MORNING.getTime() + 8 * 24 * 3_600_000);
    expect(
      await runDepartureNoticeRedrive(db.database, { ports: ports(transport) }, eightDaysOn),
    ).toMatchObject({ open: 0, sent: 0 });
    expect(transport.sent).toEqual([]);
  });
});
