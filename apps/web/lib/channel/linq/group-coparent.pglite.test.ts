import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNEL_SIGNIN_TTL_MS, consumeChannelSigninToken } from '~/lib/auth/channel-signin';
import { NAME_CAPTURED_REPLY } from '~/lib/channel/router/copy';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  LINQ_GROUP_TRIGGER_PHRASE,
  claimHouseholdLinqGroup,
  formatLinqLineForParent,
  linqGroupMakeInstruction,
} from './group';
import {
  considerGroupCoparent,
  sendCoparentGroupCalendarReceipt,
  steerNotedCoparentOneToOne,
} from './group-coparent';
import {
  GROUP_WELCOME,
  groupCalendarAsk,
  groupCalendarReceipt,
  groupGmailAsk,
  groupGmailReceipt,
} from './group-coparent-copy';
import type { LinqInboundText } from './payload';
import { LINQ_POLL_PLACEHOLDER_PROMPT } from './poll';

/**
 * A noted number speaking in the claimed group becomes the co-parent of the
 * same family. Children and postal code are not collected again. Connector
 * links are minted for that parent.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const PARENT_PHONE = '+14165550111';
const COPARENT_PHONE = '+19059629821';
const FROM = '+16462352164';
const POSTAL = 'M5V2T6';
const NOW = new Date('2026-09-24T18:00:00.000Z');
const GROUP = 'chat-household-group';
const GROUP_MESSAGES = `https://api.linqapp.com/api/partner/v3/chats/${GROUP}/messages`;
const ONE_TO_ONE = 'chat-coparent-1to1';

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
  vi.stubEnv('LINQ_FROM_E164', FROM);
  vi.stubEnv('LINQ_GROUP_COPARENT', 'on');
  stubTwilioConfigured();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users cascade');
});

function linqFetch(opts?: { failCreate?: boolean; failMessages?: boolean }): {
  fetch: typeof fetch;
  texts: () => string[];
  urls: () => string[];
  twilioUrls: () => string[];
  groupTexts: () => string[];
  groupLinks: () => string[];
  privateTexts: () => string[];
  createdChats: () => number;
} {
  const sent: { url: string; type: string; value: string }[] = [];
  const urls: string[] = [];
  const twilioUrls: string[] = [];
  let created = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('twilio.com')) twilioUrls.push(target);
      return new Response('{}', { status: 500 });
    }),
  );
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    urls.push(target);
    if (target.includes('twilio.com')) twilioUrls.push(target);
    if (target.endsWith('/chats') && !target.includes('/messages')) created += 1;
    if (opts?.failCreate && target.endsWith('/chats') && !target.includes('/messages')) {
      return new Response(JSON.stringify({ error: { code: 1006 } }), { status: 400 });
    }
    if (opts?.failMessages && target.includes('/messages')) {
      return new Response(JSON.stringify({ error: { code: 5001 } }), { status: 500 });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const parts =
      (body as { message?: { parts?: { type?: string; value?: string }[] } } | null)?.message
        ?.parts ?? [];
    for (const part of parts) {
      if (part.value) sent.push({ url: target, type: part.type ?? 'text', value: part.value });
    }
    const id = `m-${sent.length}`;
    if (target.endsWith('/chats')) {
      return new Response(
        JSON.stringify({ chat: { id: 'chat-coparent-private', message: { id } } }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ message: { id } }), { status: 200 });
  });
  const values = (pred: (row: { url: string; type: string }) => boolean) => () =>
    sent.filter(pred).map((row) => row.value);
  return {
    fetch: fetchImpl as unknown as typeof fetch,
    texts: () => sent.map((row) => row.value),
    urls: () => [...urls],
    twilioUrls: () => [...twilioUrls],
    groupTexts: values((row) => row.type === 'text' && row.url.includes(GROUP)),
    groupLinks: values((row) => row.type === 'link' && row.url.includes(GROUP)),
    privateTexts: values((row) => !row.url.includes(GROUP)),
    createdChats: () => created,
  };
}

function stubTwilioConfigured(): void {
  vi.stubEnv('TWILIO_ACCOUNT_SID', 'AC00000000000000000000000000000000');
  vi.stubEnv('TWILIO_AUTH_TOKEN', 'auth-token');
  vi.stubEnv('TWILIO_API_KEY_SID', 'SK11111111111111111111111111111111');
  vi.stubEnv('TWILIO_API_KEY_SECRET', 'api-key-secret');
  vi.stubEnv('TWILIO_FROM_NUMBER', '+14165550000');
}

function expectLinqGroupOnly(wire: { urls: () => string[]; twilioUrls: () => string[] }): void {
  expect(wire.urls().length).toBeGreaterThan(0);
  expect(wire.urls().every((url) => url === GROUP_MESSAGES)).toBe(true);
  expect(wire.twilioUrls()).toEqual([]);
}

function inbound(
  over: Partial<LinqInboundText> & Pick<LinqInboundText, 'messageId' | 'senderHandle' | 'text'>,
): LinqInboundText {
  return {
    chatId: GROUP,
    mediaCount: 0,
    receivedAt: NOW,
    otherHandles: [],
    ...over,
  };
}

async function recordInbound(
  message: LinqInboundText,
  owner: { familyId: string; userId: string },
): Promise<string | null> {
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: owner.familyId,
      parentUserId: owner.userId,
      channel: 'imessage',
      direction: 'in',
      category: 'reply',
      providerMessageId: message.messageId,
      providerChatId: message.chatId,
      status: 'delivered',
      body: message.text,
      sentAt: message.receivedAt,
      handedOffAt: NOW,
    })
    .onConflictDoNothing()
    .returning({ id: schema.channelMessages.id });
  return row?.id ?? null;
}

async function seedHousehold(): Promise<{ familyId: string; parentUserId: string }> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Barton + kids', provinceOrState: 'ON', postalCode: POSTAL })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `imessage:barton-${family?.id}`, name: 'Barton' })
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
  await db.database.insert(schema.children).values({
    familyId,
    name: 'Maya',
    dateOfBirth: '2022-04-01',
  });
  return { familyId, parentUserId };
}

async function noteCoparent(
  seeded: { familyId: string; parentUserId: string },
  expiresAt = new Date(NOW.getTime() + 72 * 60 * 60 * 1000),
): Promise<void> {
  await db.database.insert(schema.caregiverInvites).values({
    familyId: seeded.familyId,
    invitedByUserId: seeded.parentUserId,
    role: 'co_parent',
    displayName: 'Sam',
    phoneE164Encrypted: encryptString(COPARENT_PHONE),
    phoneE164Hash: phoneBlindIndex(COPARENT_PHONE),
    state: 'identity_noted',
    expiresAt,
    createdAt: NOW,
  });
}

async function familyCount(): Promise<number> {
  const rows = await db.database.select({ id: schema.families.id }).from(schema.families);
  return rows.length;
}

async function childNames(): Promise<string[]> {
  const rows = await db.database.select({ name: schema.children.name }).from(schema.children);
  return rows.map((row) => row.name);
}

describe('group co-parent seating', () => {
  it('does nothing while the flag is off', async () => {
    vi.stubEnv('LINQ_GROUP_COPARENT', 'off');
    const seeded = await seedHousehold();
    await noteCoparent(seeded);
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: GROUP })
      .where(eq(schema.families.id, seeded.familyId));
    const wire = linqFetch();
    const effect = await considerGroupCoparent(
      db.database,
      inbound({ messageId: 'm-off', senderHandle: COPARENT_PHONE, text: 'hi' }),
      { now: NOW, fetch: wire.fetch, recordInbound },
    );
    expect(effect).toEqual({ type: 'none' });
    expect(wire.texts()).toEqual([]);
    expect(await familyCount()).toBe(1);
    const members = await db.database
      .select({ role: schema.familyMembers.role })
      .from(schema.familyMembers);
    expect(members.map((row) => row.role)).toEqual(['primary_parent']);
  });

  it('lets the parent claim a group that already holds the noted number', async () => {
    const seeded = await seedHousehold();
    await noteCoparent(seeded);
    const effect = await considerGroupCoparent(
      db.database,
      inbound({
        messageId: 'm-claim',
        senderHandle: PARENT_PHONE,
        text: LINQ_GROUP_TRIGGER_PHRASE.en,
        otherHandles: [COPARENT_PHONE],
      }),
      { now: NOW, fetch: linqFetch().fetch, recordInbound },
    );
    expect(effect).toMatchObject({
      type: 'claim',
      familyId: seeded.familyId,
      userId: seeded.parentUserId,
    });

    const unnoted = await considerGroupCoparent(
      db.database,
      inbound({
        messageId: 'm-claim-plain',
        senderHandle: PARENT_PHONE,
        text: LINQ_GROUP_TRIGGER_PHRASE.en,
        otherHandles: ['+14165550999', 'not-a-phone'],
      }),
      { now: NOW, fetch: linqFetch().fetch, recordInbound },
    );
    expect(unnoted).toMatchObject({ type: 'claim', familyId: seeded.familyId });
    const claim = await claimHouseholdLinqGroup(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      chatId: GROUP,
      now: NOW,
    });
    expect(claim.status).toBe('claimed');
  });

  it('does not seat a bot or a phone that already belongs to another family', async () => {
    const seeded = await seedHousehold();
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: GROUP })
      .where(eq(schema.families.id, seeded.familyId));
    const bot = await considerGroupCoparent(
      db.database,
      inbound({ messageId: 'm-bot', senderHandle: 'camp-bot@example.com', text: 'hi' }),
      { now: NOW, fetch: linqFetch().fetch, recordInbound },
    );
    expect(bot).toEqual({ type: 'none' });

    const [otherFamily] = await db.database
      .insert(schema.families)
      .values({ displayName: 'Other household' })
      .returning({ id: schema.families.id });
    const [otherUser] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: `imessage:other-${otherFamily?.id}`, name: 'Other' })
      .returning({ id: schema.users.id });
    await db.database.insert(schema.familyMembers).values({
      familyId: otherFamily?.id as string,
      userId: otherUser?.id as string,
      role: 'primary_parent',
    });
    await db.database.insert(schema.parentChannels).values({
      userId: otherUser?.id as string,
      familyId: otherFamily?.id as string,
      kind: 'sms',
      phoneE164Encrypted: encryptString(COPARENT_PHONE),
      phoneE164Hash: phoneBlindIndex(COPARENT_PHONE),
      verifiedAt: NOW,
    });
    const taken = await considerGroupCoparent(
      db.database,
      inbound({ messageId: 'm-taken', senderHandle: COPARENT_PHONE, text: 'hi' }),
      { now: NOW, fetch: linqFetch().fetch, recordInbound },
    );
    expect(taken).toEqual({ type: 'none' });
    const members = await db.database
      .select({ familyId: schema.familyMembers.familyId, role: schema.familyMembers.role })
      .from(schema.familyMembers)
      .where(eq(schema.familyMembers.familyId, seeded.familyId));
    expect(members.some((row) => row.role === 'co_parent')).toBe(false);
  });

  it('seats the noted number on the same family and asks only for a name', async () => {
    const seeded = await seedHousehold();
    await noteCoparent(seeded);
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: GROUP })
      .where(eq(schema.families.id, seeded.familyId));
    const wire = linqFetch();
    const effect = await considerGroupCoparent(
      db.database,
      inbound({ messageId: 'm-seat', senderHandle: COPARENT_PHONE, text: 'hi there' }),
      { now: NOW, fetch: wire.fetch, recordInbound },
    );
    expect(effect).toMatchObject({ type: 'done', outcome: 'group_coparent_seated' });
    expect(wire.groupTexts()).toEqual([GROUP_WELCOME.en]);
    expect(wire.texts().join('\n')).not.toContain('Maya');
    expect(await familyCount()).toBe(1);
    expect(await childNames()).toEqual(['Maya']);
    const [family] = await db.database
      .select({ postalCode: schema.families.postalCode })
      .from(schema.families);
    expect(family?.postalCode).toBe(POSTAL);
    const members = await db.database
      .select({
        userId: schema.familyMembers.userId,
        role: schema.familyMembers.role,
        familyId: schema.familyMembers.familyId,
      })
      .from(schema.familyMembers);
    const coparent = members.find((row) => row.role === 'co_parent');
    expect(coparent?.familyId).toBe(seeded.familyId);
    expect(members).toHaveLength(2);
    const [invite] = await db.database
      .select({ state: schema.caregiverInvites.state, closedAt: schema.caregiverInvites.closedAt })
      .from(schema.caregiverInvites);
    expect(invite?.state).toBe('accepted');
    expect(invite?.closedAt).not.toBeNull();
    for (const text of wire.texts()) {
      expect(text).not.toContain(POSTAL);
      expect(text.toLowerCase()).not.toContain('postal');
      expect(text.toLowerCase()).not.toContain('how old');
    }

    const named = await considerGroupCoparent(
      db.database,
      inbound({ messageId: 'm-name', senderHandle: COPARENT_PHONE, text: 'Sam' }),
      { now: NOW, fetch: wire.fetch, recordInbound },
    );
    expect(named).toMatchObject({ type: 'done', outcome: 'group_coparent_named' });
    expect(wire.texts().at(-1)).toBe(NAME_CAPTURED_REPLY);
    const [namedUser] = await db.database
      .select({ name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.id, coparent?.userId as string));
    expect(namedUser?.name).toBe('Sam');
    const [step] = await db.database
      .select({ step: schema.linqGroupOnboarding.step })
      .from(schema.linqGroupOnboarding);
    expect(step?.step).toBe('awaiting_calendar');
    expect(wire.groupTexts().join('\n')).not.toContain('/connect?t=');

    const calendar = await considerGroupCoparent(
      db.database,
      inbound({ messageId: 'm-cal', senderHandle: COPARENT_PHONE, text: 'ready' }),
      { now: NOW, fetch: wire.fetch, recordInbound },
    );
    expect(calendar).toMatchObject({ type: 'done', outcome: 'group_coparent_gcal' });
    const afterCalendar = wire.groupTexts();
    const calendarBubble = afterCalendar.at(-1) ?? '';
    expect(calendarBubble.startsWith(groupCalendarAsk('en', 'Sam'))).toBe(true);
    expect(
      afterCalendar.filter((text) => text.startsWith(groupCalendarAsk('en', 'Sam'))),
    ).toHaveLength(1);
    expect(calendarBubble).toContain('\n');
    expect(calendarBubble).toContain('to=gcal');
    expect(wire.groupLinks()).toEqual([]);
    expect(afterCalendar.join('\n')).not.toContain(groupGmailAsk('en', 'Sam'));
    expect(groupCalendarAsk('en', 'Sam')).not.toContain('/connect?t=');
    expect(wire.createdChats()).toBe(0);
    expect(wire.privateTexts()).toEqual([]);
    const calendarToken = new URL(calendarBubble.split('\n')[1] ?? '').searchParams.get('t');
    expect(calendarToken).toBeTruthy();
    expect(groupCalendarAsk('en', 'Sam')).not.toContain(calendarToken ?? 'missing-token');
    const [afterAsk] = await db.database
      .select({ step: schema.linqGroupOnboarding.step })
      .from(schema.linqGroupOnboarding);
    expect(afterAsk?.step).toBe('awaiting_gmail');

    const groupBeforeGmail = wire.groupTexts().length;
    const declined = await considerGroupCoparent(
      db.database,
      inbound({ messageId: 'm-no', senderHandle: COPARENT_PHONE, text: 'no thanks' }),
      { now: NOW, fetch: wire.fetch, recordInbound },
    );
    expect(declined).toMatchObject({ type: 'done', outcome: 'group_coparent_gmail' });
    const gmailBubbles = wire.groupTexts().slice(groupBeforeGmail);
    expect(gmailBubbles).toHaveLength(1);
    expect(gmailBubbles[0]?.startsWith(groupGmailAsk('en', 'Sam'))).toBe(true);
    expect(gmailBubbles[0]).toContain('to=gmail');
    expect(wire.groupLinks()).toEqual([]);
    expect(groupGmailAsk('en', 'Sam')).not.toContain('/connect?t=');
    expect(wire.createdChats()).toBe(0);
    expect(wire.privateTexts()).toEqual([]);
    const gmailToken = new URL((gmailBubbles[0] ?? '').split('\n')[1] ?? '').searchParams.get('t');
    expect(gmailToken).toBeTruthy();
    expect(groupGmailAsk('en', 'Sam')).not.toContain(gmailToken ?? 'missing-token');

    const beforeIgnore = wire.groupTexts().length;
    const ignored = await considerGroupCoparent(
      db.database,
      inbound({ messageId: 'm-ignore', senderHandle: COPARENT_PHONE, text: 'maybe later' }),
      { now: NOW, fetch: wire.fetch, recordInbound },
    );
    expect(ignored).toMatchObject({ type: 'route_member' });
    expect(wire.groupTexts()).toHaveLength(beforeIgnore);
    expect(
      wire.groupTexts().filter((text) => text.startsWith(groupGmailAsk('en', 'Sam'))),
    ).toHaveLength(1);

    const tokens = await db.database
      .select({
        userId: schema.channelSigninTokens.userId,
        consumedAt: schema.channelSigninTokens.consumedAt,
      })
      .from(schema.channelSigninTokens);
    const live = tokens.filter((row) => row.consumedAt === null);
    expect(live).toHaveLength(2);
    expect(live.every((row) => row.userId === coparent?.userId)).toBe(true);
    expect(live.some((row) => row.userId === seeded.parentUserId)).toBe(false);
    const seats = await db.database
      .select({
        familyId: schema.familyMembers.familyId,
        userId: schema.familyMembers.userId,
        role: schema.familyMembers.role,
      })
      .from(schema.familyMembers);
    const seat = seats.find((row) => row.role === 'co_parent');
    expect(seat?.familyId).toBe(seeded.familyId);
    expect(seat?.userId).toBe(coparent?.userId);
    expect(live.every((row) => row.userId === seat?.userId)).toBe(true);
    const stamped = await db.database
      .select({
        userId: schema.channelSigninTokens.userId,
        expiresAt: schema.channelSigninTokens.expiresAt,
        consumedAt: schema.channelSigninTokens.consumedAt,
      })
      .from(schema.channelSigninTokens);
    expect(
      stamped
        .filter((row) => row.consumedAt === null)
        .every((row) => row.expiresAt.getTime() === NOW.getTime() + CHANNEL_SIGNIN_TTL_MS),
    ).toBe(true);
    const used = await consumeChannelSigninToken(gmailToken ?? '', db.database, { now: NOW });
    expect(used.ok).toBe(true);
    const reused = await consumeChannelSigninToken(gmailToken ?? '', db.database, { now: NOW });
    expect(reused.ok).toBe(false);
    const expired = await consumeChannelSigninToken(calendarToken ?? '', db.database, {
      now: new Date(NOW.getTime() + CHANNEL_SIGNIN_TTL_MS),
    });
    expect(expired.ok).toBe(false);
    const after = await db.database
      .select({ consumedAt: schema.channelSigninTokens.consumedAt })
      .from(schema.channelSigninTokens);
    expect(after.filter((row) => row.consumedAt === null)).toHaveLength(1);
    expect(after.filter((row) => row.consumedAt !== null)).toHaveLength(1);
    const mints = await db.database
      .select({ actor: schema.auditLog.actor, after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'connector_link_minted'));
    expect(mints).toHaveLength(2);
    expect(mints.every((row) => row.actor === coparent?.userId)).toBe(true);
    const [done] = await db.database
      .select({ step: schema.linqGroupOnboarding.step })
      .from(schema.linqGroupOnboarding);
    expect(done?.step).toBe('done');
    expect(await childNames()).toEqual(['Maya']);
    expectLinqGroupOnly(wire);
  });

  it('points an unclaimed group and a 1:1 at the locked instruction and does not open a family', async () => {
    const seeded = await seedHousehold();
    await noteCoparent(seeded);
    const wire = linqFetch();
    const expected = linqGroupMakeInstruction(formatLinqLineForParent(FROM), 'en');
    const unclaimed = await considerGroupCoparent(
      db.database,
      inbound({ messageId: 'm-unclaimed', senderHandle: COPARENT_PHONE, text: 'hello' }),
      { now: NOW, fetch: wire.fetch, recordInbound },
    );
    expect(unclaimed).toMatchObject({ type: 'done', outcome: 'group_coparent_unclaimed' });
    expect(wire.texts()).toEqual([expected]);
    expect(await familyCount()).toBe(1);

    const steered = await steerNotedCoparentOneToOne(
      db.database,
      inbound({
        messageId: 'm-1to1',
        chatId: ONE_TO_ONE,
        senderHandle: COPARENT_PHONE,
        text: 'hello',
      }),
      { now: NOW, fetch: wire.fetch, recordInbound },
    );
    expect(steered).toMatchObject({ type: 'done', outcome: 'group_coparent_steered' });
    expect(wire.texts().at(-1)).toBe(expected);
    const users = await db.database.select({ id: schema.users.id }).from(schema.users);
    expect(users).toHaveLength(1);
    expect(await childNames()).toEqual(['Maya']);
  });

  it('seats a real phone in a claimed group with no live note, and not another family', async () => {
    const seeded = await seedHousehold();
    await noteCoparent(seeded, new Date(NOW.getTime() - 1000));
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: GROUP })
      .where(eq(schema.families.id, seeded.familyId));
    const wire = linqFetch();
    const expired = await considerGroupCoparent(
      db.database,
      inbound({ messageId: 'm-expired', senderHandle: COPARENT_PHONE, text: 'hi' }),
      { now: NOW, fetch: wire.fetch, recordInbound },
    );
    expect(expired).toMatchObject({ type: 'done', outcome: 'group_coparent_seated' });
    expect(wire.groupTexts()).toEqual([GROUP_WELCOME.en]);
    const [invite] = await db.database
      .select({ state: schema.caregiverInvites.state })
      .from(schema.caregiverInvites);
    expect(invite?.state).toBe('identity_noted');

    await db.exec('truncate table families, users cascade');
    const home = await seedHousehold();
    await noteCoparent(home);
    const [other] = await db.database
      .insert(schema.families)
      .values({ displayName: 'Other', linqGroupChatId: 'chat-other' })
      .returning({ id: schema.families.id });
    const leaked = await considerGroupCoparent(
      db.database,
      inbound({
        messageId: 'm-other',
        chatId: 'chat-other',
        senderHandle: COPARENT_PHONE,
        text: 'hi',
      }),
      { now: NOW, fetch: linqFetch().fetch, recordInbound },
    );
    expect(leaked).toEqual({ type: 'none' });
    const members = await db.database
      .select({ familyId: schema.familyMembers.familyId, role: schema.familyMembers.role })
      .from(schema.familyMembers);
    expect(members.some((row) => row.familyId === other?.id)).toBe(false);
    expect(members.some((row) => row.role === 'co_parent')).toBe(false);
  });

  it('sends the gmail group receipt on its own and names no mailbox content', async () => {
    const seeded = await seedHousehold();
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: GROUP })
      .where(eq(schema.families.id, seeded.familyId));
    const [coparent] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: `imessage:sam-${seeded.familyId}`, name: 'Sam' })
      .returning({ id: schema.users.id });
    const coparentId = coparent?.id as string;
    await db.database.insert(schema.familyMembers).values({
      familyId: seeded.familyId,
      userId: coparentId,
      role: 'co_parent',
    });
    await db.database.insert(schema.parentChannels).values({
      userId: coparentId,
      familyId: seeded.familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(COPARENT_PHONE),
      phoneE164Hash: phoneBlindIndex(COPARENT_PHONE),
      verifiedAt: NOW,
    });
    await db.database.insert(schema.linqGroupOnboarding).values({
      familyId: seeded.familyId,
      userId: coparentId,
      providerChatId: GROUP,
      step: 'awaiting_gmail',
    });
    const wire = linqFetch();
    const primary = await sendCoparentGroupCalendarReceipt(db.database, {
      familyId: seeded.familyId,
      userId: seeded.parentUserId,
      provider: 'gmail',
      connectId: 'connect-primary',
      now: NOW,
      fetch: wire.fetch,
    });
    expect(primary).toBe('skipped');
    expect(wire.texts()).toEqual([]);

    const calendar = await sendCoparentGroupCalendarReceipt(db.database, {
      familyId: seeded.familyId,
      userId: coparentId,
      provider: 'gcal',
      connectId: 'connect-cal',
      now: NOW,
      fetch: wire.fetch,
    });
    expect(calendar).toBe('sent');
    expect(wire.groupTexts()[0]).toBe(groupCalendarReceipt('en', 'Sam'));
    expect(wire.groupTexts()[1]?.startsWith(groupGmailAsk('en', 'Sam'))).toBe(true);
    expect(wire.groupTexts()[1]).toContain('to=gmail');
    expect(wire.groupLinks()).toEqual([]);
    expect(wire.groupTexts()[0]).not.toContain('Gmail link');
    expect(wire.groupTexts()[1]).not.toContain('calendar is connected');
    expect(groupGmailAsk('en', 'Sam')).not.toContain('/connect?t=');
    expect(wire.createdChats()).toBe(0);
    expect(wire.privateTexts()).toEqual([]);
    const [asked] = await db.database
      .select({ step: schema.linqGroupOnboarding.step })
      .from(schema.linqGroupOnboarding);
    expect(asked?.step).toBe('done');

    const again = await sendCoparentGroupCalendarReceipt(db.database, {
      familyId: seeded.familyId,
      userId: coparentId,
      provider: 'gcal',
      connectId: 'connect-cal-again',
      now: NOW,
      fetch: wire.fetch,
    });
    expect(again).toBe('sent');
    expect(
      wire.groupTexts().filter((text) => text.startsWith(groupGmailAsk('en', 'Sam'))),
    ).toHaveLength(1);

    const sent = await sendCoparentGroupCalendarReceipt(db.database, {
      familyId: seeded.familyId,
      userId: coparentId,
      provider: 'gmail',
      connectId: 'connect-sam',
      now: NOW,
      fetch: wire.fetch,
    });
    expect(sent).toBe('sent');
    expect(wire.groupTexts().at(-1)).toBe(groupGmailReceipt('en', 'Sam'));
    expect(wire.groupTexts().at(-1)).not.toContain('want me to catch');
    expect(
      wire.groupTexts().filter((text) => text.startsWith(groupGmailAsk('en', 'Sam'))),
    ).toHaveLength(1);
    expect(wire.groupTexts().at(-1)).not.toMatch(/@|subject:|snippet/);
    const [step] = await db.database
      .select({ step: schema.linqGroupOnboarding.step })
      .from(schema.linqGroupOnboarding);
    expect(step?.step).toBe('done');
    expectLinqGroupOnly(wire);
  });

  it('does not fall back to Twilio when a group receipt or connect card is refused', async () => {
    const seeded = await seedHousehold();
    await noteCoparent(seeded);
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: GROUP })
      .where(eq(schema.families.id, seeded.familyId));
    const open = linqFetch();
    await considerGroupCoparent(
      db.database,
      inbound({ messageId: 'm-seat', senderHandle: COPARENT_PHONE, text: 'hi there' }),
      { now: NOW, fetch: open.fetch, recordInbound },
    );
    await considerGroupCoparent(
      db.database,
      inbound({ messageId: 'm-name', senderHandle: COPARENT_PHONE, text: 'Sam' }),
      { now: NOW, fetch: open.fetch, recordInbound },
    );
    const refused = linqFetch({ failMessages: true });
    const card = await considerGroupCoparent(
      db.database,
      inbound({ messageId: 'm-cal', senderHandle: COPARENT_PHONE, text: 'ready' }),
      { now: NOW, fetch: refused.fetch, recordInbound },
    );
    expect(card).toMatchObject({ type: 'done', outcome: 'group_coparent_link_held' });
    expect(refused.urls().length).toBeGreaterThan(0);
    expect(refused.urls().every((url) => url === GROUP_MESSAGES)).toBe(true);
    expect(refused.twilioUrls()).toEqual([]);
    expect(refused.privateTexts()).toEqual([]);

    const [coparent] = await db.database
      .select({ userId: schema.familyMembers.userId })
      .from(schema.familyMembers)
      .where(eq(schema.familyMembers.role, 'co_parent'));
    const receiptWire = linqFetch({ failMessages: true });
    const receipt = await sendCoparentGroupCalendarReceipt(db.database, {
      familyId: seeded.familyId,
      userId: coparent?.userId as string,
      provider: 'gcal',
      connectId: 'connect-refused',
      now: NOW,
      fetch: receiptWire.fetch,
    });
    expect(receipt).toBe('skipped');
    expect(receiptWire.urls()).toEqual([GROUP_MESSAGES]);
    expect(receiptWire.twilioUrls()).toEqual([]);

    const rows = await db.database
      .select({
        channel: schema.channelMessages.channel,
        providerChatId: schema.channelMessages.providerChatId,
      })
      .from(schema.channelMessages);
    expect(rows.every((row) => row.channel === 'imessage')).toBe(true);
    expect(rows.every((row) => row.providerChatId === GROUP)).toBe(true);
    expect(rows.some((row) => row.channel === 'sms')).toBe(false);
  });

  it('keeps a later calendar connect as a link card in the group', async () => {
    const seeded = await seedHousehold();
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: GROUP })
      .where(eq(schema.families.id, seeded.familyId));
    await db.database.insert(schema.linqGroupOnboarding).values({
      familyId: seeded.familyId,
      userId: seeded.parentUserId,
      providerChatId: GROUP,
      step: 'done',
    });
    const wire = linqFetch();
    const asked = await considerGroupCoparent(
      db.database,
      inbound({
        messageId: 'm-connect-cal',
        senderHandle: PARENT_PHONE,
        text: 'connect my calendar',
      }),
      { now: NOW, fetch: wire.fetch, recordInbound },
    );
    expect(asked).toMatchObject({ type: 'done', outcome: 'group_coparent_gcal' });
    expect(wire.groupTexts()).toEqual([]);
    expect(wire.groupLinks()).toHaveLength(1);
    expect(wire.groupLinks()[0]).toContain('https://');
    expect(wire.groupLinks()[0]).toContain('to=gcal');
    expect(wire.privateTexts()).toEqual([]);
    expect(wire.twilioUrls()).toEqual([]);
    expectLinqGroupOnly(wire);
  });

  it('adds a both-free poll only when LINQ_POLLS is on, and keeps the locked sentence', async () => {
    const seeded = await seedHousehold();
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: GROUP })
      .where(eq(schema.families.id, seeded.familyId));
    await db.database.insert(schema.linqGroupOnboarding).values({
      familyId: seeded.familyId,
      userId: seeded.parentUserId,
      providerChatId: GROUP,
      step: 'done',
    });

    const off = pollAwareFetch();
    const textOnly = await considerGroupCoparent(
      db.database,
      inbound({
        messageId: 'm-both-off',
        senderHandle: PARENT_PHONE,
        text: 'when are we both free',
      }),
      { now: NOW, fetch: off.fetch, recordInbound },
    );
    expect(textOnly).toMatchObject({ type: 'done', outcome: 'group_coparent_both_free' });
    expect(off.texts()).toHaveLength(1);
    expect(off.texts()[0]).toMatch(/^You're both free .+ or .+\. Want the sign-up page for one\?$/);
    expect(off.texts()[0]).not.toBe(LINQ_POLL_PLACEHOLDER_PROMPT);
    expect(off.pollOptions()).toEqual([]);
    expect(off.urls().some((url) => url.includes('/polls'))).toBe(false);
    expect(off.urls().every((url) => url === GROUP_MESSAGES)).toBe(true);

    await db.exec('delete from channel_messages');
    vi.stubEnv('LINQ_POLLS', 'on');
    const on = pollAwareFetch();
    const polled = await considerGroupCoparent(
      db.database,
      inbound({
        messageId: 'm-both-on',
        senderHandle: PARENT_PHONE,
        text: 'when are we both free',
      }),
      { now: NOW, fetch: on.fetch, recordInbound },
    );
    expect(polled).toMatchObject({ type: 'done', outcome: 'group_coparent_both_free' });
    expect(on.texts()[0]).toMatch(/^You're both free .+ or .+\. Want the sign-up page for one\?$/);
    expect(on.texts()[1]).toBe(LINQ_POLL_PLACEHOLDER_PROMPT);
    expect(on.pollOptions()).toHaveLength(2);
    for (const option of on.pollOptions()) {
      expect(on.texts()[0]).toContain(option);
    }
    expect(
      on.urls().some((url) => url === `${GROUP_MESSAGES.replace('/messages', '/polls')}`),
    ).toBe(true);
    expect(on.urls().every((url) => url.includes(GROUP))).toBe(true);

    const again = await considerGroupCoparent(
      db.database,
      inbound({
        messageId: 'm-both-again',
        senderHandle: PARENT_PHONE,
        text: 'when are we both free',
      }),
      { now: NOW, fetch: on.fetch, recordInbound },
    );
    expect(again).toMatchObject({ type: 'done', outcome: 'group_coparent_both_free' });
    expect(on.pollOptions()).toHaveLength(2);
  });
});

function pollAwareFetch(): {
  fetch: typeof fetch;
  texts: () => string[];
  pollOptions: () => string[];
  urls: () => string[];
} {
  const texts: string[] = [];
  const pollOptions: string[] = [];
  const urls: string[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(String(url));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const message = body?.message as { parts?: { type?: string; value?: string }[] } | undefined;
    for (const part of message?.parts ?? []) {
      if (part.type === 'text' && part.value) texts.push(part.value);
    }
    const poll = body?.poll as { options?: { text?: string }[] } | undefined;
    const options = poll?.options ?? [];
    if (options.length > 0) {
      for (const option of options) {
        if (option.text) pollOptions.push(option.text);
      }
      return new Response(
        JSON.stringify({
          message_id: 'poll-1',
          poll: {
            options: options.map((option, index) => ({
              option_id: `opt-${index}`,
              text: option.text,
            })),
          },
        }),
        { status: 202 },
      );
    }
    return new Response(JSON.stringify({ message: { id: `m-${texts.length}` } }), { status: 201 });
  });
  return {
    fetch: fetchImpl as unknown as typeof fetch,
    texts: () => texts,
    pollOptions: () => pollOptions,
    urls: () => urls,
  };
}
