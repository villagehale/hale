import { createHmac } from 'node:crypto';
import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type FakeDb,
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeAckComposer,
  fakeNoOpenQuestions,
  fakeRadar,
  fakeSilentAnswerComposer,
  makeFakeDb,
} from '~/lib/channel/intake/fakes';
import type { IntakeDeps } from '~/lib/channel/intake/machine';
import { FakeTransport } from '~/lib/channel/intake/transport';
import type { ChannelMessageReceivedJob, TwilioInboundDeps } from '~/lib/channel/twilio/inbound';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import {
  LINQ_GROUP_CLAIM_REFUSED_TEXT,
  LINQ_GROUP_LINE_MISSING_TEXT,
  LINQ_GROUP_OPEN_TEXT,
  LINQ_GROUP_TRIGGER_PHRASE,
  linqCoParentAsk,
  linqGroupMakeInstruction,
  linqGroupTriggerInOneToOne,
} from './group';
import { handleLinqInboundRequest } from './inbound';

/**
 * The Linq door, end to end minus the network. The signature is computed from
 * Standard Webhooks, and the family is enrolled on the SMS blind index — the
 * continuity law this door must not fork.
 */

const ENC_KEY = Buffer.alloc(32, 7).toString('base64');
const KEY_BYTES = Buffer.alloc(32, 9);
const SECRET = `whsec_${KEY_BYTES.toString('base64')}`;
const API_KEY = 'linq_test_key_not_a_secret';
const APP_URL = 'https://app.villagehale.com';
const INBOUND_URL = `${APP_URL}/api/channels/linq/inbound?version=2026-02-03`;
const PHONE = '+14165551234';
const CHAT_ID = '8f392755-6865-4b18-880a-227f9d8b458f';
const MESSAGE_ID = '89e3566e-1d13-49e5-a8ee-48490d5bfeb7';
const NOW = new Date('2026-09-23T12:00:00.000Z');
const TS = String(Math.floor(NOW.getTime() / 1000));

function sign(body: string): string {
  const mac = createHmac('sha256', KEY_BYTES).update(`evt_fixture.${TS}.${body}`).digest('base64');
  return `v1,${mac}`;
}

function messageBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    api_version: 'v3',
    webhook_version: '2026-02-03',
    event_type: 'message.received',
    event_id: 'evt_fixture',
    created_at: NOW.toISOString(),
    data: {
      chat: { id: CHAT_ID, is_group: false },
      id: MESSAGE_ID,
      direction: 'inbound',
      sender_handle: { handle: PHONE, is_me: false },
      parts: [{ type: 'text', value: 'can you move swimming to Thursday?' }],
      sent_at: NOW.toISOString(),
      service: 'iMessage',
    },
    ...overrides,
  });
}

function request(body: string, options: { signature?: string | null; url?: string } = {}): Request {
  const signature = options.signature === undefined ? sign(body) : options.signature;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (signature !== null) {
    headers['webhook-id'] = 'evt_fixture';
    headers['webhook-timestamp'] = TS;
    headers['webhook-signature'] = signature;
  }
  return new Request(options.url ?? INBOUND_URL, { method: 'POST', headers, body });
}

function enrol(fake: FakeDb): { familyId: string; userId: string } {
  const familyId = '00000000-0000-4000-8000-0000000000f1';
  const userId = '00000000-0000-4000-8000-0000000000u1';
  fake.db.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(PHONE),
    phoneE164Hash: phoneBlindIndex(PHONE),
    verifiedAt: NOW,
  } as never);
  fake.db
    .insert(schema.familyMembers)
    .values({ userId, familyId, role: 'primary_parent' } as never);
  fake.db.insert(schema.smsIntakeSessions).values({
    phoneHash: phoneBlindIndex(PHONE),
    state: 'complete',
    closedAt: NOW,
  } as never);
  return { familyId, userId };
}

