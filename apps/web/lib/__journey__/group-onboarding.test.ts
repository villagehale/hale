import { createHmac } from 'node:crypto';
import { schema } from '@hale/db';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WATCH_CONSENT_SCOPE } from '~/lib/channel/intake/watch-consent';
import { familyOutboundTarget } from '~/lib/channel/linq/family-outbound';
import { groupAudienceAllows } from '~/lib/channel/linq/group-audience';
import { fakeGroupOnboardingComposer } from '~/lib/channel/linq/group-onboarding-voice-fake';
import { rememberAndNarrateCalendar } from '~/lib/channel/linq/household-calendar';
import { handleLinqInboundRequest } from '~/lib/channel/linq/inbound';
import { POLICY_VERSION } from '~/lib/consent';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import type { CalendarChange } from '~/lib/integrations/calendar-alert';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';

/**
 * GROUP ONBOARDING V2, END TO END — Hale is added to a family's existing group chat.
 *
 * It reads who is there, asks the people it does not know who they are, seats each one
 * only on their own reply, sends the dad his connect links 1:1, keeps every kid line out
 * of the group until everyone has answered, lets in only what the narrowest member may
 * see, goes quiet while someone who is not family stays, and takes back the grandmother's
 * seat when she says STOP in the group.
 *
 * WHAT IS FAKED, and only this: Linq's HTTP API (GET /chats/{id}, POST sends, POST /chats
 * for a 1:1) behind one stubbed `fetch`, and the spoken-line composer (the cached eval
 * proves the words; this proves the plumbing). The webhook door, the roster, the reading,
 * the seat, the consent, the audience gate, the household narration, the STOP and the
 * ledger are production code over real Postgres.
 *
 * SIX MUTATIONS, each run and each red (recorded in the PR):
 *   (a) drop the consent insert in seatConfirmedMember
 *   (b) roster-reading maps "grandma" to parent
 *   (c) familyOutboundTarget ignores the roster
 *   (d) household-calendar skips groupAudienceAllows
 *   (e) the link part goes to the group chat id
 *   (f) connect_link_1to1 drops "STOP" from mustMention
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const SECRET_BYTES = Buffer.alloc(32, 9);
const HALE = '+14165550100';
const PARENT = '+14165550111';
const DAD = '+14165550131';
const GRAN = '+14165550132';
const FRIEND = '+14165550133';
const CHAT = 'chat-family-group';
const NOW = new Date('2026-10-06T18:00:00.000Z');
const NEXT_DAY = new Date('2026-10-07T18:00:00.000Z');
const TS = String(Math.floor(NOW.getTime() / 1000));
const URL_IN_TEXT = /https?:\/\//;

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
  vi.stubEnv('LINQ_FROM_E164', HALE);
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  vi.stubEnv('LINQ_WEBHOOK_SECRET', `whsec_${SECRET_BYTES.toString('base64')}`);
  vi.stubEnv('LINQ_GROUP_COPARENT', 'on');
  vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users cascade');
});

type Sent = { chatId: string; parts: Array<{ type: string; value: string }>; replyTo?: string };

/** Linq, as seen from Hale's side: the members of CHAT, and every bubble Hale posted. */
function linq(members: readonly string[] = [HALE, PARENT, DAD, GRAN, FRIEND]) {
  const group: Sent[] = [];
  const direct: Sent[] = [];
  const opened: Array<{ to: string[]; text: string }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.replace('/api/partner/v3', '');
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (init?.method === 'GET' && path === `/chats/${CHAT}`) {
      return Response.json({
        id: CHAT,
        is_group: true,
        handles: members.map((handle) => ({
          handle,
          is_me: handle === HALE,
        })),
      });
    }
    if (init?.method === 'POST' && path === '/chats') {
      const to = body.to as string[];
      opened.push({ to, text: body.message.parts[0].value });
      return Response.json({
        chat: { id: `direct-${to[0]}`, message: { id: `open-${opened.length}` } },
      });
    }
    const messages = path.match(/^\/chats\/([^/]+)\/messages$/);
    if (init?.method === 'POST' && messages) {
      const chatId = decodeURIComponent(messages[1] as string);
      const sent: Sent = {
        chatId,
        parts: body.message.parts,
        replyTo: body.message.reply_to?.message_id,
      };
      (chatId === CHAT ? group : direct).push(sent);
      return Response.json({ message: { id: `msg-${group.length + direct.length}` } });
    }
    return new Response(JSON.stringify({ error: { code: 404 } }), { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const groupText = () => group.flatMap((sent) => sent.parts.map((part) => part.value));
  const everything = () => JSON.stringify({ group, direct, opened: opened.map((row) => row.text) });
  return { group, direct, opened, groupText, everything };
}

function signed(body: unknown): Request {
  const raw = JSON.stringify(body);
  const mac = createHmac('sha256', SECRET_BYTES)
    .update(`evt_journey.${TS}.${raw}`)
    .digest('base64');
  return new Request('https://app.villagehale.com/api/channels/linq/inbound?version=2026-02-03', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': 'evt_journey',
      'webhook-timestamp': TS,
      'webhook-signature': `v1,${mac}`,
    },
    body: raw,
  });
}

