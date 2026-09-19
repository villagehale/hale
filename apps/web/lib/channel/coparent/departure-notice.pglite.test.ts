import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { recordWatchConsent } from '~/lib/channel/intake/watch-consent';
import { OPT_OUT_LINE, OPT_OUT_SHORT } from '~/lib/channel/opt-out';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { CO_PARENT_DEPARTED_NOTICE_BY_LANGUAGE } from './copy';
import { departCoParent } from './depart';
import {
  DEPARTURE_NOTICE_TEMPLATE_KEY,
  type DepartureNoticePorts,
  departureNoticeDedupeKey,
  departureNoticeReaders,
  tellStayingParent,
} from './departure-notice';

/**
 * VIL-355 follow-up · item 2 — the parent who stayed is told.
 *
 * Against the real DDL AND through the real gate: every hold this thing can take is a
 * read of live channel state, the consent ledger and a wall clock, and an injected
 * verdict would only ever test the reaction to a stipulated answer. The transport is the
 * one fake — it is the only thing here that leaves the building.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
/** 10:12 in America/Toronto (EDT, UTC-4) — inside the sendable window. */
const MORNING = new Date('2026-09-16T14:12:00.000Z');
/** 23:12 local, the same evening. */
const NIGHT = new Date('2026-09-17T03:12:00.000Z');

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
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.exec('truncate table families, users cascade');
});

interface Household {
  familyId: string;
  stayingUserId: string;
  stayingPhone: string;
  departedUserId: string;
  departedPhone: string;
}

