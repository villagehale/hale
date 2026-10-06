import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { recallChannelSigninParent } from '~/lib/auth/channel-signin';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  type OneToOneSend,
  deliverConnectLinkOneToOne,
  resumeConnectLink,
} from './connect-link-1to1';
import { fakeGroupOnboardingComposer } from './group-onboarding-voice-fake';
import { LinqSendError } from './transport';

/**
 * Group onboarding v2: a parent who said in the group who they are gets their connect
 * links 1:1, never in the group. One identification line (Hale, the household, STOP),
 * then each link as a part of its own.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const HALE = '+14165550100';
const PARENT = '+14165550111';
const DAD = '+14165550131';
const GRAN = '+14165550132';
const GROUP = 'chat-family-group';
const DIRECT = 'chat-dad-direct';
const NOW = new Date('2026-10-06T18:00:00.000Z');
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
  vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users cascade');
});

function oneToOne(options: { refuseText?: string } = {}) {
  const texts: Array<{ to: string; body: string }> = [];
  const links: Array<{ chatId: string; url: string }> = [];
  const send: OneToOneSend = {
    text: async (input) => {
      if (options.refuseText) throw new LinqSendError(options.refuseText, 403, true);
      texts.push(input);
      return { providerMessageId: `text-${texts.length}`, chatId: DIRECT };
    },
    link: async (input) => {
      links.push(input);
      return { providerMessageId: `link-${links.length}` };
    },
  };
  return { send, texts, links };
}

function groupSends() {
  const sends: Array<{ chatId: string; text: string }> = [];
  return {
    sends,
    send: async (input: { chatId: string; text: string }) => {
      sends.push(input);
      return { providerMessageId: `group-${sends.length}` };
    },
  };
}

async function seedPerson(
  familyId: string,
  phone: string,
  name: string | null,
  role: 'primary_parent' | 'co_parent' | 'grandparent',
) {
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:${phoneBlindIndex(phone)}`, name })
    .returning({ id: schema.users.id });
  const userId = user?.id as string;
  await db.database.insert(schema.familyMembers).values({ familyId, userId, role });
  await db.database.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: NOW,
  });
  return userId;
}

async function seedConfirmedGroup(role: 'co_parent' | 'grandparent' = 'co_parent') {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Riley + kids', provinceOrState: 'ON', linqGroupChatId: GROUP })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const primaryId = await seedPerson(familyId, PARENT, 'Riley', 'primary_parent');
  const phone = role === 'co_parent' ? DAD : GRAN;
  const userId = await seedPerson(familyId, phone, null, role);
  const [roster] = await db.database
    .insert(schema.linqGroupRosters)
    .values({ chatId: GROUP, familyId, source: 'added_to_existing', status: 'confirmed' })
    .returning({ id: schema.linqGroupRosters.id });
  await db.database.insert(schema.linqGroupRosterMembers).values([
    {
      rosterId: roster?.id as string,
      chatId: GROUP,
      phoneE164Encrypted: encryptString(PARENT),
      phoneE164Hash: phoneBlindIndex(PARENT),
      knownUserId: primaryId,
      status: 'known_parent',
    },
    {
      rosterId: roster?.id as string,
      chatId: GROUP,
      phoneE164Encrypted: encryptString(phone),
      phoneE164Hash: phoneBlindIndex(phone),
      userId,
      status: 'confirmed',
      confirmedRole: role,
    },
  ]);
  return { familyId, primaryId, userId };
}

async function connectStep() {
  const rows = await db.database
    .select({
      hash: schema.linqGroupRosterMembers.phoneE164Hash,
      step: schema.linqGroupRosterMembers.connectStep,
    })
    .from(schema.linqGroupRosterMembers);
  return rows.find((row) => row.hash === phoneBlindIndex(DAD))?.step;
}

async function verbs(familyId: string) {
  const rows = await db.database
    .select({ actionTaken: schema.auditLog.actionTaken })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.familyId, familyId));
  return rows.map((row) => row.actionTaken);
}

describe('deliverConnectLinkOneToOne', () => {
  it('sends one identification line 1:1, then each link as a part alone, and nothing to the group', async () => {
    const { familyId, userId } = await seedConfirmedGroup();
    const direct = oneToOne();
    const group = groupSends();
    const voice = fakeGroupOnboardingComposer();

    const result = await deliverConnectLinkOneToOne(db.database, {
      familyId,
      userId,
      groupChatId: GROUP,
      now: NOW,
      voice,
      oneToOne: direct.send,
      groupSend: group.send,
    });

    expect(result).toEqual({ outcome: 'sent', links: 2 });
    expect(direct.texts).toHaveLength(1);
    const [line] = direct.texts;
    expect(line?.to).toBe(DAD);
    expect(line?.body).toContain('Hale');
    expect(line?.body).toContain('Riley');
    expect(line?.body).toContain('STOP');
    expect(line?.body).not.toMatch(URL_IN_TEXT);
    expect(direct.links.map((link) => link.chatId)).toEqual([DIRECT, DIRECT]);
    expect(direct.links.map((link) => new URL(link.url).searchParams.get('to'))).toEqual([
      'gcal',
      'gmail',
    ]);
    expect(group.sends).toEqual([]);
    expect(voice.calls[0]?.input).toMatchObject({
      kind: 'connect_link_1to1',
      address: 'tu',
      linkFollows: true,
      wayOut: true,
    });

    const ledger = await db.database
      .select({
        templateKey: schema.channelMessages.templateKey,
        providerChatId: schema.channelMessages.providerChatId,
        parentUserId: schema.channelMessages.parentUserId,
      })
      .from(schema.channelMessages);
    expect(ledger).toHaveLength(3);
    expect(
      ledger.every(
        (row) =>
          row.templateKey === 'linq:connect_link_1to1' &&
          row.providerChatId === DIRECT &&
          row.parentUserId === userId,
      ),
    ).toBe(true);
    expect(await connectStep()).toBe('link_sent');
    const trail = await verbs(familyId);
    expect(trail.filter((verb) => verb === 'linq_group_connect_link_sent')).toHaveLength(1);
    expect(trail.filter((verb) => verb === 'connector_link_minted')).toHaveLength(2);
    expect(trail.filter((verb) => verb === 'sms_reply_sent')).toHaveLength(3);
  });

  it('sends the links once per person', async () => {
    const { familyId, userId } = await seedConfirmedGroup();
    const direct = oneToOne();
    const voice = fakeGroupOnboardingComposer();
    const args = { familyId, userId, groupChatId: GROUP, now: NOW, voice, oneToOne: direct.send };

    await deliverConnectLinkOneToOne(db.database, args);
    const again = await deliverConnectLinkOneToOne(db.database, args);

    expect(again).toEqual({ outcome: 'already_sent' });
    expect(direct.texts).toHaveLength(1);
    expect(direct.links).toHaveLength(2);
  });

  it('names a refused 1:1, asks in the group with no link, and sends the link on their next message', async () => {
    const { familyId, userId } = await seedConfirmedGroup();
    const refused = oneToOne({ refuseText: 'chat_not_allowed' });
    const group = groupSends();
    const voice = fakeGroupOnboardingComposer();

    const result = await deliverConnectLinkOneToOne(db.database, {
      familyId,
      userId,
      groupChatId: GROUP,
      now: NOW,
      voice,
      oneToOne: refused.send,
      groupSend: group.send,
    });

    expect(result).toEqual({
      outcome: '1to1_unreachable',
      code: 'chat_not_allowed',
      groupNotice: { outcome: 'sent', source: 'composed' },
    });
    expect(refused.links).toEqual([]);
    expect(group.sends).toHaveLength(1);
    expect(group.sends[0]?.chatId).toBe(GROUP);
    expect(group.sends[0]?.text).toMatch(/^text_me_directly:/);
    expect(group.sends[0]?.text).not.toMatch(URL_IN_TEXT);
    expect(await connectStep()).toBe('unreachable');

    const direct = oneToOne();
    const resumed = await resumeConnectLink(db.database, {
      phone: DAD,
      now: NOW,
      voice,
      oneToOne: direct.send,
      groupSend: group.send,
    });
    expect(resumed).toEqual({ outcome: 'sent', links: 2 });
    expect(direct.texts).toHaveLength(1);
    expect(await connectStep()).toBe('link_sent');
    expect(group.sends).toHaveLength(1);
  });

  it('a refused second link resends the whole set on the next message, and every link in the chat that counts still works', async () => {
    const { familyId, userId } = await seedConfirmedGroup();
    const texts: Array<{ to: string; body: string }> = [];
    const links: Array<{ chatId: string; url: string }> = [];
    let refuseNextGmail = true;
    const flaky: OneToOneSend = {
      text: async (input) => {
        texts.push(input);
        return { providerMessageId: `text-${texts.length}`, chatId: DIRECT };
      },
      link: async (input) => {
        if (refuseNextGmail && new URL(input.url).searchParams.get('to') === 'gmail') {
          refuseNextGmail = false;
          throw new LinqSendError('rate_limited', 429, false);
        }
        links.push(input);
        return { providerMessageId: `link-${links.length}` };
      },
    };
    const voice = fakeSpokenLineComposer();

    const first = await deliverConnectLinkOneToOne(db.database, {
      familyId,
      userId,
      groupChatId: GROUP,
      now: NOW,
      voice,
      oneToOne: flaky,
    });
    expect(first).toEqual({ outcome: 'link_not_sent', code: 'rate_limited' });
    expect(links.map((link) => new URL(link.url).searchParams.get('to'))).toEqual(['gcal']);
    expect(await connectStep()).toBe('none');

    const resumed = await resumeConnectLink(db.database, {
      phone: DAD,
      now: NOW,
      voice,
      oneToOne: flaky,
    });

    expect(resumed).toEqual({ outcome: 'sent', links: 2 });
    expect(links).toHaveLength(3);
    const latest = links.slice(-2);
    expect(latest.map((link) => new URL(link.url).searchParams.get('to'))).toEqual([
      'gcal',
      'gmail',
    ]);
    for (const link of latest) {
      const token = new URL(link.url).searchParams.get('t') as string;
      const recalled = await recallChannelSigninParent(token, db.database, { now: NOW });
      expect(recalled?.usable).toBe(true);
    }
    expect(await connectStep()).toBe('link_sent');
  });

  it('names a missing Linq key without asking anyone in the group, and tries again later', async () => {
    const { familyId, userId } = await seedConfirmedGroup();
    const unconfigured = oneToOne({ refuseText: 'not_configured' });
    const group = groupSends();

    const result = await deliverConnectLinkOneToOne(db.database, {
      familyId,
      userId,
      groupChatId: GROUP,
      now: NOW,
      voice: fakeGroupOnboardingComposer(),
      oneToOne: unconfigured.send,
      groupSend: group.send,
    });

    expect(result).toEqual({ outcome: '1to1_not_sent', code: 'not_configured' });
    expect(group.sends).toEqual([]);
    expect(await connectStep()).toBe('none');
  });

  it('sends nothing and mints nothing when the line could not be written', async () => {
    const { familyId, userId } = await seedConfirmedGroup();
    const direct = oneToOne();

    const result = await deliverConnectLinkOneToOne(db.database, {
      familyId,
      userId,
      groupChatId: GROUP,
      now: NOW,
      voice: fakeGroupOnboardingComposer({ fail: true }),
      oneToOne: direct.send,
    });

    expect(result).toEqual({ outcome: 'group_line_unsent', fallback: 'model_failed' });
    expect(direct.texts).toEqual([]);
    const trail = await verbs(familyId);
    expect(trail).toContain('group_line_unsent');
    expect(trail).not.toContain('connector_link_minted');
    expect(await connectStep()).toBe('none');
  });

  it('gives a grandparent no connect link', async () => {
    const { familyId, userId } = await seedConfirmedGroup('grandparent');
    const direct = oneToOne();

    const result = await deliverConnectLinkOneToOne(db.database, {
      familyId,
      userId,
      groupChatId: GROUP,
      now: NOW,
      voice: fakeGroupOnboardingComposer(),
      oneToOne: direct.send,
    });

    expect(result).toEqual({ outcome: 'not_enrolled' });
    expect(direct.texts).toEqual([]);
    expect(direct.links).toEqual([]);
  });
});