function participant(event: 'participant.added' | 'participant.removed', handle: string) {
  return {
    api_version: 'v3',
    webhook_version: '2026-02-03',
    event_type: event,
    event_id: 'evt_journey',
    created_at: NOW.toISOString(),
    data: {
      chat_id: CHAT,
      handle,
      participant: { handle, is_me: handle === HALE, service: 'iMessage', status: 'active' },
    },
  };
}

function groupMessage(sender: string, text: string, messageId: string) {
  return {
    api_version: 'v3',
    webhook_version: '2026-02-03',
    event_type: 'message.received',
    event_id: 'evt_journey',
    created_at: NOW.toISOString(),
    data: {
      chat: { id: CHAT, is_group: true },
      id: messageId,
      direction: 'inbound',
      sender_handle: { handle: sender, is_me: false },
      parts: [{ type: 'text', value: text }],
      sent_at: NOW.toISOString(),
      service: 'iMessage',
    },
  };
}

function door() {
  const jobs: unknown[] = [];
  const deps = {
    database: db.database,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    countOutcome: async () => {},
    enqueue: async (job: unknown) => {
      jobs.push(job);
    },
    now: () => NOW,
    groupVoice: fakeGroupOnboardingComposer(),
  } as unknown as Parameters<typeof handleLinqInboundRequest>[1];
  const post = async (body: unknown) => {
    const response = await handleLinqInboundRequest(signed(body), deps);
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  };
  return { post, jobs };
}

/** The household as Hale knows it after 1:1 intake: the primary parent, a kid under 13, a calendar. */
async function seedHousehold() {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Riley + kids', provinceOrState: 'ON', postalCode: 'M5V2T6' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const [user] = await db.database
    .insert(schema.users)
    .values({
      externalAuthId: `sms:${phoneBlindIndex(PARENT)}`,
      name: 'Riley',
      timezone: 'America/Toronto',
    })
    .returning({ id: schema.users.id });
  const primaryId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: primaryId, role: 'primary_parent' });
  await db.database.insert(schema.parentChannels).values({
    userId: primaryId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(PARENT),
    phoneE164Hash: phoneBlindIndex(PARENT),
    verifiedAt: NOW,
  });
  await db.database.insert(schema.consentRecords).values({
    userId: primaryId,
    familyId,
    consentType: 'proactive_watch',
    granted: true,
    consentScope: WATCH_CONSENT_SCOPE,
    policyVersion: POLICY_VERSION,
    evidence: { verbatimReply: 'yes please' },
  });
  await db.database
    .insert(schema.children)
    .values({ familyId, name: 'Maya', dateOfBirth: '2021-03-01' });
  const [integration] = await db.database
    .insert(schema.integrations)
    .values({
      familyId,
      userId: primaryId,
      provider: 'gcal',
      status: 'active',
      oauthTokensEncrypted: 'opaque-primary',
    })
    .returning({ id: schema.integrations.id });
  return { familyId, primaryId, integrationId: integration?.id as string };
}

