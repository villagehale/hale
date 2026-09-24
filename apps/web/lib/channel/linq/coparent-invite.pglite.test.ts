import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALREADY_INVITED, CO_PARENT_REDIRECT } from '~/lib/channel/caregiver/copy';
import { coParentInviteBody, coParentInviteSentAck } from '~/lib/channel/coparent/copy';
import { INTAKE_COPARENT_ASK_TEMPLATE_KEY } from '~/lib/channel/intake/copy';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  LINQ_GROUP_INSTRUCTIONS_TEMPLATE_KEY,
  SMS_COPARENT_INVITE_TEMPLATE_KEY,
  deliverCoParentNumberInvite,
  parseCoParentNumberReply,
} from './coparent-invite';
import {
  LINQ_GROUP_LINE_MISSING_TEXT,
  formatLinqLineForParent,
  linqGroupMakeInstruction,
} from './group';

/**
 * A number after the co-parent ask. SMS still texts the locked invite. Linq
 * stores the number and tells the parent how to start the group. It does not
 * text that number, and it does not claim a group from the number alone.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const PARENT_PHONE = '+14165550111';
const COPARENT_PHONE = '+19059629821';
const FROM = '+16462352164';
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
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Linq must not be called for a co-parent number');
    }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
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

async function inviteStates(): Promise<string[]> {
  const rows = await db.database
    .select({ state: schema.caregiverInvites.state })
    .from(schema.caregiverInvites);
  return rows.map((row) => row.state);
}

async function groupChatId(): Promise<string | null> {
  const [family] = await db.database
    .select({ linqGroupChatId: schema.families.linqGroupChatId })
    .from(schema.families);
  return family?.linqGroupChatId ?? null;
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
});

describe('a number on the Linq door', () => {
  it('stores the number and tells the parent how to start the group', async () => {
    const seeded = await seedHousehold();
    const inboundId = await seedAsk(seeded, 'imessage');
    const sendSms = vi.fn();

    const outcome = await deliverCoParentNumberInvite(db.database, {
      ...seeded,
      body: '9059629821',
      now: NOW,
      inboundChannelMessageId: inboundId,
      sendSms,
    });

    expect(sendSms).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      status: 'instructed',
      reply: linqGroupMakeInstruction(formatLinqLineForParent(FROM), 'en'),
      templateKey: LINQ_GROUP_INSTRUCTIONS_TEMPLATE_KEY,
    });
    expect(outcome.status === 'instructed' ? outcome.reply : '').not.toMatch(/invite/i);
    expect(await inviteStates()).toEqual(['identity_noted']);
    expect(await groupChatId()).toBeNull();
    const outbounds = await db.database
      .select({
        category: schema.channelMessages.category,
        templateKey: schema.channelMessages.templateKey,
      })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.direction, 'out'));
    expect(outbounds.filter((row) => row.category === 'co_parent_invite')).toEqual([]);
    const consents = await db.database
      .select({ id: schema.consentRecords.id })
      .from(schema.consentRecords);
    expect(consents).toEqual([]);
    const audits = await db.database
      .select({ actionTaken: schema.auditLog.actionTaken })
      .from(schema.auditLog);
    expect(audits.map((row) => row.actionTaken)).toContain('co_parent_identity_noted');
    expect(audits.map((row) => row.actionTaken)).not.toContain('co_parent_sms_outbound');
  });

  it('repeats the instructions when the number is already noted, and does not say it was texted', async () => {
    const seeded = await seedHousehold();
    const inboundId = await seedAsk(seeded, 'imessage');
    const input = {
      ...seeded,
      body: '9059629821',
      now: NOW,
      inboundChannelMessageId: inboundId,
      sendSms: vi.fn(),
    };
    await deliverCoParentNumberInvite(db.database, input);
    const outcome = await deliverCoParentNumberInvite(db.database, input);

    expect(outcome).toMatchObject({
      status: 'instructed',
      templateKey: LINQ_GROUP_INSTRUCTIONS_TEMPLATE_KEY,
    });
    if (outcome.status !== 'instructed') throw new Error('expected the group instructions');
    expect(outcome.reply).not.toBe(ALREADY_INVITED);
    expect(outcome.reply).not.toMatch(/texted/i);
    expect(await inviteStates()).toEqual(['identity_noted']);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('says the line is missing when Hale has no number to add, and still stores the identity', async () => {
    vi.stubEnv('LINQ_FROM_E164', '');
    const seeded = await seedHousehold();
    const inboundId = await seedAsk(seeded, 'imessage');
    const outcome = await deliverCoParentNumberInvite(db.database, {
      ...seeded,
      body: '9059629821',
      now: NOW,
      inboundChannelMessageId: inboundId,
      sendSms: vi.fn(),
    });
    expect(outcome).toEqual({
      status: 'unreached',
      reply: LINQ_GROUP_LINE_MISSING_TEXT.en,
      templateKey: 'coparent:number_invite_held',
    });
    expect(await inviteStates()).toEqual(['identity_noted']);
    expect(await groupChatId()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('still instructs when the SMS flag is dark, and does not take a name or a missing ask', async () => {
    const seeded = await seedHousehold();
    const inboundId = await seedAsk(seeded, 'imessage');
    const send = {
      ...seeded,
      now: NOW,
      inboundChannelMessageId: inboundId,
      sendSms: vi.fn(),
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
    const outcome = await deliverCoParentNumberInvite(db.database, {
      ...send,
      body: '9059629821',
    });
    expect(outcome).toMatchObject({
      status: 'instructed',
      templateKey: LINQ_GROUP_INSTRUCTIONS_TEMPLATE_KEY,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(await inviteStates()).toEqual(['identity_noted']);
  });
});

describe('a number on the SMS door', () => {
  it('still texts the locked SMS body when the Linq group flag is on', async () => {
    vi.stubEnv('LINQ_GROUP_COPARENT', 'on');
    const seeded = await seedHousehold();
    const inboundId = await seedAsk(seeded, 'sms');
    const sendSms = vi.fn(async () => ({ providerMessageId: 'SM_invite_flag' }));
    const outcome = await deliverCoParentNumberInvite(db.database, {
      ...seeded,
      body: '9059629821',
      now: NOW,
      inboundChannelMessageId: inboundId,
      sendSms,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(sendSms).toHaveBeenCalledWith({
      to: COPARENT_PHONE,
      body: coParentInviteBody('Jimmy', 'en'),
    });
    expect(outcome.status).toBe('sent');
    expect(await inviteStates()).toEqual(['awaiting_caregiver_reply']);
    expect(await groupChatId()).toBeNull();
  });

  it('texts the locked SMS body and does not call Linq', async () => {
    const seeded = await seedHousehold();
    const inboundId = await seedAsk(seeded, 'sms');
    const sendSms = vi.fn(async () => ({ providerMessageId: 'SM_invite' }));
    const outcome = await deliverCoParentNumberInvite(db.database, {
      ...seeded,
      body: '9059629821',
      now: NOW,
      inboundChannelMessageId: inboundId,
      sendSms,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(sendSms).toHaveBeenCalledWith({
      to: COPARENT_PHONE,
      body: coParentInviteBody('Jimmy', 'en'),
    });
    expect(outcome).toEqual({
      status: 'sent',
      reply: coParentInviteSentAck('them', 'en'),
      templateKey: 'coparent:number_invite_ack',
    });
    const [row] = await db.database
      .select({
        status: schema.channelMessages.status,
        templateKey: schema.channelMessages.templateKey,
        channel: schema.channelMessages.channel,
      })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.templateKey, SMS_COPARENT_INVITE_TEMPLATE_KEY));
    expect(row).toMatchObject({ status: 'queued', channel: 'sms' });
    expect(await inviteStates()).toEqual(['awaiting_caregiver_reply']);
    expect(await groupChatId()).toBeNull();
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
    });
    expect(outcome).toEqual({ status: 'not_pending' });
    expect(sendSms).not.toHaveBeenCalled();
    expect(await inviteStates()).toEqual(['awaiting_parent_assent']);
  });

  it('redirects and does not text when the SMS flag is dark', async () => {
    vi.stubEnv('F14_ENABLED', '');
    const seeded = await seedHousehold();
    const inboundId = await seedAsk(seeded, 'sms');
    const sendSms = vi.fn();
    const outcome = await deliverCoParentNumberInvite(db.database, {
      ...seeded,
      body: '9059629821',
      now: NOW,
      inboundChannelMessageId: inboundId,
      sendSms,
    });
    expect(outcome).toMatchObject({ status: 'refused', reply: CO_PARENT_REDIRECT });
    expect(sendSms).not.toHaveBeenCalled();
    expect(await inviteStates()).toEqual([]);
  });
});
