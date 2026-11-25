import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deliverDutyGroupLine } from '~/lib/channel/coparent/duty/asks';
import { loadFamilyTextRecipients } from '~/lib/channel/family-recipients';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { WATCH_CONSENT_SCOPE } from '~/lib/channel/intake/watch-consent';
import { familyOutboundTarget } from '~/lib/channel/linq/family-outbound';
import { narrateHouseholdCalendar } from '~/lib/channel/linq/household-calendar';
import { defaultRecheckOpenAsk } from '~/lib/channel/next-day-checkback/recheck';
import { buildOutboundGatePorts } from '~/lib/channel/outbound-gate';
import type { ContentClass } from '~/lib/channel/role-scope';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { fulfillCommitment } from '~/lib/commitments/ledger';
import { POLICY_VERSION } from '~/lib/consent';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb, migrationFiles, seedFamily } from '~/lib/testing/pglite';
import { QUEUED_LINE_CONTENT_CLASS_ENV } from './flag';
import { handOffProactive } from './queue';
import { type ProactiveReviewDeps, readLineHold, runProactiveReview } from './review';

/**
 * Under live cadence a household line waits in the proactive queue, and the hourly review
 * sends it. The line's content class travels with it, so the review asks the group-audience
 * rule about that class, as the line's own sweep did, and a claimed group that may hear it
 * gets one bubble instead of a 1:1 copy to each parent. Real Postgres, the real reviewer,
 * the real target lookup and audience rule; only the Linq wire and the two model readers
 * (decider and writer) are scripted.
 */

const KEY = Buffer.alloc(32, 5).toString('base64');
const CHAT = 'chat-household-queued';
const HALE = '+15555550100';
const PRIMARY_PHONE = '+15555550131';
const COPARENT_PHONE = '+15555550132';
const FRIEND_PHONE = '+15555550133';
/** 14:00 America/Toronto. */
const DAY = new Date('2026-09-25T18:00:00.000Z');
const WRITTEN = 'FAKE household line';
/** What a sweep queued. Its kinds are sent as queued, so this is the text that goes. */
const QUEUED = 'FAKE queued notice';

let db: TestDb;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  vi.stubEnv('LINQ_FROM_E164', HALE);
  vi.stubEnv('LINQ_GROUP_COPARENT', 'on');
  vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
  vi.stubEnv('PROACTIVE_CADENCE', 'live');
  vi.stubEnv('PROACTIVE_SENDS_PAUSED', 'false');
  vi.stubEnv('PROACTIVE_REVIEW_GUARDS_ENABLED', 'false');
  vi.stubEnv('CROSS_PARENT_CLASH_ENABLED', 'false');
  vi.stubEnv('LINQ_GROUP_CONFLICT_ALERTS_ENABLED', 'false');
  vi.stubEnv('LINQ_POLLS', 'off');
  vi.stubEnv(QUEUED_LINE_CONTENT_CLASS_ENV, 'true');
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users, linq_group_rosters cascade');
});

interface Wire {
  fetch: typeof fetch;
  /** Texts posted into the household chat. */
  groupTexts: string[];
}

/** Linq: the chat's participant read and its message posts. Anything else is a test bug. */
function householdWire(present: readonly string[]): Wire {
  const groupTexts: string[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (!target.includes(`/chats/${CHAT}`)) throw new Error(`unexpected wire call: ${target}`);
    if (init?.method === 'GET') {
      return Response.json({
        chat: {
          id: CHAT,
          is_group: true,
          handles: [
            { handle: HALE, status: 'active', is_me: true },
            ...present.map((handle) => ({ handle, status: 'active', is_me: false })),
          ],
        },
      });
    }
    const body = JSON.parse(String(init?.body)) as { message?: { parts?: { value?: string }[] } };
    groupTexts.push(body.message?.parts?.map((part) => part.value ?? '').join('') ?? '');
    return Response.json({ message: { id: `m-${groupTexts.length}` } });
  });
  vi.stubGlobal('fetch', fetchImpl);
  return { fetch: fetchImpl as unknown as typeof fetch, groupTexts };
}

interface Household {
  familyId: string;
  primaryUserId: string;
  coparentUserId: string;
  rosterId: string;
  primaryIntegrationId: string;
}