function harness(): {
  fake: FakeDb;
  jobs: ChannelMessageReceivedJob[];
  deps: Parameters<typeof handleLinqInboundRequest>[1];
  reads: Array<{ chatId: string }>;
  warns: unknown[];
  sends: Array<{ chatId: string; text: string }>;
} {
  const fake = makeFakeDb();
  const jobs: ChannelMessageReceivedJob[] = [];
  const reads: Array<{ chatId: string }> = [];
  const warns: unknown[] = [];
  const sends: Array<{ chatId: string; text: string }> = [];
  const intake: IntakeDeps = {
    transport: new FakeTransport(),
    threadMessage: async () => 'conv-1',
    extractor: new FakeExtractor([{ children: [], postalCode: null }]),
    intentReader: new FakeIntentReader([
      { intent: 'assent', verbatim: 'yes', interpretation: 'plain yes' },
    ]),
    radar: fakeRadar,
    ackComposer: fakeAckComposer,
    answerComposer: fakeSilentAnswerComposer,
    openQuestions: fakeNoOpenQuestions,
    identityAsk: new FakeIdentityAsk(),
    limiter: new FakeRateLimiter(() => NOW.getTime()),
    now: NOW,
  };
  const deps: TwilioInboundDeps = {
    database: fake.db,
    intake: () => intake,
    enqueue: async (job) => {
      jobs.push(job);
    },
    log: {
      info: () => {},
      warn: (fields) => {
        warns.push(fields);
      },
      error: () => {},
    },
    countOutcome: async () => {},
    now: () => NOW,
  };
  return {
    fake,
    jobs,
    reads,
    warns,
    sends,
    deps: {
      ...deps,
      markRead: async (input) => {
        reads.push(input);
        return { status: 'accepted' };
      },
      sendGroupText: async (input) => {
        sends.push(input);
        return { providerMessageId: `out-${sends.length}` };
      },
    },
  };
}

function groupBody(text: string, messageId = MESSAGE_ID): string {
  const body = JSON.parse(messageBody()) as {
    data: { id: string; chat: { is_group: boolean }; parts: unknown[] };
  };
  body.data.chat.is_group = true;
  body.data.id = messageId;
  body.data.parts = [{ type: 'text', value: text }];
  return JSON.stringify(body);
}

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = ENC_KEY;
  vi.stubEnv('LINQ_API_KEY', API_KEY);
  vi.stubEnv('LINQ_WEBHOOK_SECRET', SECRET);
});

afterEach(() => {
  process.env.APP_ENCRYPTION_KEY = '';
  vi.unstubAllEnvs();
});

describe('design-locked claim copy', () => {
  it('keeps the approved sentences byte for byte', () => {
    expect(LINQ_GROUP_CLAIM_REFUSED_TEXT).toEqual({
      en: "I can't use this thread as your kids' year.",
      fr: "Je ne peux pas utiliser ce fil comme l'annee de vos enfants.",
    });
    expect(LINQ_GROUP_LINE_MISSING_TEXT).toEqual({
      en: "I don't have a number for you to add to a group yet.",
      fr: "Je n'ai pas encore de numero a ajouter a un groupe.",
    });
    expect(LINQ_GROUP_TRIGGER_PHRASE).toEqual({
      en: 'this is our year',
      fr: 'cest notre annee',
    });
    expect(linqGroupMakeInstruction('+1 646-235-2164', 'en')).toBe(
      'Start an iMessage group with them and this number: +1 646-235-2164. In that group, send: this is our year.',
    );
    expect(linqGroupMakeInstruction('+1 646-235-2164', 'fr')).toBe(
      'Ouvre un groupe iMessage avec eux et ce numero: +1 646-235-2164. Dans ce groupe, envoie: cest notre annee.',
    );
    expect(linqCoParentAsk('+1 646-235-2164', 'en')).toBe(
      "Want the other parent on the kids' year too? Start an iMessage group with them and this number: +1 646-235-2164. In that group, send: this is our year.",
    );
    expect(linqCoParentAsk('+1 646-235-2164', 'fr')).toBe(
      "Tu veux l'autre parent sur l'annee des enfants aussi? Ouvre un groupe iMessage avec eux et ce numero: +1 646-235-2164. Dans ce groupe, envoie: cest notre annee.",
    );
    expect(linqGroupTriggerInOneToOne('+1 646-235-2164', 'en')).toBe(
      'That phrase belongs in the group. Start an iMessage group with them and +1 646-235-2164, then send: this is our year.',
    );
    expect(linqGroupTriggerInOneToOne('+1 646-235-2164', 'fr')).toBe(
      'Cette phrase va dans le groupe. Ouvrez un groupe iMessage avec eux et +1 646-235-2164, puis envoyez: cest notre annee.',
    );
    expect(LINQ_GROUP_OPEN_TEXT).toBe("This thread is your kids' year — both of you, and me.");
  });
});

