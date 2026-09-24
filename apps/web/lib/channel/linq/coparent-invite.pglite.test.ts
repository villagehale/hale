import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CO_PARENT_REDIRECT } from '~/lib/channel/caregiver/copy';
import { coParentInviteBody, coParentInviteSentAck } from '~/lib/channel/coparent/copy';
import { CO_PARENT_ASK, INTAKE_COPARENT_ASK_TEMPLATE_KEY } from '~/lib/channel/intake/copy';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  LINQ_COPARENT_INVITE_TEMPLATE_KEY,
  LINQ_COPARENT_INVITE_TEXT,
  SMS_COPARENT_INVITE_TEMPLATE_KEY,
  deliverCoParentNumberInvite,
  linqCoParentInviteText,
  parseCoParentNumberReply,
} from './coparent-invite';
import { LINQ_GROUP_UNREACHABLE_TEXT } from './group';

/**
 * The 2026-09-24 Linq sandbox turn: a parent texted 9059629821 after the
 * co-parent ask, and the free agent said an invite was on its way. Nothing
 * was. These prove the deterministic sender, on both doors.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const PARENT_PHONE = '+14165550111';
const COPARENT_PHONE = '+19059629821';
const FROM = '+15555550100';
const NOW = new Date('2026-09-24T03:55:00.000Z');
const CHAT = 'chat-parent-1';

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
  vi.stubEnv('F14_ENABLED', 'true');
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  vi.stubEnv('LINQ_FROM_E164', FROM);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users cascade');
});

async function seedHousehold(name = 'Jimmy'): Promise<{ familyId: string; parentUserId: string }> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Jimmy + kids', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `imessage:${name}-${family?.id}`, name })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const parentUserId = user?.id as string;
  await db.database.insert(schema.familyMembers).values({
    familyId,
    userId: parentUserId,
    role: 'primary_parent',
  });
  await db.database.insert(schema.parentChannels).values({
    userId: parentUserId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(PARENT_PHONE),
    phoneE164Hash: phoneBlindIndex(PARENT_PHONE),
    verifiedAt: NOW,
  });
  return { familyId, parentUserId };
}

async function seedAsk(
  seeded: { familyId: string; parentUserId: string },
  channel: 'imessage' | 'sms',
): Promise<string> {
  const [inbound] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      channel,
      direction: 'in',
      category: 'reply',
      providerMessageId: `in-${channel}-${seeded.parentUserId}`,
      providerChatId: channel === 'imessage' ? CHAT : null,
      status: 'delivered',
      body: '9059629821',
      sentAt: NOW,
    })
    .returning({ id: schema.channelMessages.id });
  await db.database.insert(schema.channelMessages).values({
    familyId: seeded.familyId,
    parentUserId: seeded.parentUserId,
    channel,
    direction: 'out',
    category: 'reply',
    templateKey: INTAKE_COPARENT_ASK_TEMPLATE_KEY,
    providerMessageId: `ask-${channel}-${seeded.parentUserId}`,
    providerChatId: channel === 'imessage' ? CHAT : null,
    status: 'delivered',
    sentAt: NOW,
  });
  return inbound?.id as string;
}

function linqFetch() {
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as { to?: string[] }) : null;
    if (String(url).endsWith('/chats') && init?.method === 'POST') {
      const to = body?.to ?? [];
      const id = to.length === 1 ? 'coparent-1' : 'group-1';
      return Response.json({ chat: { id, message: { id: `${id}-msg` } } }, { status: 201 });
    }
    return Response.json({}, { status: 200 });
  });
  return fetchMock;
}

async function inviteStates(): Promise<string[]> {
  const rows = await db.database
    .select({ state: schema.caregiverInvites.state })
    .from(schema.caregiverInvites);
  return rows.map((row) => row.state);
}

async function inviteOutbounds(): Promise<Array<{ channel: string; templateKey: string | null }>> {
  const rows = await db.database
    .select({
      channel: schema.channelMessages.channel,
      templateKey: schema.channelMessages.templateKey,
      direction: schema.channelMessages.direction,
      category: schema.channelMessages.category,
    })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.direction, 'out'));
  return rows
    .filter((row) => row.category === 'co_parent_invite')
    .map((row) => ({ channel: row.channel, templateKey: row.templateKey }));
}

describe('parseCoParentNumberReply', () => {
  it('reads the sandbox number and a name in front of one', () => {
    expect(parseCoParentNumberReply('9059629821')).toEqual({
      phoneE164: COPARENT_PHONE,
      name: null,
    });
    expect(parseCoParentNumberReply('Sam 905-962-9821')).toEqual({
      phoneE164: COPARENT_PHONE,
      name: 'Sam',
    });
  });

  it('leaves a name and a sentence for the other handlers', () => {
    expect(parseCoParentNumberReply('Jimmy')).toBeNull();
    expect(parseCoParentNumberReply('the school line is 9059629821')).toBeNull();
  });

  it('keeps the Linq sentence free of a URL, in both languages', () => {
    expect(linqCoParentInviteText('Jimmy', 'en')).toBe(LINQ_COPARENT_INVITE_TEXT.en('Jimmy'));
    expect(linqCoParentInviteText('Jimmy', 'fr')).toBe(LINQ_COPARENT_INVITE_TEXT.fr('Jimmy'));
    expect(linqCoParentInviteText('Jimmy', 'en')).not.toMatch(/https?:\/\//);
    expect(linqCoParentInviteText('Jimmy', 'fr')).not.toMatch(/https?:\/\//);
  });
});

describe('a number on the Linq door', () => {
  it('sends from LINQ_FROM_E164, ledgers the invite, and opens the group after the ack', async () => {
    const seeded = await seedHousehold();
    const inboundId = await seedAsk(seeded, 'imessage');
    const fetchMock = linqFetch();
    const sendSms = vi.fn();

    const outcome = await deliverCoParentNumberInvite(db.database, {
      ...seeded,
      body: '9059629821',
      now: NOW,
      inboundChannelMessageId: inboundId,
      sendSms,
      fetch: fetchMock,
    });

    expect(sendSms).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      status: 'sent',
      reply: coParentInviteSentAck('them', 'en'),
      templateKey: 'coparent:number_invite_ack',
    });
    const created = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(created.from).toBe(FROM);
    expect(created.to).toEqual([COPARENT_PHONE]);
    expect(created.message.parts[0].value).toBe(linqCoParentInviteText('Jimmy', 'en'));
    expect(await inviteStates()).toEqual(['awaiting_caregiver_reply']);
    expect(await inviteOutbounds()).toEqual([
      { channel: 'imessage', templateKey: LINQ_COPARENT_INVITE_TEMPLATE_KEY },
    ]);
    const consents = await db.database
      .select({
        evidence: schema.consentRecords.evidence,
        consentType: schema.consentRecords.consentType,
      })
      .from(schema.consentRecords);
    expect(consents).toHaveLength(1);
    expect(consents[0]?.consentType).toBe('co_parent_access_grant');
    expect(consents[0]?.evidence).toMatchObject({ question: CO_PARENT_ASK });
    const audits = await db.database
      .select({ actionTaken: schema.auditLog.actionTaken })
      .from(schema.auditLog);
    expect(audits.map((row) => row.actionTaken)).toContain('co_parent_sms_outbound');

    if (outcome.status !== 'sent' || !outcome.afterAck) {
      throw new Error('the Linq send did not leave an after-ack');
    }
    await outcome.afterAck();
    const group = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(group.to).toEqual([PARENT_PHONE, COPARENT_PHONE]);
    const [family] = await db.database
      .select({ linqGroupChatId: schema.families.linqGroupChatId })
      .from(schema.families);
    expect(family?.linqGroupChatId).toBe('group-1');
  });

  it('names them when the number reply did', async () => {
    const seeded = await seedHousehold();
    const inboundId = await seedAsk(seeded, 'imessage');
    const outcome = await deliverCoParentNumberInvite(db.database, {
      ...seeded,
      body: 'Sam 9059629821',
      now: NOW,
      inboundChannelMessageId: inboundId,
      sendSms: vi.fn(),
      fetch: linqFetch(),
    });
    expect(outcome).toMatchObject({ status: 'sent', reply: coParentInviteSentAck('Sam', 'en') });
  });

  it('says the group line when Linq refuses the 1:1, and does not claim a send', async () => {
    const seeded = await seedHousehold();
    const inboundId = await seedAsk(seeded, 'imessage');
    const fetchMock = vi.fn(async () => Response.json({ error: { code: 1002 } }, { status: 400 }));
    const outcome = await deliverCoParentNumberInvite(db.database, {
      ...seeded,
      body: '9059629821',
      now: NOW,
      inboundChannelMessageId: inboundId,
      sendSms: vi.fn(),
      fetch: fetchMock,
    });
    expect(outcome).toEqual({
      status: 'unreached',
      reply: LINQ_GROUP_UNREACHABLE_TEXT,
      templateKey: 'coparent:number_invite_held',
    });
    expect(await inviteStates()).toEqual(['awaiting_parent_assent']);
    expect(await inviteOutbounds()).toEqual([]);
    const consents = await db.database
      .select({ id: schema.consentRecords.id })
      .from(schema.consentRecords);
    expect(consents).toEqual([]);
  });

  it('redrives a timed-out 1:1 instead of saying the number was already texted', async () => {
    const seeded = await seedHousehold();
    const inboundId = await seedAsk(seeded, 'imessage');
    const aborting = vi.fn(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    await expect(
      deliverCoParentNumberInvite(db.database, {
        ...seeded,
        body: '9059629821',
        now: NOW,
        inboundChannelMessageId: inboundId,
        sendSms: vi.fn(),
        fetch: aborting,
      }),
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(await inviteStates()).toEqual(['awaiting_parent_assent']);

    const outcome = await deliverCoParentNumberInvite(db.database, {
      ...seeded,
      body: '9059629821',
      now: NOW,
      inboundChannelMessageId: inboundId,
      sendSms: vi.fn(),
      fetch: linqFetch(),
    });
    expect(outcome).toMatchObject({ status: 'sent', reply: coParentInviteSentAck('them', 'en') });
    expect(await inviteStates()).toEqual(['awaiting_caregiver_reply']);
    expect(await inviteOutbounds()).toHaveLength(1);
  });

  it('does not take a name, a missing ask, or a dark flag', async () => {
    const seeded = await seedHousehold();
    const inboundId = await seedAsk(seeded, 'imessage');
    const fetchMock = linqFetch();
    const send = {
      ...seeded,
      now: NOW,
      inboundChannelMessageId: inboundId,
      sendSms: vi.fn(),
      fetch: fetchMock,
    };
    expect(await deliverCoParentNumberInvite(db.database, { ...send, body: 'Jimmy' })).toEqual({
      status: 'not_pending',
    });

    await db.exec('truncate table channel_messages cascade');
    await db.database.insert(schema.channelMessages).values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      channel: 'imessage',
      direction: 'in',
      category: 'reply',
      providerMessageId: 'in-only',
      providerChatId: CHAT,
      status: 'delivered',
      body: '9059629821',
      sentAt: NOW,
    });
    expect(await deliverCoParentNumberInvite(db.database, { ...send, body: '9059629821' })).toEqual(
      { status: 'not_pending' },
    );

    await seedAsk(seeded, 'imessage');
    vi.stubEnv('F14_ENABLED', '');
    expect(
      await deliverCoParentNumberInvite(db.database, { ...send, body: '9059629821' }),
    ).toMatchObject({ status: 'refused', reply: CO_PARENT_REDIRECT });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await inviteStates()).toEqual([]);
  });
});

describe('a number on the SMS door', () => {
  it('texts the locked SMS body and does not call Linq', async () => {
    const seeded = await seedHousehold();
    const inboundId = await seedAsk(seeded, 'sms');
    const fetchMock = linqFetch();
    const sendSms = vi.fn(async () => ({ providerMessageId: 'SM_invite' }));
    const outcome = await deliverCoParentNumberInvite(db.database, {
      ...seeded,
      body: '9059629821',
      now: NOW,
      inboundChannelMessageId: inboundId,
      sendSms,
      fetch: fetchMock,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendSms).toHaveBeenCalledWith({
      to: COPARENT_PHONE,
      body: coParentInviteBody('Jimmy', 'en'),
    });
    expect(outcome).toMatchObject({
      status: 'sent',
      reply: coParentInviteSentAck('them', 'en'),
      afterAck: null,
    });
    expect(await inviteOutbounds()).toEqual([
      { channel: 'sms', templateKey: SMS_COPARENT_INVITE_TEMPLATE_KEY },
    ]);
    const [row] = await db.database
      .select({
        status: schema.channelMessages.status,
        templateKey: schema.channelMessages.templateKey,
      })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.templateKey, SMS_COPARENT_INVITE_TEMPLATE_KEY));
    expect(row?.status).toBe('queued');
    expect(await inviteStates()).toEqual(['awaiting_caregiver_reply']);
  });

  it('does not skip a YES the add-command is still waiting on', async () => {
    const seeded = await seedHousehold();
    const inboundId = await seedAsk(seeded, 'sms');
    await db.database.insert(schema.caregiverInvites).values({
      familyId: seeded.familyId,
      invitedByUserId: seeded.parentUserId,
      role: 'co_parent',
      displayName: 'Sam',
      phoneE164Encrypted: encryptString('+16475550199'),
      phoneE164Hash: phoneBlindIndex('+16475550199'),
      state: 'awaiting_parent_assent',
      expiresAt: new Date(NOW.getTime() + 72 * 60 * 60 * 1000),
      createdAt: NOW,
    });
    const sendSms = vi.fn();
    const outcome = await deliverCoParentNumberInvite(db.database, {
      ...seeded,
      body: '9059629821',
      now: NOW,
      inboundChannelMessageId: inboundId,
      sendSms,
      fetch: linqFetch(),
    });
    expect(outcome).toEqual({ status: 'not_pending' });
    expect(sendSms).not.toHaveBeenCalled();
    expect(await inviteStates()).toEqual(['awaiting_parent_assent']);
  });
});