async function seedHousehold(): Promise<Household> {
  const [family] = await db.database
    .insert(schema.families)
    .values({
      displayName: 'Test household',
      provinceOrState: 'ON',
      postalCode: 'M5V2T6',
      linqGroupChatId: CHAT,
    })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const users = await db.database
    .insert(schema.users)
    .values([
      { externalAuthId: `sms:primary-${familyId}`, name: 'Riley', timezone: 'America/Toronto' },
      { externalAuthId: `sms:coparent-${familyId}`, name: 'Sam', timezone: 'America/Toronto' },
    ])
    .returning({ id: schema.users.id });
  const primaryUserId = users[0]?.id as string;
  const coparentUserId = users[1]?.id as string;
  await db.database.insert(schema.familyMembers).values([
    { familyId, userId: primaryUserId, role: 'primary_parent' },
    { familyId, userId: coparentUserId, role: 'co_parent' },
  ]);
  await db.database.insert(schema.parentChannels).values(
    [
      { userId: primaryUserId, phone: PRIMARY_PHONE },
      { userId: coparentUserId, phone: COPARENT_PHONE },
    ].map(({ userId, phone }) => ({
      userId,
      familyId,
      kind: 'sms' as const,
      phoneE164Encrypted: encryptString(phone),
      phoneE164Hash: phoneBlindIndex(phone),
      verifiedAt: DAY,
    })),
  );
  await db.database.insert(schema.consentRecords).values(
    [primaryUserId, coparentUserId].map((userId) => ({
      userId,
      familyId,
      consentType: 'proactive_watch' as const,
      granted: true,
      consentScope: WATCH_CONSENT_SCOPE,
      policyVersion: POLICY_VERSION,
      evidence: { verbatimReply: 'yes please' },
    })),
  );
  await db.database
    .insert(schema.children)
    .values([{ familyId, name: 'Maya', dateOfBirth: '2022-04-01' }]);
  const [roster] = await db.database
    .insert(schema.linqGroupRosters)
    .values({ chatId: CHAT, familyId, source: 'added_to_existing', status: 'confirmed' })
    .returning({ id: schema.linqGroupRosters.id });
  const rosterId = roster?.id as string;
  await db.database.insert(schema.linqGroupRosterMembers).values([
    {
      rosterId,
      chatId: CHAT,
      phoneE164Hash: phoneBlindIndex(PRIMARY_PHONE),
      knownUserId: primaryUserId,
      status: 'known_parent',
    },
    {
      rosterId,
      chatId: CHAT,
      phoneE164Hash: phoneBlindIndex(COPARENT_PHONE),
      userId: coparentUserId,
      status: 'confirmed',
      confirmedRole: 'co_parent',
    },
  ]);
  const [calendar] = await db.database
    .insert(schema.integrations)
    .values({
      familyId,
      userId: primaryUserId,
      provider: 'gcal',
      status: 'active',
      oauthTokensEncrypted: `opaque-${primaryUserId}`,
    })
    .returning({ id: schema.integrations.id });
  return {
    familyId,
    primaryUserId,
    coparentUserId,
    rosterId,
    primaryIntegrationId: calendar?.id as string,
  };
}

/** A kid event on the primary parent's calendar, which the household notice announces. */
async function kidEvent(household: Household): Promise<void> {
  await db.database.insert(schema.parentCalendarBlocks).values({
    integrationId: household.primaryIntegrationId,
    userId: household.primaryUserId,
    familyId: household.familyId,
    eventId: 'evt-1',
    startAt: new Date('2026-09-26T19:00:00.000Z'),
    endAt: new Date('2026-09-26T20:00:00.000Z'),
    kidRelated: true,
    title: 'Maya gymnastics',
    calendarStanding: 'organizer',
    status: 'confirmed',
    updatedStamp: 'stamp-evt-1',
  });
}

/** A line queued with the class its sweep would carry, for the parent who owns it. */
async function queueLine(
  household: Household,
  input: { parentUserId: string; dedupeKey: string; contentClass: ContentClass | null },
): Promise<void> {
  await handOffProactive(
    db.database,
    [
      {
        familyId: household.familyId,
        parentUserId: input.parentUserId,
        kind: 'calendar_alert',
        category: 'calendar_alert',
        templateKey: 'linq:group_kid_event',
        what: QUEUED,
        why: 'calendar_alert',
        sourceUrl: null,
        worthlessAfter: null,
        parentRequested: false,
        dedupeKey: input.dedupeKey,
        payload: { auditVerb: 'calendar_alert_sent' },
        contentClass: input.contentClass,
      },
    ],
    'candidate',
  );
}

