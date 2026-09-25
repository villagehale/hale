import { schema } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeFakeDb } from '~/lib/channel/intake/fakes';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import {
  HALE_CONTACT_FIRST_NAME,
  HALE_CONTACT_IMAGE_URL_DEFAULT,
  linqContactCardMoment,
  shareHaleContactCardOnce,
} from './contact-card';
import {
  LINQ_GROUP_OPEN_TEXT,
  LINQ_GROUP_UNREACHABLE_TEXT,
  mapGroupHandlesToFamily,
  openHouseholdLinqGroup,
} from './group';
import { linkPreviewUrl, sendLinqLinkPreview } from './link-preview';
import { LINQ_POLL_PLACEHOLDER_PROMPT, binaryChoiceFromReply, offerLinqChoicePoll } from './poll';
import { applyLinqTapback, decideLinqTapback } from './tapback';

const ENC_KEY = Buffer.alloc(32, 7).toString('base64');
const NOW = new Date('2026-09-24T12:00:00.000Z');
const FAMILY = '00000000-0000-4000-8000-0000000000f1';
const USER = '00000000-0000-4000-8000-0000000000u1';
const USER_B = '00000000-0000-4000-8000-0000000000u2';
const FAMILY_B = '00000000-0000-4000-8000-0000000000f2';
const PARENT = '+14165550101';
const COPARENT = '+14165550102';
const CHAT = '8f392755-6865-4b18-880a-227f9d8b458f';

function enrol(
  fake: ReturnType<typeof makeFakeDb>,
  phone: string,
  ids: { familyId: string; userId: string },
): void {
  fake.db.insert(schema.parentChannels).values({
    userId: ids.userId,
    familyId: ids.familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: NOW,
  } as never);
}

afterEach(() => {
  process.env.APP_ENCRYPTION_KEY = '';
  vi.unstubAllEnvs();
});