function calendarChange(eventId: string, title: string, start: string): CalendarChange {
  const end = new Date(new Date(start).getTime() + 60 * 60 * 1000).toISOString();
  return {
    eventId,
    title,
    updated: `stamp-${eventId}`,
    status: 'confirmed',
    start: { dateTime: start },
    end: { dateTime: end },
  };
}

async function rosterState() {
  const [roster] = await db.database.select().from(schema.linqGroupRosters);
  const members = await db.database.select().from(schema.linqGroupRosterMembers);
  const statusOf = (phone: string) =>
    members
      .filter((row) => row.phoneE164Hash === phoneBlindIndex(phone))
      .map((row) => row.status)
      .join(',');
  return { roster, statusOf };
}

async function userIdFor(phone: string) {
  const [row] = await db.database
    .select({ userId: schema.parentChannels.userId })
    .from(schema.parentChannels)
    .where(eq(schema.parentChannels.phoneE164Hash, phoneBlindIndex(phone)));
  return row?.userId ?? null;
}

async function groupTemplateKeys() {
  const rows = await db.database
    .select({ templateKey: schema.channelMessages.templateKey })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.providerChatId, CHAT),
        eq(schema.channelMessages.direction, 'out'),
      ),
    )
    .orderBy(asc(schema.channelMessages.createdAt), asc(schema.channelMessages.id));
  return rows.map((row) => row.templateKey);
}