/** The real reviewer ports, with the decider and the writer scripted and Linq on `wire`. */
function reviewDeps(wire: Wire): { deps: ProactiveReviewDeps; transport: FakeTransport } {
  const transport = new FakeTransport();
  const deps: ProactiveReviewDeps = {
    client: null,
    transport,
    decide: async ({ snapshot }) => ({
      decision: {
        reason: 'it fits this afternoon',
        action: 'send_now',
        itemIds: snapshot.candidates.map((candidate) => candidate.id),
        holdUntil: null,
        frequencyPreference: null,
      },
      skipped: null,
    }),
    compose: async () => ({ message: WRITTEN }),
    buildGate: buildOutboundGatePorts,
    resolveSendablePhone,
    lineHold: readLineHold,
    loadRecipients: loadFamilyTextRecipients,
    outboundTarget: familyOutboundTarget,
    threadMessage: threadProactiveMessage,
    fulfillCommitment,
    recheckOpenAsk: defaultRecheckOpenAsk(),
    page: async () => 'paged',
    fetch: wire.fetch,
  };
  return { deps, transport };
}

async function candidates(familyId: string) {
  const rows = await db.database
    .select({
      dedupeKey: schema.proactiveCandidates.dedupeKey,
      status: schema.proactiveCandidates.status,
      contentClass: schema.proactiveCandidates.contentClass,
      what: schema.proactiveCandidates.what,
    })
    .from(schema.proactiveCandidates)
    .where(eq(schema.proactiveCandidates.familyId, familyId));
  return rows.sort((x, y) => x.dedupeKey.localeCompare(y.dedupeKey));
}

const oneToOne = (transport: FakeTransport) => transport.sent.map((sent) => sent.to).sort();