describe('Linq contact card', () => {
  it('is not a moment mid-intake, in a group, or off iMessage', () => {
    expect(
      linqContactCardMoment({
        channel: 'imessage',
        chatId: CHAT,
        isGroup: false,
        onboardComplete: false,
      }),
    ).toBe(false);
    expect(
      linqContactCardMoment({
        channel: 'imessage',
        chatId: CHAT,
        isGroup: true,
        onboardComplete: true,
      }),
    ).toBe(false);
    expect(
      linqContactCardMoment({
        channel: 'sms',
        chatId: null,
        isGroup: false,
        onboardComplete: true,
      }),
    ).toBe(false);
  });

  it('shares Hale and the turtle once, and a second call does not fetch', async () => {
    process.env.APP_ENCRYPTION_KEY = ENC_KEY;
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_FROM_E164', '+15555550100');
    const fake = makeFakeDb();
    enrol(fake, PARENT, { familyId: FAMILY, userId: USER });
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/contact_card?') || init?.method === 'GET') {
        return Response.json({
          contact_cards: [{ phone_number: '+15555550100', first_name: 'Hale', is_active: true }],
        });
      }
      if (target.endsWith('/contact_card')) {
        return Response.json({ is_active: true, phone_number: '+15555550100' }, { status: 201 });
      }
      return new Response(null, { status: 200 });
    });

    const first = await shareHaleContactCardOnce(fake.db, {
      familyId: FAMILY,
      parentUserId: USER,
      chatId: CHAT,
      channel: 'imessage',
      isGroup: false,
      onboardComplete: true,
      now: NOW,
      fetch: fetchMock,
    });
    const second = await shareHaleContactCardOnce(fake.db, {
      familyId: FAMILY,
      parentUserId: USER,
      chatId: CHAT,
      channel: 'imessage',
      isGroup: false,
      onboardComplete: true,
      now: NOW,
      fetch: fetchMock,
    });

    expect(first).toEqual({ status: 'shared' });
    expect(second).toEqual({ status: 'not_sent', reason: 'already_shared' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const card = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(card.first_name).toBe(HALE_CONTACT_FIRST_NAME);
    expect(card.image_url).toBe(HALE_CONTACT_IMAGE_URL_DEFAULT);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      `https://api.linqapp.com/api/partner/v3/chats/${CHAT}/share_contact_card`,
    );
    const shared = fake
      .rows(schema.auditLog)
      .find((row) => row.actionTaken === 'linq_contact_card_shared');
    expect(shared?.after).toMatchObject({ outcome: 'shared' });
  });

  it('releases the one-shot claim when the partner key is missing', async () => {
    process.env.APP_ENCRYPTION_KEY = ENC_KEY;
    vi.stubEnv('LINQ_API_KEY', '');
    vi.stubEnv('LINQ_FROM_E164', '+15555550100');
    const fake = makeFakeDb();
    enrol(fake, PARENT, { familyId: FAMILY, userId: USER });
    const outcome = await shareHaleContactCardOnce(fake.db, {
      familyId: FAMILY,
      parentUserId: USER,
      chatId: CHAT,
      channel: 'imessage',
      isGroup: false,
      onboardComplete: true,
      now: NOW,
      fetch: vi.fn(),
    });
    expect(outcome).toEqual({ status: 'not_sent', reason: 'not_configured' });
    const row = fake.rows(schema.parentChannels)[0];
    expect(row?.linqContactCardSharedAt).toBeNull();
  });

  it('releases the claim when setup is refused, so a later success can share', async () => {
    process.env.APP_ENCRYPTION_KEY = ENC_KEY;
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_FROM_E164', '+15555550100');
    const fake = makeFakeDb();
    enrol(fake, PARENT, { familyId: FAMILY, userId: USER });
    let setups = 0;
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/contact_card?') || init?.method === 'GET') {
        return Response.json({
          contact_cards: [{ phone_number: '+15555550100', first_name: 'Hale', is_active: true }],
        });
      }
      if (target.endsWith('/contact_card')) {
        setups += 1;
        if (setups === 1) {
          return Response.json({ error: { code: 'image_unreachable' } }, { status: 400 });
        }
        return Response.json({ is_active: true, phone_number: '+15555550100' }, { status: 201 });
      }
      return new Response(null, { status: 200 });
    });
    const args = {
      familyId: FAMILY,
      parentUserId: USER,
      chatId: CHAT,
      channel: 'imessage',
      isGroup: false,
      onboardComplete: true,
      now: NOW,
      fetch: fetchMock,
    };

    const refused = await shareHaleContactCardOnce(fake.db, args);
    expect(refused).toEqual({
      status: 'not_sent',
      reason: 'card_refused',
      code: 'image_unreachable',
      httpStatus: 400,
    });
    expect(fake.rows(schema.parentChannels)[0]?.linqContactCardSharedAt).toBeNull();

    const shared = await shareHaleContactCardOnce(fake.db, args);
    expect(shared).toEqual({ status: 'shared' });
    expect(fake.rows(schema.parentChannels)[0]?.linqContactCardSharedAt).toEqual(NOW);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('keeps the one-shot when the share itself is refused', async () => {
    process.env.APP_ENCRYPTION_KEY = ENC_KEY;
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_FROM_E164', '+15555550100');
    const fake = makeFakeDb();
    enrol(fake, PARENT, { familyId: FAMILY, userId: USER });
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/contact_card?') || init?.method === 'GET') {
        return Response.json({
          contact_cards: [{ phone_number: '+15555550100', first_name: 'Hale', is_active: true }],
        });
      }
      if (target.endsWith('/contact_card')) {
        return Response.json({ is_active: true, phone_number: '+15555550100' }, { status: 201 });
      }
      return Response.json({ error: { code: 'share_rejected' } }, { status: 400 });
    });
    const args = {
      familyId: FAMILY,
      parentUserId: USER,
      chatId: CHAT,
      channel: 'imessage',
      isGroup: false,
      onboardComplete: true,
      now: NOW,
      fetch: fetchMock,
    };

    const refused = await shareHaleContactCardOnce(fake.db, args);
    expect(refused).toEqual({
      status: 'not_sent',
      reason: 'share_refused',
      code: 'share_rejected',
      httpStatus: 400,
    });
    expect(fake.rows(schema.parentChannels)[0]?.linqContactCardSharedAt).toEqual(NOW);

    const second = await shareHaleContactCardOnce(fake.db, args);
    expect(second).toEqual({ status: 'not_sent', reason: 'already_shared' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      fake
        .rows(schema.auditLog)
        .some(
          (row) =>
            row.actionTaken === 'linq_contact_card_shared' &&
            (row.after as { outcome?: string } | null)?.outcome === 'shared',
        ),
    ).toBe(false);
  });

  it('does not audit shared when the line card is not active', async () => {
    process.env.APP_ENCRYPTION_KEY = ENC_KEY;
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_FROM_E164', '+15555550100');
    const fake = makeFakeDb();
    enrol(fake, PARENT, { familyId: FAMILY, userId: USER });
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/contact_card?') || init?.method === 'GET') {
        return Response.json({
          contact_cards: [{ phone_number: '+15555550100', first_name: 'Hale', is_active: false }],
        });
      }
      if (target.endsWith('/contact_card')) {
        return Response.json({ is_active: true, phone_number: '+15555550100' }, { status: 201 });
      }
      return new Response(null, { status: 200 });
    });
    const outcome = await shareHaleContactCardOnce(fake.db, {
      familyId: FAMILY,
      parentUserId: USER,
      chatId: CHAT,
      channel: 'imessage',
      isGroup: false,
      onboardComplete: true,
      now: NOW,
      fetch: fetchMock,
    });
    expect(outcome).toMatchObject({
      status: 'not_sent',
      reason: 'card_refused',
      code: 'card_inactive',
    });
    expect(
      fetchMock.mock.calls.some((call) => String(call[0]).includes('share_contact_card')),
    ).toBe(false);
    expect(fake.rows(schema.parentChannels)[0]?.linqContactCardSharedAt).toBeNull();
    const audit = fake
      .rows(schema.auditLog)
      .find((row) => row.actionTaken === 'linq_contact_card_shared');
    expect(audit?.after).toMatchObject({ outcome: 'card_inactive' });
    expect((audit?.after as { outcome?: string } | null)?.outcome).not.toBe('shared');
  });
});

