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
/** The 13+ child whose name a parent-facing text may not carry by default (rule #1). */
const TEEN_NAME = 'Noor';
/** Their younger sibling — under the teen gate, and still nobody this message names. */
const SIBLING_NAME = 'Wren';
/** The parent who left. Their name is not the staying parent's to be handed either. */
const DEPARTED_NAME = 'Sam';
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
  // ARMED, because this is a proactive class and F14 gates every one of them (D21).
  // Every send below is a send a household is armed for; the dark case is its own test.
  vi.stubEnv('F14_ENABLED', 'true');
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
    .values({
      externalAuthId: `sms:go-${households}`,
      name: DEPARTED_NAME,
      timezone: 'America/Toronto',
    })
    .returning({ id: schema.users.id });
  const stayingUserId = staying?.id as string;
  const departedUserId = departed?.id as string;

  await db.database.insert(schema.familyMembers).values([
    { familyId, userId: stayingUserId, role: 'primary_parent' },
    { familyId, userId: departedUserId, role: 'co_parent' },
  ]);
  // A 13+ child and a younger sibling, in EVERY departure fixture. Nothing in this lane
  // reads them, and that is exactly the claim rule #1 needs a witness for: a household
  // with no children in it cannot fail a test about a child's name reaching a parent.
  await db.database.insert(schema.children).values([
    { familyId, name: TEEN_NAME, dateOfBirth: '2012-03-04', dobPrecision: 'exact' },
    { familyId, name: SIBLING_NAME, dateOfBirth: '2022-06-01', dobPrecision: 'exact' },
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
    // Nobody is named — see the dedicated wire test below for the whole household.
    expect(transport.sent[0]?.body).not.toContain(DEPARTED_NAME);

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

  /**
   * HARD RULE #1, ON THE WIRE — the only place the claim can be checked.
   *
   * The copy constants name nobody and a regex over them says so, but a regex over a
   * constant cannot see a runtime concatenation at the CALL SITE, which is where a name
   * would actually get added: the message is composed here and handed straight to
   * `transport.send`. So the assertion is on the bytes the provider was given, for a
   * household that really holds a 13+ child (whose content is redacted from parents by
   * default) and a younger sibling — and in BOTH languages, because the two bodies are
   * built by the same lookup and a leak would ride whichever one was rendered.
   */
  it('puts no child name and no parent name on the wire, in either language', async () => {
    const english = await seedHousehold();
    const french = await seedHousehold({ locale: 'fr-CA' });
    const transport = new FakeTransport();
    for (const household of [english, french]) {
      await departCoParent(db.database, {
        familyId: household.familyId,
        actorUserId: household.departedUserId,
        now: MORNING,
      });
      expect(
        await tellStayingParent(
          db.database,
          { familyId: household.familyId, departedUserId: household.departedUserId, now: MORNING },
          ports(transport).ports,
        ),
      ).toBe('sent');
    }

    expect(transport.sent).toHaveLength(2);
    // THE POSITIVE CONTROL: the names really are in this household, so an assertion that
    // passes below is passing on the message rather than on an empty fixture.
    const seeded = await db.database
      .select({ name: schema.children.name })
      .from(schema.children)
      .where(eq(schema.children.familyId, english.familyId));
    expect(seeded.map((c) => c.name).sort()).toEqual([TEEN_NAME, SIBLING_NAME].sort());

    for (const sent of transport.sent) {
      for (const name of [TEEN_NAME, SIBLING_NAME, DEPARTED_NAME]) {
        expect(sent.body).not.toContain(name);
      }
    }
    // Both languages really were rendered — otherwise the loop above proves one body.
    expect(transport.sent.map((s) => s.body).join('\n')).toContain(
      CO_PARENT_DEPARTED_NOTICE_BY_LANGUAGE.fr,
    );
    expect(transport.sent.map((s) => s.body).join('\n')).toContain(
      CO_PARENT_DEPARTED_NOTICE_BY_LANGUAGE.en,
    );
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
    // The audit row records the language that was CHOSEN. It used to be re-derived by
    // comparing the rendered body against the EN constant, so any change to how the
    // message is built relabelled every row — including the English ones.
    const [audit] = await db.database
      .select({ after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'co_parent_departure_notice_sent'));
    expect(audit?.after).toEqual({ language: 'fr' });
  });

  /**
   * D21 · the dark-launch gate every other proactive surface reads. Without it the
   * notice's arming predicate is implicit — "whoever happens to hold watch consent" —
   * and the day a non-SMS path grants that consent this message starts going out to
   * households F14 was never flipped on for.
   */
  it('sends nothing while the household is dark, and sends once it is armed', async () => {
    vi.stubEnv('F14_ENABLED', 'false');
    const household = await seedHousehold();
    await departCoParent(db.database, {
      familyId: household.familyId,
      actorUserId: household.departedUserId,
      now: MORNING,
    });
    const transport = new FakeTransport();
    const args = {
      familyId: household.familyId,
      departedUserId: household.departedUserId,
      now: MORNING,
    };

    expect(await tellStayingParent(db.database, args, ports(transport).ports)).toBe('dark');
    expect(transport.sent).toEqual([]);
    // Nothing claimed and nothing suppressed: a household Hale is not live for has no
    // message to have a receipt about.
    expect(await noticeRows(household.familyId)).toEqual([]);

    // THE POSITIVE CONTROL: armed for this one household, the same departure sends.
    vi.stubEnv('F14_FAMILY_ALLOWLIST', household.familyId);
    expect(await tellStayingParent(db.database, args, ports(transport).ports)).toBe('sent');
    expect(transport.sent).toHaveLength(1);
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