describe('a household line queued under live cadence', () => {
  it('carries its sweep’s class, and a group that may hear it gets one bubble and no 1:1 copies', async () => {
    const household = await seedHousehold();
    await kidEvent(household);
    const wire = householdWire([PRIMARY_PHONE, COPARENT_PHONE]);

    await narrateHouseholdCalendar(db.database, {
      familyId: household.familyId,
      now: DAY,
      fetch: wire.fetch,
    });
    const duty = await deliverDutyGroupLine(db.database, {
      familyId: household.familyId,
      parentUserId: household.coparentUserId,
      text: 'FAKE duty ask',
      now: DAY,
      dedupeKey: 'duty:test:1',
      templateKey: 'duty:ask',
      sendsActive: true,
      composed: true,
      fetch: wire.fetch,
    });
    expect(duty).toEqual({ status: 'queued' });
    expect(wire.groupTexts).toEqual([]);
    const queued = await candidates(household.familyId);
    expect(queued.map((row) => row.contentClass).sort()).toEqual([
      'event_logistics',
      'pickup_duty',
    ]);
    const lines = queued.map((row) => row.what);

    const { deps, transport } = reviewDeps(wire);
    const summary = await runProactiveReview(db.database, deps, DAY);

    expect(summary).toMatchObject({ sent: 1, held: 0, failed: 0 });
    expect(wire.groupTexts).toHaveLength(1);
    for (const line of lines) expect(wire.groupTexts[0]).toContain(line);
    expect(transport.sent).toEqual([]);
    expect((await candidates(household.familyId)).map((row) => row.status)).toEqual([
      'sent',
      'sent',
    ]);
  });

  it('stays 1:1 when someone in the chat may not hear its class', async () => {
    const household = await seedHousehold();
    await db.database.insert(schema.linqGroupRosterMembers).values({
      rosterId: household.rosterId,
      chatId: CHAT,
      phoneE164Hash: phoneBlindIndex(FRIEND_PHONE),
      status: 'not_family',
    });
    const wire = householdWire([PRIMARY_PHONE, COPARENT_PHONE, FRIEND_PHONE]);
    await queueLine(household, {
      parentUserId: household.primaryUserId,
      dedupeKey: 'notice:a',
      contentClass: 'event_logistics',
    });
    await queueLine(household, {
      parentUserId: household.coparentUserId,
      dedupeKey: 'notice:b',
      contentClass: 'event_logistics',
    });

    const { deps, transport } = reviewDeps(wire);
    const summary = await runProactiveReview(db.database, deps, DAY);

    expect(summary).toMatchObject({ sent: 2, failed: 0 });
    expect(wire.groupTexts).toEqual([]);
    expect(oneToOne(transport)).toEqual([COPARENT_PHONE, PRIMARY_PHONE].sort());
  });

  it.each<ContentClass>(['teen_content', 'health', 'registration', 'family_settings'])(
    'never takes a %s line into the group, even a group of the two parents',
    async (contentClass) => {
      const household = await seedHousehold();
      const wire = householdWire([PRIMARY_PHONE, COPARENT_PHONE]);
      await queueLine(household, {
        parentUserId: household.primaryUserId,
        dedupeKey: 'notice:a',
        contentClass,
      });

      const { deps, transport } = reviewDeps(wire);
      const summary = await runProactiveReview(db.database, deps, DAY);

      expect(summary).toMatchObject({ sent: 1, failed: 0 });
      expect(wire.groupTexts).toEqual([]);
      expect(oneToOne(transport)).toEqual([PRIMARY_PHONE]);
    },
  );

  it('sends only the line the group may hear to the group when a batch mixes it with one it may not', async () => {
    const household = await seedHousehold();
    const wire = householdWire([PRIMARY_PHONE, COPARENT_PHONE]);
    await queueLine(household, {
      parentUserId: household.primaryUserId,
      dedupeKey: 'notice:a',
      contentClass: 'event_logistics',
    });
    await queueLine(household, {
      parentUserId: household.coparentUserId,
      dedupeKey: 'notice:b',
      contentClass: 'teen_content',
    });

    const { deps, transport } = reviewDeps(wire);
    const summary = await runProactiveReview(db.database, deps, DAY);

    expect(summary).toMatchObject({ sent: 2, failed: 0 });
    expect(wire.groupTexts).toEqual([QUEUED]);
    expect(oneToOne(transport)).toEqual([COPARENT_PHONE]);
  });

  it('keeps an old row with no class 1:1, and the same line with its class goes to the group', async () => {
    const household = await seedHousehold();
    const wire = householdWire([PRIMARY_PHONE, COPARENT_PHONE]);
    await db.database.insert(schema.proactiveCandidates).values({
      familyId: household.familyId,
      parentUserId: household.primaryUserId,
      kind: 'calendar_alert',
      category: 'calendar_alert',
      templateKey: 'linq:group_kid_event',
      what: QUEUED,
      why: 'calendar_alert',
      dedupeKey: 'notice:old',
    });

    const { deps, transport } = reviewDeps(wire);
    await runProactiveReview(db.database, deps, DAY);

    expect(wire.groupTexts).toEqual([]);
    expect(oneToOne(transport)).toEqual([PRIMARY_PHONE]);

    // Positive control: the same line, classed, in the same household goes to the group.
    await queueLine(household, {
      parentUserId: household.primaryUserId,
      dedupeKey: 'notice:new',
      contentClass: 'event_logistics',
    });
    await runProactiveReview(db.database, deps, new Date(DAY.getTime() + 3_600_000));
    expect(wire.groupTexts).toEqual([QUEUED]);
    expect(transport.sent).toHaveLength(1);
  });

  it('with the flag off, a classed line goes 1:1 to its own parent, exactly as before', async () => {
    vi.stubEnv(QUEUED_LINE_CONTENT_CLASS_ENV, 'false');
    const household = await seedHousehold();
    const wire = householdWire([PRIMARY_PHONE, COPARENT_PHONE]);
    await queueLine(household, {
      parentUserId: household.primaryUserId,
      dedupeKey: 'notice:a',
      contentClass: 'event_logistics',
    });
    await queueLine(household, {
      parentUserId: household.coparentUserId,
      dedupeKey: 'notice:b',
      contentClass: 'pickup_duty',
    });

    const { deps, transport } = reviewDeps(wire);
    const summary = await runProactiveReview(db.database, deps, DAY);

    expect(summary).toMatchObject({ sent: 2, failed: 0 });
    expect(wire.groupTexts).toEqual([]);
    expect(oneToOne(transport)).toEqual([COPARENT_PHONE, PRIMARY_PHONE].sort());
  });
});

describe('0267 proactive_candidates content_class', () => {
  const MIGRATION = '0267_proactive_candidates_content_class.sql';

  it('is in the chain, applies twice, and leaves an old row with no class', async () => {
    expect(migrationFiles()).toContain(MIGRATION);
    const before = await createTestDb('0266_linq_group_loop_guards.sql');
    try {
      const household = await seedFamily(before.database);
      await before.exec(
        `insert into proactive_candidates (family_id, parent_user_id, kind, category, template_key, what, why, dedupe_key)
         values ('${household.familyId}', '${household.parentUserId}', 'calendar_alert', 'calendar_alert', 'linq:group_kid_event', 'FAKE old line', 'calendar_alert', 'old-row')`,
      );
      await before.applyMigration(MIGRATION);
      await before.applyMigration(MIGRATION);
      const [row] = await before.database
        .select({ contentClass: schema.proactiveCandidates.contentClass })
        .from(schema.proactiveCandidates)
        .where(eq(schema.proactiveCandidates.dedupeKey, 'old-row'));
      expect(row).toEqual({ contentClass: null });
    } finally {
      await before.close();
    }
  });
});