describe('Linq tapbacks', () => {
  it('replaces only a throwaway courtesy, and a refusal does not throw', async () => {
    expect(
      decideLinqTapback({
        channel: 'sms',
        chatId: CHAT,
        inboundMessageId: 'in-1',
        inboundBody: 'thanks',
        outboundBody: 'ok',
      }),
    ).toBeNull();
    expect(
      decideLinqTapback({
        channel: 'imessage',
        chatId: CHAT,
        inboundMessageId: 'in-1',
        inboundBody: 'thanks',
        outboundBody: 'Maya is 4 and swim is Thursday',
      }),
    ).toBeNull();
    expect(
      decideLinqTapback({
        channel: 'imessage',
        chatId: CHAT,
        inboundMessageId: 'in-1',
        inboundBody: 'thanks',
        outboundBody: 'ok',
      }),
    ).toEqual({ type: 'like' });
    expect(
      decideLinqTapback({
        channel: 'imessage',
        chatId: CHAT,
        inboundMessageId: 'in-1',
        inboundBody: 'ok',
        outboundBody: 'got it',
      }),
    ).toEqual({ type: 'emphasize' });

    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const refused = vi.fn(async () => Response.json({ error: { code: 2001 } }, { status: 400 }));
    const applied = await applyLinqTapback({
      channel: 'imessage',
      chatId: CHAT,
      inboundMessageId: 'in-1',
      inboundBody: 'thanks',
      outboundBody: 'ok',
      fetch: refused,
    });
    expect(applied.status).toBe('not_replaced');
  });
});