describe('group onboarding v2 — Hale joins a family group', () => {
  it('asks who is who, seats on the reply, keeps the group gated, and honours a STOP in the group', async () => {
    const household = await seedHousehold();
    const wire = linq();
    const { post, jobs } = door();

    // 1-2. Hale is added to a four-person family group it half knows.
    const added = await post(participant('participant.added', HALE));
    expect(added).toMatchObject({ outcome: 'roster_matched', ask: 'roster_asked' });
    let state = await rosterState();
    expect(state.roster?.status).toBe('roles_proposed');
    expect(state.statusOf(PARENT)).toBe('known_parent');
    expect([state.statusOf(DAD), state.statusOf(GRAN), state.statusOf(FRIEND)]).toEqual([
      'asked',
      'asked',
      'asked',
    ]);
    expect(wire.group).toHaveLength(1);
    expect(wire.groupText()[0]).toMatch(/^roster_ask:/);
    expect(wire.groupText()[0]).toContain('Hale');
    expect(wire.groupText()[0]).toContain('Riley');

    // 3. The dad answers for himself.
    const dad = await post(groupMessage(DAD, "I'm his dad", 'in-dad'));
    expect(dad).toMatchObject({ outcome: 'role_confirmed', role: 'co_parent' });
    const dadId = (await userIdFor(DAD)) as string;
    const dadSeat = await db.database
      .select({ role: schema.familyMembers.role })
      .from(schema.familyMembers)
      .where(eq(schema.familyMembers.userId, dadId));
    expect(dadSeat).toEqual([{ role: 'co_parent' }]);
    const [dadGroupSeat] = await db.database
      .select({ role: schema.linqGroupMembers.role })
      .from(schema.linqGroupMembers)
      .where(eq(schema.linqGroupMembers.userId, dadId));
    expect(dadGroupSeat?.role).toBe('co_parent');
    const dadConsent = await db.database
      .select({
        type: schema.consentRecords.consentType,
        scope: schema.consentRecords.consentScope,
        evidence: schema.consentRecords.evidence,
      })
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.userId, dadId));
    expect(dadConsent).toEqual([
      {
        type: 'sms_service_messages',
        scope: 'linq_group_role_reply',
        evidence: expect.objectContaining({ verbatimReply: "I'm his dad" }),
      },
    ]);
    const [dadUser] = await db.database
      .select({ role: schema.users.parentRole, basis: schema.users.parentRoleBasis })
      .from(schema.users)
      .where(eq(schema.users.id, dadId));
    expect(dadUser).toEqual({ role: 'father', basis: 'stated' });
    expect(wire.group).toHaveLength(2);
    expect(wire.groupText()[1]).toMatch(/^role_confirmed:/);
    expect(wire.group[1]?.replyTo).toBe('in-dad');
    expect(wire.opened).toEqual([{ to: [DAD], text: expect.stringContaining('STOP') }]);
    expect(wire.opened[0]?.text).toContain('Hale');
    expect(wire.opened[0]?.text).not.toMatch(URL_IN_TEXT);
    expect(wire.direct.map((sent) => sent.chatId)).toEqual([`direct-${DAD}`, `direct-${DAD}`]);
    for (const sent of wire.direct) {
      expect(sent.parts).toHaveLength(1);
      expect(sent.parts[0]?.type).toBe('link');
      expect(sent.parts[0]?.value).toMatch(/\/connect\?t=/);
    }
    expect(wire.groupText().some((text) => URL_IN_TEXT.test(text))).toBe(false);

    // 4. The grandmother answers for herself. No connect link for a caregiver.
    const gran = await post(groupMessage(GRAN, 'grandma here', 'in-gran'));
    expect(gran).toMatchObject({ outcome: 'role_confirmed', role: 'grandparent' });
    const granId = (await userIdFor(GRAN)) as string;
    const granConsent = await db.database
      .select({
        type: schema.consentRecords.consentType,
        scope: schema.consentRecords.consentScope,
      })
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.userId, granId));
    expect(granConsent).toEqual([
      { type: 'caregiver_scoped_messages', scope: 'caregiver:grandparent' },
    ]);
    expect(wire.opened).toHaveLength(1);
    expect(wire.direct).toHaveLength(2);
    expect(wire.group).toHaveLength(3);
    expect(wire.groupText()[2]).toMatch(/^role_confirmed:/);

    // 5. Someone has not answered yet: a kid event stays out of the group, and the
    // calendar door 1:1 is the one that speaks.
    state = await rosterState();
    expect(state.roster?.status).toBe('partial');
    await rememberAndNarrateCalendar(db.database, {
      integrationId: household.integrationId,
      familyId: household.familyId,
      userId: household.primaryId,
      changes: [calendarChange('swim', 'Maya swim lessons', '2026-10-08T22:00:00.000Z')],
      seeding: false,
      now: NOW,
    });
    expect(wire.group).toHaveLength(3);
    await expect(
      familyOutboundTarget(db.database, household.familyId, { contentClass: 'event_logistics' }),
    ).resolves.toEqual({ channel: 'legacy', reason: 'group_roles_unconfirmed' });
    const held = await db.database
      .select({ actionTaken: schema.auditLog.actionTaken })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'linq_group_sends_held'));
    expect(held).toHaveLength(1);

    // 6. The friend says they are not family: everyone has answered, the group goes
    // quiet, and the primary parent is told 1:1. Removing the friend opens it again.
    const friend = await post(groupMessage(FRIEND, 'not family', 'in-friend'));
    expect(friend).toMatchObject({ outcome: 'role_declined', status: 'not_family' });
    state = await rosterState();
    expect(state.roster?.status).toBe('confirmed');
    expect(await groupAudienceAllows(db.database, CHAT, 'schedule')).toEqual({
      allowed: false,
      reason: 'group_audience_empty',
    });
    expect(wire.opened.map((row) => row.to)).toEqual([[DAD], [PARENT]]);
    expect(wire.opened[1]?.text).toMatch(/^group_quiet_notice:/);
    expect(wire.group).toHaveLength(3);
    const removed = await post(participant('participant.removed', FRIEND));
    expect(removed).toMatchObject({ outcome: 'roster_member_removed' });
    expect(await groupAudienceAllows(db.database, CHAT, 'schedule')).toEqual({
      allowed: true,
      reason: 'in_scope',
    });

    // 7. The kid event reaches the group now; a parent's own appointment does not, and a
    // registration line stays 1:1 while the grandmother reads the group.
    await rememberAndNarrateCalendar(db.database, {
      integrationId: household.integrationId,
      familyId: household.familyId,
      userId: household.primaryId,
      changes: [calendarChange('dentist', 'Dentist', '2026-10-09T15:00:00.000Z')],
      seeding: false,
      now: NOW,
    });
    expect(wire.group).toHaveLength(4);
    const kidLine = wire.groupText()[3] ?? '';
    expect(kidLine).toContain('Maya');
    expect(kidLine).toContain('swim lessons');
    expect(wire.everything()).not.toContain('Dentist');
    await expect(
      familyOutboundTarget(db.database, household.familyId, { contentClass: 'registration' }),
    ).resolves.toEqual({ channel: 'legacy', reason: 'group_audience_refused' });

    // 8. The grandmother says STOP in the group: her seat goes, she is told once, in a
    // thread, and the next kid event is held.
    const stopped = await post(groupMessage(GRAN, 'STOP', 'in-gran-stop'));
    expect(stopped).toMatchObject({ outcome: 'group_stop_unseated' });
    expect((await rosterState()).statusOf(GRAN)).toBe('declined');
    const granRoles = await db.database
      .select({ role: schema.familyMembers.role })
      .from(schema.familyMembers)
      .where(eq(schema.familyMembers.userId, granId));
    expect(granRoles).toEqual([]);
    expect(wire.group).toHaveLength(5);
    expect(wire.group[4]?.replyTo).toBe('in-gran-stop');
    await rememberAndNarrateCalendar(db.database, {
      integrationId: household.integrationId,
      familyId: household.familyId,
      userId: household.primaryId,
      changes: [calendarChange('piano', 'Maya piano', '2026-10-10T19:00:00.000Z')],
      seeding: false,
      now: NEXT_DAY,
    });
    expect(wire.group).toHaveLength(5);

    // Positive control: the exact group ledger, in order, and nothing for the coach.
    expect(await groupTemplateKeys()).toEqual([
      'linq:roster_ask',
      'linq:role_confirmed',
      'linq:role_confirmed',
      'linq:group_kid_event',
      'linq:group_stop_ack',
    ]);
    expect(wire.groupText().some((text) => URL_IN_TEXT.test(text))).toBe(false);
    expect(wire.opened).toHaveLength(2);
    expect(wire.direct).toHaveLength(2);
    expect(jobs).toEqual([]);
  });

  it("never names a teen or their event in the group, while a younger child's event still goes", async () => {
    const household = await seedHousehold();
    await db.database
      .insert(schema.children)
      .values({ familyId: household.familyId, name: 'Kestrel', dateOfBirth: '2012-05-01' });
    const wire = linq([HALE, PARENT, DAD, GRAN]);
    const { post } = door();

    await post(participant('participant.added', HALE));
    await post(groupMessage(DAD, "I'm his dad", 'in-dad'));
    await post(groupMessage(GRAN, 'grandma here', 'in-gran'));
    expect((await rosterState()).roster?.status).toBe('confirmed');
    const before = wire.group.length;

    await rememberAndNarrateCalendar(db.database, {
      integrationId: household.integrationId,
      familyId: household.familyId,
      userId: household.primaryId,
      changes: [
        calendarChange('hockey', 'Kestrel hockey', '2026-10-08T22:00:00.000Z'),
        calendarChange('swim', 'Maya swim lessons', '2026-10-09T22:00:00.000Z'),
      ],
      seeding: false,
      now: NOW,
    });

    // Positive control: the same narration did reach the group, with the younger child's event.
    expect(wire.group).toHaveLength(before + 1);
    const kidLine = wire.groupText().at(-1) ?? '';
    expect(kidLine).toContain('Maya');
    expect(kidLine).toContain('swim lessons');
    expect(wire.groupText().join('\n')).not.toContain('Kestrel');
    expect(wire.groupText().join('\n')).not.toMatch(/hockey/i);
  });
});