describe('handleLinqInboundRequest', () => {
  it('answers 503 and writes nothing when the leg is not configured', async () => {
    vi.stubEnv('LINQ_API_KEY', '');
    vi.stubEnv('LINQ_WEBHOOK_SECRET', '');
    const h = harness();

    const res = await handleLinqInboundRequest(request(messageBody()), h.deps);

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: 'linq_not_configured' });
    expect(h.fake.writes).toHaveLength(0);
    expect(h.jobs).toHaveLength(0);
  });

  it('answers 503 when only one of the two secrets is set', async () => {
    vi.stubEnv('LINQ_API_KEY', '');
    const h = harness();
    const res = await handleLinqInboundRequest(request(messageBody()), h.deps);
    expect(res.status).toBe(503);
    expect(h.jobs).toHaveLength(0);
  });

  it('rejects a bad signature before any write', async () => {
    const h = harness();
    const res = await handleLinqInboundRequest(
      request(messageBody(), { signature: 'v1,aaaa' }),
      h.deps,
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'invalid_signature' });
    expect(h.fake.writes).toHaveLength(0);
  });

  it('refuses a subscription URL that is not pinned to 2026-02-03', async () => {
    const h = harness();
    const body = messageBody();
    const res = await handleLinqInboundRequest(
      request(body, { url: `${APP_URL}/api/channels/linq/inbound` }),
      h.deps,
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'unsupported_webhook_version' });
    expect(h.jobs).toHaveLength(0);
  });

  it('routes a signed 1:1 onto the family the SMS hash enrolled, and keeps the chat id', async () => {
    const h = harness();
    const { familyId, userId } = enrol(h.fake);

    const res = await handleLinqInboundRequest(request(messageBody()), h.deps);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ outcome: 'handed_off' });
    const message = h.fake
      .rows(schema.channelMessages)
      .find((row) => row.providerMessageId === MESSAGE_ID);
    expect(message).toMatchObject({
      familyId,
      parentUserId: userId,
      channel: 'imessage',
      direction: 'in',
      category: 'reply',
      body: 'can you move swimming to Thursday?',
      providerChatId: CHAT_ID,
    });
    expect(h.reads).toEqual([{ chatId: CHAT_ID }]);
    expect(h.jobs).toEqual([
      {
        family_id: familyId,
        parent_user_id: userId,
        channel_message_id: message?.id,
        provider_message_id: MESSAGE_ID,
        received_at: NOW.toISOString(),
      },
    ]);
  });

  it('does not claim a group or hand it to the coach until the trigger', async () => {
    const h = harness();
    const { familyId } = enrol(h.fake);
    await h.fake.db
      .insert(schema.families)
      .values({ id: familyId, displayName: 'Fixture' } as never);

    const res = await handleLinqInboundRequest(
      request(groupBody('can you move swimming to Thursday?')),
      h.deps,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ outcome: 'group_unclaimed' });
    expect(h.reads).toEqual([]);
    expect(h.jobs).toHaveLength(0);
    expect(h.sends).toEqual([]);
    const family = h.fake.rows(schema.families).find((row) => row.id === familyId);
    expect(family?.linqGroupChatId ?? null).toBeNull();
  });

  it('claims the group when an enrolled parent sends the trigger, and does not coach it', async () => {
    const h = harness();
    const { familyId, userId } = enrol(h.fake);
    await h.fake.db
      .insert(schema.families)
      .values({ id: familyId, displayName: 'Fixture' } as never);

    const res = await handleLinqInboundRequest(
      request(groupBody(LINQ_GROUP_TRIGGER_PHRASE.en)),
      h.deps,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      outcome: 'group_claimed',
      claim: 'claimed',
      notice: 'sent',
    });
    expect(h.jobs).toHaveLength(0);
    expect(h.sends).toEqual([{ chatId: CHAT_ID, text: LINQ_GROUP_OPEN_TEXT }]);
    const family = h.fake.rows(schema.families).find((row) => row.id === familyId);
    expect(family?.linqGroupChatId).toBe(CHAT_ID);
    const inbound = h.fake
      .rows(schema.channelMessages)
      .find((row) => row.providerMessageId === MESSAGE_ID);
    expect(inbound).toMatchObject({
      familyId,
      parentUserId: userId,
      direction: 'in',
      body: LINQ_GROUP_TRIGGER_PHRASE.en,
      providerChatId: CHAT_ID,
    });
    expect(inbound?.handedOffAt).toEqual(NOW);
    const ack = h.fake
      .rows(schema.channelMessages)
      .find((row) => row.templateKey === 'linq:group_claimed');
    expect(ack).toMatchObject({ familyId, direction: 'out', channel: 'imessage' });
    expect(
      h.fake.rows(schema.auditLog).some((row) => row.actionTaken === 'linq_group_claimed'),
    ).toBe(true);
  });

  it('routes a later message once the group is already this household', async () => {
    const h = harness();
    const { familyId, userId } = enrol(h.fake);
    await h.fake.db.insert(schema.families).values({
      id: familyId,
      displayName: 'Fixture',
      linqGroupChatId: CHAT_ID,
    } as never);

    const res = await handleLinqInboundRequest(
      request(groupBody('can you move swimming to Thursday?')),
      h.deps,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ outcome: 'handed_off' });
    expect(h.reads).toEqual([]);
    expect(h.jobs).toHaveLength(1);
    const message = h.fake
      .rows(schema.channelMessages)
      .find((row) => row.providerMessageId === MESSAGE_ID);
    expect(message).toMatchObject({
      familyId,
      parentUserId: userId,
      channel: 'imessage',
      providerChatId: CHAT_ID,
    });
  });

  it('refuses a trigger in a chat another family already claimed', async () => {
    const h = harness();
    const { familyId } = enrol(h.fake);
    const otherId = '00000000-0000-4000-8000-0000000000f2';
    await h.fake.db
      .insert(schema.families)
      .values({ id: familyId, displayName: 'Fixture' } as never);
    await h.fake.db.insert(schema.families).values({
      id: otherId,
      displayName: 'Other',
      linqGroupChatId: CHAT_ID,
    } as never);

    const res = await handleLinqInboundRequest(
      request(groupBody(LINQ_GROUP_TRIGGER_PHRASE.en)),
      h.deps,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      outcome: 'group_claim_refused',
      claim: 'claimed_by_other_family',
      notice: 'sent',
    });
    expect(h.sends).toEqual([{ chatId: CHAT_ID, text: LINQ_GROUP_CLAIM_REFUSED_TEXT.en }]);
    expect(h.jobs).toHaveLength(0);
    const mine = h.fake.rows(schema.families).find((row) => row.id === familyId);
    const other = h.fake.rows(schema.families).find((row) => row.id === otherId);
    expect(mine?.linqGroupChatId ?? null).toBeNull();
    expect(other?.linqGroupChatId).toBe(CHAT_ID);
  });

  it('refuses a French trigger in the locked French line', async () => {
    const h = harness();
    const { familyId } = enrol(h.fake);
    const otherId = '00000000-0000-4000-8000-0000000000f2';
    await h.fake.db
      .insert(schema.families)
      .values({ id: familyId, displayName: 'Fixture' } as never);
    await h.fake.db.insert(schema.families).values({
      id: otherId,
      displayName: 'Other',
      linqGroupChatId: CHAT_ID,
    } as never);

    const res = await handleLinqInboundRequest(
      request(groupBody(LINQ_GROUP_TRIGGER_PHRASE.fr)),
      h.deps,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      outcome: 'group_claim_refused',
      claim: 'claimed_by_other_family',
    });
    expect(h.sends).toEqual([{ chatId: CHAT_ID, text: LINQ_GROUP_CLAIM_REFUSED_TEXT.fr }]);
    const mine = h.fake.rows(schema.families).find((row) => row.id === familyId);
    expect(mine?.linqGroupChatId ?? null).toBeNull();
  });

  it('does not claim the 1:1 when the trigger arrives there', async () => {
    vi.stubEnv('LINQ_FROM_E164', '+16462352164');
    const h = harness();
    const { familyId } = enrol(h.fake);
    await h.fake.db
      .insert(schema.families)
      .values({ id: familyId, displayName: 'Fixture' } as never);
    const body = JSON.parse(messageBody()) as { data: { parts: unknown[] } };
    body.data.parts = [{ type: 'text', value: LINQ_GROUP_TRIGGER_PHRASE.en }];

    const res = await handleLinqInboundRequest(request(JSON.stringify(body)), h.deps);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      outcome: 'group_trigger_in_1to1',
      notice: 'sent',
    });
    expect(h.jobs).toHaveLength(0);
    expect(h.sends).toEqual([
      {
        chatId: CHAT_ID,
        text: linqGroupTriggerInOneToOne('+1 646-235-2164', 'en'),
      },
    ]);
    const family = h.fake.rows(schema.families).find((row) => row.id === familyId);
    expect(family?.linqGroupChatId ?? null).toBeNull();
    expect(h.reads).toEqual([{ chatId: CHAT_ID }]);
  });

  it('holds an unknown group sender and does not open a family', async () => {
    const h = harness();
    const holds: string[] = [];
    h.deps = {
      ...h.deps,
      holdGroup: async (input) => {
        holds.push(input.chatId);
        return 'sent';
      },
    };
    const body = JSON.parse(messageBody()) as {
      data: { chat: { is_group: boolean } };
    };
    body.data.chat.is_group = true;

    const res = await handleLinqInboundRequest(request(JSON.stringify(body)), h.deps);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      outcome: 'group_unknown_sender',
      hold: 'sent',
    });
    expect(holds).toEqual([CHAT_ID]);
    expect(h.jobs).toHaveLength(0);
    expect(h.fake.rows(schema.channelMessages)).toHaveLength(0);
    expect(h.fake.rows(schema.families)).toHaveLength(0);
  });

  it('does not claim when an unknown sender uses the trigger', async () => {
    const h = harness();
    h.deps = {
      ...h.deps,
      holdGroup: async () => 'sent',
    };

    const res = await handleLinqInboundRequest(
      request(groupBody(LINQ_GROUP_TRIGGER_PHRASE.en)),
      h.deps,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ outcome: 'group_unknown_sender' });
    expect(h.sends).toEqual([]);
    expect(h.jobs).toHaveLength(0);
    expect(h.fake.rows(schema.families)).toHaveLength(0);
  });

  it('does not claim when the trigger is only part of a sentence', async () => {
    const h = harness();
    const { familyId } = enrol(h.fake);
    await h.fake.db
      .insert(schema.families)
      .values({ id: familyId, displayName: 'Fixture' } as never);

    const res = await handleLinqInboundRequest(
      request(groupBody(`please ${LINQ_GROUP_TRIGGER_PHRASE.en} thanks`)),
      h.deps,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ outcome: 'group_unclaimed' });
    const family = h.fake.rows(schema.families).find((row) => row.id === familyId);
    expect(family?.linqGroupChatId ?? null).toBeNull();
  });

  it('sends nothing when an unknown group sender says STOP', async () => {
    const h = harness();
    const holds: string[] = [];
    h.deps = {
      ...h.deps,
      holdGroup: async () => {
        holds.push('held');
        return 'sent';
      },
    };
    const body = JSON.parse(messageBody()) as {
      data: { chat: { is_group: boolean }; parts: unknown[] };
    };
    body.data.chat.is_group = true;
    body.data.parts = [{ type: 'text', value: 'STOP' }];

    const res = await handleLinqInboundRequest(request(JSON.stringify(body)), h.deps);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ outcome: 'group_opt_out' });
    expect(holds).toEqual([]);
    expect(h.jobs).toHaveLength(0);
  });

  it('acks a reaction and a typing event without routing', async () => {
    const h = harness();
    enrol(h.fake);
    const reaction = JSON.parse(messageBody()) as { event_type: string; data: unknown };
    reaction.event_type = 'reaction.added';
    reaction.data = {
      chat_id: CHAT_ID,
      message_id: MESSAGE_ID,
      reaction_type: 'like',
      is_from_me: false,
      from: PHONE,
    };
    const res = await handleLinqInboundRequest(request(JSON.stringify(reaction)), h.deps);
    expect(res.status).toBe(200);
    const reactionBody = await res.json();
    expect(reactionBody).toEqual({ outcome: 'reaction.added' });
    expect(JSON.stringify(reactionBody)).not.toContain(PHONE);

    const typing = JSON.parse(messageBody()) as { event_type: string; data: unknown };
    typing.event_type = 'chat.typing_indicator.started';
    typing.data = { chat_id: CHAT_ID };
    const typed = await handleLinqInboundRequest(request(JSON.stringify(typing)), h.deps);
    expect(typed.status).toBe(200);
    await expect(typed.json()).resolves.toEqual({ outcome: 'chat.typing_indicator.started' });
    expect(h.jobs).toHaveLength(0);
  });

  it('routes a poll vote as the option text', async () => {
    const h = harness();
    const { familyId, userId } = enrol(h.fake);
    await h.fake.db.insert(schema.linqPollOptions).values({
      familyId,
      parentUserId: userId,
      providerChatId: CHAT_ID,
      providerMessageId: 'poll-msg',
      optionId: 'opt-soccer',
      optionText: 'Soccer',
    } as never);
    const vote = JSON.parse(messageBody()) as { event_type: string; data: unknown };
    vote.event_type = 'poll.vote.added';
    vote.data = {
      chat_id: CHAT_ID,
      message_id: 'poll-msg',
      option_id: 'opt-soccer',
      sender_handle: { handle: PHONE, is_me: false },
    };

    const res = await handleLinqInboundRequest(request(JSON.stringify(vote)), h.deps);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ outcome: 'handed_off' });
    const message = h.fake.rows(schema.channelMessages).find((row) => row.body === 'Soccer');
    expect(message).toMatchObject({
      familyId,
      providerMessageId: `poll:poll-msg:opt-soccer:${phoneBlindIndex(PHONE)}`,
      providerChatId: CHAT_ID,
    });
    expect(h.reads).toEqual([{ chatId: CHAT_ID }]);
    expect(JSON.stringify(h.warns)).not.toContain(PHONE);
  });

  it('routes a second parent voting the same option, and drops a repeat from the first', async () => {
    const h = harness();
    const { familyId, userId } = enrol(h.fake);
    const other = '+14165559876';
    const otherUser = '00000000-0000-4000-8000-0000000000u9';
    h.fake.db.insert(schema.parentChannels).values({
      userId: otherUser,
      familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(other),
      phoneE164Hash: phoneBlindIndex(other),
      verifiedAt: NOW,
    } as never);
    h.fake.db
      .insert(schema.familyMembers)
      .values({ userId: otherUser, familyId, role: 'co_parent' } as never);
    h.fake.db.insert(schema.smsIntakeSessions).values({
      phoneHash: phoneBlindIndex(other),
      state: 'complete',
      closedAt: NOW,
    } as never);
    await h.fake.db.insert(schema.linqPollOptions).values({
      familyId,
      parentUserId: userId,
      providerChatId: CHAT_ID,
      providerMessageId: 'poll-msg',
      optionId: 'opt-soccer',
      optionText: 'Soccer',
    } as never);

    const vote = (handle: string, eventId: string) => {
      const body = JSON.parse(messageBody()) as {
        event_id: string;
        event_type: string;
        data: unknown;
      };
      body.event_id = eventId;
      body.event_type = 'poll.vote.added';
      body.data = {
        chat_id: CHAT_ID,
        message_id: 'poll-msg',
        option_id: 'opt-soccer',
        sender_handle: { handle, is_me: false },
      };
      return JSON.stringify(body);
    };

    const first = await handleLinqInboundRequest(request(vote(PHONE, 'evt_fixture')), h.deps);
    const second = await handleLinqInboundRequest(request(vote(other, 'evt_second')), h.deps);
    const repeat = await handleLinqInboundRequest(request(vote(PHONE, 'evt_repeat')), h.deps);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(repeat.status).toBe(200);
    await expect(second.json()).resolves.toEqual({ outcome: 'handed_off' });
    await expect(repeat.json()).resolves.toEqual({ outcome: 'duplicate' });
    const votes = h.fake
      .rows(schema.channelMessages)
      .filter((row) => row.body === 'Soccer')
      .map((row) => row.providerMessageId);
    expect(votes).toEqual([
      `poll:poll-msg:opt-soccer:${phoneBlindIndex(PHONE)}`,
      `poll:poll-msg:opt-soccer:${phoneBlindIndex(other)}`,
    ]);
    expect(JSON.stringify(votes)).not.toContain(PHONE);
    expect(JSON.stringify(votes)).not.toContain(other);
  });

  it('still hands the turn off when mark-read is refused', async () => {
    const h = harness();
    enrol(h.fake);
    h.deps = {
      ...h.deps,
      markRead: async (input) => {
        h.reads.push(input);
        return { status: 'refused', code: '2001', httpStatus: 404, permanent: true };
      },
    };

    const res = await handleLinqInboundRequest(request(messageBody()), h.deps);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ outcome: 'handed_off' });
    expect(h.reads).toEqual([{ chatId: CHAT_ID }]);
    expect(h.warns).toEqual([
      expect.objectContaining({ outcome: 'refused', code: '2001', httpStatus: 404 }),
    ]);
    expect(JSON.stringify(h.warns)).not.toContain(CHAT_ID);
    expect(JSON.stringify(h.warns)).not.toContain('swimming');
  });

  it('does not put the webhook secret or the message text in a refusal', async () => {
    const h = harness();
    const res = await handleLinqInboundRequest(
      request(messageBody(), { signature: 'v1,aaaa' }),
      h.deps,
    );
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('swimming');
    expect(text).not.toContain(API_KEY);
  });
});