async function seedHousehold(options: { locale?: string; watchConsent?: boolean } = {}) {
  households += 1;
  const stayingPhone = `+1416555${4000 + households}`;
  const departedPhone = `+1647555${5000 + households}`;
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Ana + kids', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;

  const [staying] = await db.database
    .insert(schema.users)
    .values({
      externalAuthId: `sms:stay-${households}`,
      name: 'Ana',
      timezone: 'America/Toronto',
      ...(options.locale ? { locale: options.locale } : {}),
    })
    .returning({ id: schema.users.id });
  const [departed] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:go-${households}`, name: 'Sam', timezone: 'America/Toronto' })
    .returning({ id: schema.users.id });
  const stayingUserId = staying?.id as string;
  const departedUserId = departed?.id as string;

  await db.database.insert(schema.familyMembers).values([
    { familyId, userId: stayingUserId, role: 'primary_parent' },
    { familyId, userId: departedUserId, role: 'co_parent' },
  ]);
  await db.database.insert(schema.parentChannels).values([
    {
      userId: stayingUserId,
      familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(stayingPhone),
      phoneE164Hash: phoneBlindIndex(stayingPhone),
      verifiedAt: MORNING,
    },
    {
      userId: departedUserId,
      familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(departedPhone),
      phoneE164Hash: phoneBlindIndex(departedPhone),
      verifiedAt: MORNING,
    },
  ]);
  if (options.watchConsent !== false) {
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
      MORNING,
    );
  }
  return { familyId, stayingUserId, stayingPhone, departedUserId, departedPhone } as Household;
}

function ports(transport: FakeTransport): {
  ports: DepartureNoticePorts;
  threaded: Array<{ familyId: string; parentUserId: string; body: string }>;
} {
  const threaded: Array<{ familyId: string; parentUserId: string; body: string }> = [];
  return {
    threaded,
    ports: {
      ...departureNoticeReaders(db.database),
      transport,
      threadMessage: async (_db, input) => {
        threaded.push(input);
        return 'conv-1';
      },
    },
  };
}

async function noticeRows(familyId: string) {
  return db.database
    .select({
      status: schema.channelMessages.status,
      dedupeKey: schema.channelMessages.dedupeKey,
      category: schema.channelMessages.category,
      body: schema.channelMessages.body,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, familyId),
        eq(schema.channelMessages.templateKey, DEPARTURE_NOTICE_TEMPLATE_KEY),
      ),
    );
}

describe('telling the parent who stayed', () => {
  it('sends ONE text to the parent who stayed, never to the one who left', async () => {
    const household = await seedHousehold();
    const departure = await departCoParent(db.database, {
      familyId: household.familyId,
      actorUserId: household.departedUserId,
      now: MORNING,
    });
    expect(departure.outcome).toBe('departed');
    const transport = new FakeTransport();
    const { ports: sendPorts, threaded } = ports(transport);

    const outcome = await tellStayingParent(
      db.database,
      { familyId: household.familyId, departedUserId: household.departedUserId, now: MORNING },
      sendPorts,
    );

    expect(outcome).toBe('sent');
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.to).toBe(household.stayingPhone);
    expect(transport.sent[0]?.to).not.toBe(household.departedPhone);
    // The sentence, plus the CASL line the gate decided — never instead of it.
    expect(transport.sent[0]?.body).toContain(CO_PARENT_DEPARTED_NOTICE_BY_LANGUAGE.en);
    expect(
      transport.sent[0]?.body.includes(OPT_OUT_LINE) ||
        transport.sent[0]?.body.includes(OPT_OUT_SHORT),
    ).toBe(true);
    // Nobody is named — not the parent who left, not a child.
    expect(transport.sent[0]?.body).not.toContain('Sam');

    expect(await noticeRows(household.familyId)).toEqual([
      {
        status: 'queued',
        dedupeKey: departureNoticeDedupeKey(household.familyId, household.departedUserId),
        category: 'co_parent_departed',
        body: null,
      },
    ]);
    expect(threaded).toEqual([
      {
        familyId: household.familyId,
        parentUserId: household.stayingUserId,
        body: CO_PARENT_DEPARTED_NOTICE_BY_LANGUAGE.en,
      },
    ]);
    const verbs = await db.database
      .select({ actionTaken: schema.auditLog.actionTaken })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, household.familyId));
    expect(verbs.map((v) => v.actionTaken)).toContain('co_parent_departure_notice_sent');
  });

  it('says it once per departure — a retry reaches no provider', async () => {
    const household = await seedHousehold();
    await departCoParent(db.database, {
      familyId: household.familyId,
      actorUserId: household.departedUserId,
      now: MORNING,
    });
    const transport = new FakeTransport();
    const { ports: sendPorts } = ports(transport);
    const args = {
      familyId: household.familyId,
      departedUserId: household.departedUserId,
      now: MORNING,
    };

    expect(await tellStayingParent(db.database, args, sendPorts)).toBe('sent');
    expect(await tellStayingParent(db.database, args, sendPorts)).toBe('already_sent');

    expect(transport.sent).toHaveLength(1);
    expect(await noticeRows(household.familyId)).toHaveLength(1);
  });

  it('holds the 23:12 notice on a receipt with NO key, so the morning can still send it', async () => {
    const household = await seedHousehold();
    await departCoParent(db.database, {
      familyId: household.familyId,
      actorUserId: household.departedUserId,
      now: NIGHT,
    });
    const transport = new FakeTransport();
    const { ports: sendPorts } = ports(transport);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const held = await tellStayingParent(
      db.database,
      { familyId: household.familyId, departedUserId: household.departedUserId, now: NIGHT },
      sendPorts,
    );

    expect(held).toBe('gate_refused:quiet_hours');
    expect(transport.sent).toEqual([]);
    expect(await noticeRows(household.familyId)).toEqual([
      expect.objectContaining({ status: 'suppressed_quiet_hours', dedupeKey: null }),
    ]);

    // THE POSITIVE CONTROL for the hold: the key was never spent, so the same departure
    // still sends when the window opens.
    const later = await tellStayingParent(
      db.database,
      {
        familyId: household.familyId,
        departedUserId: household.departedUserId,
        now: new Date(NIGHT.getTime() + 11 * 3_600_000),
      },
      sendPorts,
    );
    expect(later).toBe('sent');
    expect(transport.sent).toHaveLength(1);
  });

  it('holds the notice for a parent who never said yes to being watched', async () => {
    const household = await seedHousehold({ watchConsent: false });
    await departCoParent(db.database, {
      familyId: household.familyId,
      actorUserId: household.departedUserId,
      now: MORNING,
    });
    const transport = new FakeTransport();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const outcome = await tellStayingParent(
      db.database,
      { familyId: household.familyId, departedUserId: household.departedUserId, now: MORNING },
      ports(transport).ports,
    );

    expect(outcome).toBe('gate_refused:no_watch_consent');
    expect(transport.sent).toEqual([]);
    expect(await noticeRows(household.familyId)).toEqual([
      expect.objectContaining({ status: 'suppressed_consent', dedupeKey: null }),
    ]);
  });

  it('writes the French sentence to a parent whose account is in French', async () => {
    const household = await seedHousehold({ locale: 'fr-CA' });
    await departCoParent(db.database, {
      familyId: household.familyId,
      actorUserId: household.departedUserId,
      now: MORNING,
    });
    const transport = new FakeTransport();

    await tellStayingParent(
      db.database,
      { familyId: household.familyId, departedUserId: household.departedUserId, now: MORNING },
      ports(transport).ports,
    );

    expect(transport.sent[0]?.body).toContain(CO_PARENT_DEPARTED_NOTICE_BY_LANGUAGE.fr);
  });

  it('names a household with nobody left to tell instead of sending into the void', async () => {
    const household = await seedHousehold();
    await departCoParent(db.database, {
      familyId: household.familyId,
      actorUserId: household.departedUserId,
      now: MORNING,
    });
    await db.database
      .delete(schema.familyMembers)
      .where(eq(schema.familyMembers.familyId, household.familyId));
    const transport = new FakeTransport();

    const outcome = await tellStayingParent(
      db.database,
      { familyId: household.familyId, departedUserId: household.departedUserId, now: MORNING },
      ports(transport).ports,
    );

    expect(outcome).toBe('no_staying_parent');
    expect(transport.sent).toEqual([]);
    expect(await noticeRows(household.familyId)).toEqual([]);
  });
});