describe('Linq link previews', () => {
  it('sends a lone link part and skips policy pages', async () => {
    expect(linkPreviewUrl('Calendar: https://app.villagehale.com/connect/abc.')).toBe(
      'https://app.villagehale.com/connect/abc',
    );
    expect(linkPreviewUrl('See https://app.villagehale.com/privacy')).toBeNull();

    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ message: { id: 'link-1' } }, { status: 201 }),
    );
    const sent = await sendLinqLinkPreview({
      channel: 'imessage',
      chatId: CHAT,
      url: 'https://app.villagehale.com/connect/abc',
      fetch: fetchMock,
    });
    expect(sent).toEqual({ status: 'sent', providerMessageId: 'link-1' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      message: { parts: [{ type: 'link', value: 'https://app.villagehale.com/connect/abc' }] },
    });
    const sms = await sendLinqLinkPreview({
      channel: 'sms',
      chatId: null,
      url: 'https://app.villagehale.com/connect/abc',
      fetch: fetchMock,
    });
    expect(sms).toEqual({ status: 'not_sent', reason: 'not_imessage' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('Linq household group', () => {
  it('maps known handles onto one family and refuses a mixed chat', async () => {
    process.env.APP_ENCRYPTION_KEY = ENC_KEY;
    const fake = makeFakeDb();
    enrol(fake, PARENT, { familyId: FAMILY, userId: USER });
    enrol(fake, COPARENT, { familyId: FAMILY, userId: USER_B });
    enrol(fake, '+14165550103', {
      familyId: FAMILY_B,
      userId: '00000000-0000-4000-8000-0000000000u3',
    });

    await expect(
      mapGroupHandlesToFamily(fake.db, { sender: PARENT, others: [COPARENT] }),
    ).resolves.toEqual({ status: 'same_family', familyId: FAMILY, userId: USER });
    await expect(
      mapGroupHandlesToFamily(fake.db, { sender: '+14165550999', others: [] }),
    ).resolves.toEqual({ status: 'unknown_sender' });
    await expect(
      mapGroupHandlesToFamily(fake.db, { sender: PARENT, others: ['+14165550103'] }),
    ).resolves.toEqual({ status: 'mixed_family' });
  });

  it('creates the group from the co-parent invite, and names a sandbox refusal', async () => {
    process.env.APP_ENCRYPTION_KEY = ENC_KEY;
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_FROM_E164', '+15555550100');
    const fake = makeFakeDb();
    enrol(fake, PARENT, { familyId: FAMILY, userId: USER });
    await fake.db.insert(schema.families).values({ id: FAMILY, displayName: 'Fixture' } as never);
    await fake.db.insert(schema.channelMessages).values({
      familyId: FAMILY,
      parentUserId: USER,
      channel: 'imessage',
      direction: 'in',
      category: 'reply',
      providerChatId: CHAT,
      providerMessageId: 'in-1',
    } as never);

    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith('/chats') && init?.method === 'POST') {
        return Response.json(
          { chat: { id: 'group-1', message: { id: 'open-1' } } },
          { status: 201 },
        );
      }
      return Response.json({}, { status: 200 });
    });
    const opened = await openHouseholdLinqGroup(fake.db, {
      familyId: FAMILY,
      parentUserId: USER,
      parentPhoneE164: PARENT,
      coParentPhoneE164: COPARENT,
      now: NOW,
      fetch: fetchMock,
    });
    expect(opened).toEqual({ status: 'opened', chatId: 'group-1' });
    const created = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(created.from).toBe('+15555550100');
    expect(created.to).toEqual([PARENT, COPARENT]);
    expect(created.message.parts[0].value).toBe(LINQ_GROUP_OPEN_TEXT);
    expect(created.message.parts[0].value).not.toMatch(/https?:\/\//);
    expect(fake.rows(schema.families).find((row) => row.id === FAMILY)?.linqGroupChatId).toBe(
      'group-1',
    );

    const refused = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ error: { code: 1002 } }, { status: 400 }),
    );
    const again = await openHouseholdLinqGroup(fake.db, {
      familyId: FAMILY,
      parentUserId: USER,
      parentPhoneE164: PARENT,
      coParentPhoneE164: '+14165550109',
      now: NOW,
      fetch: refused,
    });
    expect(again.status).toBe('degraded');
    const degrade = JSON.parse(String(refused.mock.calls.at(-1)?.[1]?.body));
    expect(degrade.message.parts[0].value).toBe(LINQ_GROUP_UNREACHABLE_TEXT);
  });
});

describe('Linq polls', () => {
  it('stays off unless the flag is on, and then replaces only an unlocked binary sentence', async () => {
    process.env.APP_ENCRYPTION_KEY = ENC_KEY;
    vi.stubEnv('LINQ_POLLS', '');
    const fake = makeFakeDb();
    const fetchMock = vi.fn();
    const off = await offerLinqChoicePoll(fake.db, {
      channel: 'imessage',
      chatId: CHAT,
      body: 'Soccer or swim?',
      templateKey: null,
      familyId: FAMILY,
      parentUserId: USER,
      now: NOW,
      fetch: fetchMock,
    });
    expect(off).toEqual({ status: 'skipped', reason: 'flag_off' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(binaryChoiceFromReply('Soccer or swim?', 'intake:coparent')).toBeNull();

    vi.stubEnv('LINQ_POLLS', 'on');
    const sending = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { poll?: unknown };
      if (body.poll) {
        return Response.json(
          {
            message_id: 'poll-1',
            poll: {
              options: [
                { option_id: 'o1', text: 'Soccer' },
                { option_id: 'o2', text: 'swim' },
              ],
            },
          },
          { status: 202 },
        );
      }
      return Response.json({ message: { id: 'q-1' } }, { status: 201 });
    });
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const sent = await offerLinqChoicePoll(fake.db, {
      channel: 'imessage',
      chatId: CHAT,
      body: 'Soccer or swim?',
      templateKey: null,
      familyId: FAMILY,
      parentUserId: USER,
      now: NOW,
      fetch: sending,
    });
    expect(sent.status).toBe('sent');
    const question = JSON.parse(String(sending.mock.calls[0]?.[1]?.body));
    expect(question.message.parts[0].value).toBe(LINQ_POLL_PLACEHOLDER_PROMPT);
    expect(fake.rows(schema.linqPollOptions)).toHaveLength(2);
  });
});
