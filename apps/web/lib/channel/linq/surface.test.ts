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
import { considerLinqReply } from './moments';
import {
  SANDBOX_YEAR_FIND_TITLES,
  YEAR_FIND_POLL_NONE,
  YEAR_FIND_POLL_PROMPT,
  offerSandboxYearFindPoll,
  offerYearFindPoll,
  sandboxYearFindPollOptions,
  yearFindPollOptions,
} from './poll';
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
  it('is a 1:1 iMessage moment before onboard finishes, and never a group or SMS', () => {
    expect(
      linqContactCardMoment({
        channel: 'imessage',
        chatId: CHAT,
        isGroup: false,
        onboardComplete: false,
      }),
    ).toBe(true);
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
    expect(
      linqContactCardMoment({
        channel: 'imessage',
        chatId: '',
        isGroup: false,
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

  it('shares when onboard is not finished, once a 1:1 channel row exists', async () => {
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

    const outcome = await shareHaleContactCardOnce(fake.db, {
      familyId: FAMILY,
      parentUserId: USER,
      chatId: CHAT,
      channel: 'imessage',
      isGroup: false,
      onboardComplete: false,
      now: NOW,
      fetch: fetchMock,
    });

    expect(outcome).toEqual({ status: 'shared' });
    expect(fake.rows(schema.parentChannels)[0]?.linqContactCardSharedAt).toEqual(NOW);
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

function pollFetch() {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      poll?: { options?: { text: string }[] };
    };
    if (body.poll?.options) {
      return Response.json(
        {
          message_id: 'poll-year',
          poll: {
            options: body.poll.options.map((option, index) => ({
              option_id: `slot-${index}`,
              text: option.text,
            })),
          },
        },
        { status: 202 },
      );
    }
    return Response.json({ message: { id: 'q-year' } }, { status: 201 });
  });
}

describe('Linq polls', () => {
  it('does not turn a two-option sentence into a poll', async () => {
    process.env.APP_ENCRYPTION_KEY = ENC_KEY;
    vi.stubEnv('LINQ_POLLS', 'on');
    const fake = makeFakeDb();
    const fellThrough = await considerLinqReply(fake.db, {
      route: {
        channel: 'imessage',
        to: PARENT,
        chatId: CHAT,
        replyToMessageId: 'in-1',
      },
      inboundBody: 'when are we both free',
      outboundBody: 'Soccer or swim?',
      templateKey: null,
      familyId: FAMILY,
      parentUserId: USER,
      now: NOW,
      fetch: vi.fn(),
    });
    expect(fellThrough).toEqual({ handled: false });
  });

  it('asks which find to look at first only when there are two titles and the flag is on', async () => {
    process.env.APP_ENCRYPTION_KEY = ENC_KEY;
    vi.stubEnv('LINQ_POLLS', '');
    const fake = makeFakeDb();
    const quiet = vi.fn();
    const off = await offerYearFindPoll(fake.db, {
      channel: 'imessage',
      chatId: CHAT,
      titles: ['Parent and tot swim', 'Story time'],
      language: 'en',
      familyId: FAMILY,
      parentUserId: USER,
      now: NOW,
      fetch: quiet,
    });
    expect(off).toEqual({ status: 'skipped', reason: 'flag_off' });
    expect(quiet).not.toHaveBeenCalled();
    expect(yearFindPollOptions('en', ['Only one'])).toBeNull();
    expect(yearFindPollOptions('en', [])).toBeNull();
    expect(yearFindPollOptions('fr', ['Nage', 'Conte', 'Zoo', 'Fourth'])).toEqual([
      'Nage',
      'Conte',
      'Zoo',
      YEAR_FIND_POLL_NONE.fr,
    ]);

    vi.stubEnv('LINQ_POLLS', 'on');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const sending = pollFetch();
    const sent = await offerYearFindPoll(fake.db, {
      channel: 'imessage',
      chatId: CHAT,
      titles: ['Parent and tot swim', 'Story time', 'U12 soccer tryouts', 'Fourth'],
      language: 'en',
      familyId: FAMILY,
      parentUserId: USER,
      now: NOW,
      fetch: sending,
    });
    expect(sent.status).toBe('sent');
    const question = JSON.parse(String(sending.mock.calls[0]?.[1]?.body));
    expect(question.message.parts[0].value).toBe(YEAR_FIND_POLL_PROMPT.en);
    const poll = JSON.parse(String(sending.mock.calls[1]?.[1]?.body));
    expect(poll.poll.options.map((option: { text: string }) => option.text)).toEqual([
      'Parent and tot swim',
      'Story time',
      'U12 soccer tryouts',
      YEAR_FIND_POLL_NONE.en,
    ]);
    expect(String(sending.mock.calls[1]?.[0])).toContain(`/chats/${CHAT}/polls`);
    expect(fake.rows(schema.linqPollOptions)).toHaveLength(4);

    const french = pollFetch();
    const sentFr = await offerYearFindPoll(fake.db, {
      channel: 'imessage',
      chatId: CHAT,
      titles: ['Nage', 'Conte'],
      language: 'fr',
      familyId: FAMILY,
      parentUserId: USER,
      now: NOW,
      fetch: french,
    });
    expect(sentFr.status).toBe('sent');
    const questionFr = JSON.parse(String(french.mock.calls[0]?.[1]?.body));
    expect(questionFr.message.parts[0].value).toBe(YEAR_FIND_POLL_PROMPT.fr);
    const pollFr = JSON.parse(String(french.mock.calls[1]?.[1]?.body));
    expect(pollFr.poll.options.map((option: { text: string }) => option.text)).toEqual([
      'Nage',
      'Conte',
      YEAR_FIND_POLL_NONE.fr,
    ]);
  });

  it('sends the sandbox scenario verbatim and does not invent a title', async () => {
    process.env.APP_ENCRYPTION_KEY = ENC_KEY;
    vi.stubEnv('LINQ_POLLS', 'on');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    expect(sandboxYearFindPollOptions('en')).toEqual([
      ...SANDBOX_YEAR_FIND_TITLES.en,
      YEAR_FIND_POLL_NONE.en,
    ]);
    expect(sandboxYearFindPollOptions('fr')).toEqual([
      'Nage au centre recreatif',
      'Heure du conte a la bibliotheque',
      'Aucun de ceux-la',
    ]);
    const fake = makeFakeDb();
    const sending = pollFetch();
    const sent = await offerSandboxYearFindPoll(fake.db, {
      channel: 'imessage',
      chatId: CHAT,
      language: 'en',
      familyId: FAMILY,
      parentUserId: USER,
      now: NOW,
      fetch: sending,
    });
    expect(sent.status).toBe('sent');
    const question = JSON.parse(String(sending.mock.calls[0]?.[1]?.body));
    expect(question.message.parts[0].value).toBe('Which of these should I look at first?');
    const poll = JSON.parse(String(sending.mock.calls[1]?.[1]?.body));
    expect(poll.poll.options.map((option: { text: string }) => option.text)).toEqual([
      'Swim at the rec centre',
      'Library storytime',
      'None of these',
    ]);
  });
});
