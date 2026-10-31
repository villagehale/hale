import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeFakeDb } from '~/lib/channel/intake/fakes';
import {
  LINQ_EDIT_MAX,
  type LinqEditDecider,
  type LinqEditDecision,
  applyLinqEdit,
  createLinqEditDecider,
  linqEditRefusals,
  linqMessageEditEnabled,
  listEditableLinqSends,
  recordLinqEditWebhook,
} from './edit';
import { considerLinqReply } from './moments';

vi.mock('~/lib/pipeline/structured', () => ({ forceToolJson: vi.fn() }));
vi.mock('~/lib/cron/skill', () => ({
  loadCronSkill: async () => ({
    meta: { name: 'linq-edit', whenToUse: 'x', task: 'screen', tools: [] },
    instructions: 'decide',
  }),
}));

const { forceToolJson } = await import('~/lib/pipeline/structured');
const CLIENT = {} as AgentClient;
const NOW = new Date('2026-10-31T16:00:00.000Z');
const INBOUND = new Date(NOW.getTime() - 60 * 1000);
const FAMILY = '00000000-0000-4000-8000-0000000000f1';
const USER = '00000000-0000-4000-8000-0000000000u1';
const CONV = '00000000-0000-4000-8000-0000000000c1';
const CHAT = '8f392755-6865-4b18-880a-227f9d8b458f';
const MESSAGE = '89e3566e-1d13-49e5-a8ee-48490d5bfeb7';

function decider(decision: LinqEditDecision | null): LinqEditDecider {
  return {
    async decide() {
      return decision;
    },
  };
}

function linqFetch(status = 200, body: unknown = { id: MESSAGE }) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    status < 300
      ? Response.json(body, { status })
      : Response.json({ error: { code: 2019 } }, { status }),
  );
}

async function seedBubble(
  fake: ReturnType<typeof makeFakeDb>,
  input: { sentAt: Date; text: string; messageId?: string } = {
    sentAt: NOW,
    text: 'Swim is at 4.',
  },
) {
  const messageId = input.messageId ?? MESSAGE;
  await fake.db.insert(schema.channelMessages).values({
    familyId: FAMILY,
    parentUserId: USER,
    channel: 'imessage',
    direction: 'out',
    category: 'reply',
    status: 'sent',
    providerMessageId: messageId,
    providerChatId: CHAT,
    sentAt: input.sentAt,
    relatedConversationId: CONV,
  });
  await fake.db.insert(schema.messages).values({
    conversationId: CONV,
    role: 'assistant',
    content: input.text,
    providerMessageId: messageId,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(forceToolJson).mockReset();
});

describe('VIL-479 Linq message edit', () => {
  it('is off unless the flag is exactly true', () => {
    expect(linqMessageEditEnabled()).toBe(false);
    vi.stubEnv('LINQ_MESSAGE_EDIT_ENABLED', 'on');
    expect(linqMessageEditEnabled()).toBe(false);
    vi.stubEnv('LINQ_MESSAGE_EDIT_ENABLED', 'true');
    expect(linqMessageEditEnabled()).toBe(true);
  });

  it('offers a recent text bubble and withholds one outside the window or past the edit cap', async () => {
    const fake = makeFakeDb();
    await seedBubble(fake);
    await seedBubble(fake, {
      sentAt: new Date(NOW.getTime() - 16 * 60 * 1000),
      text: 'Old time.',
      messageId: 'old-msg',
    });
    const offered = await listEditableLinqSends(fake.db, {
      familyId: FAMILY,
      conversationId: CONV,
      chatId: CHAT,
      now: NOW,
      inboundAt: INBOUND,
    });
    expect(offered.map((row) => row.messageId)).toEqual([MESSAGE]);
    expect(offered[0]).toMatchObject({ partIndex: 0, text: 'Swim is at 4.', editsUsed: 0 });

    const channelId = offered[0]?.channelMessageId;
    expect(channelId).toBeTruthy();
    for (let i = 0; i < LINQ_EDIT_MAX; i += 1) {
      await fake.db.insert(schema.auditLog).values({
        familyId: FAMILY,
        actor: USER,
        actionTaken: 'linq_message_edited',
        targetTable: 'channel_messages',
        targetId: channelId,
      });
    }
    expect(
      await listEditableLinqSends(fake.db, {
        familyId: FAMILY,
        conversationId: CONV,
        chatId: CHAT,
        now: NOW,
        inboundAt: INBOUND,
      }),
    ).toEqual([]);
  });

  it("offers only a bubble sent after the parent's current inbound, never one they already answered", async () => {
    const fake = makeFakeDb();
    await seedBubble(fake, {
      sentAt: new Date(INBOUND.getTime() - 30 * 1000),
      text: 'Before they wrote.',
      messageId: 'answered-msg',
    });
    await seedBubble(fake);
    const base = { familyId: FAMILY, conversationId: CONV, chatId: CHAT, now: NOW };
    const offered = await listEditableLinqSends(fake.db, { ...base, inboundAt: INBOUND });
    expect(offered.map((row) => row.messageId)).toEqual([MESSAGE]);

    // A parent line that landed after the bubble (mid-turn) closes it too.
    await fake.db.insert(schema.messages).values({
      conversationId: CONV,
      role: 'user',
      content: 'ok thanks',
      createdAt: new Date(NOW.getTime() + 1000),
    });
    expect(
      await listEditableLinqSends(fake.db, {
        ...base,
        now: new Date(NOW.getTime() + 2000),
        inboundAt: INBOUND,
      }),
    ).toEqual([]);
  });

  it('keeps a bubble editable when a queued parent text is inserted after Hale sent it', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_MESSAGE_EDIT_ENABLED', 'true');
    const parentAt = new Date('2026-10-31T15:59:00.000Z');
    const bubbleAt = new Date('2026-10-31T16:00:00.000Z');
    const insertedAt = new Date('2026-10-31T16:02:00.000Z');
    const fake = makeFakeDb();
    await fake.db.insert(schema.channelMessages).values({
      familyId: FAMILY,
      parentUserId: USER,
      channel: 'imessage',
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      providerMessageId: 'in-delayed',
      providerChatId: CHAT,
      sentAt: parentAt,
      body: 'It moved to 5.',
    });
    await seedBubble(fake, { sentAt: bubbleAt, text: 'Swim is at 4.' });
    await fake.db.insert(schema.messages).values({
      conversationId: CONV,
      role: 'user',
      content: 'It moved to 5.',
      providerMessageId: 'in-delayed',
      createdAt: insertedAt,
    });
    const offered = await listEditableLinqSends(fake.db, {
      familyId: FAMILY,
      conversationId: CONV,
      chatId: CHAT,
      now: new Date(insertedAt.getTime() + 1000),
      inboundAt: parentAt,
    });
    expect(offered.map((row) => row.messageId)).toEqual([MESSAGE]);

    const fetchMock = linqFetch();
    const moment = await considerLinqReply(fake.db, {
      route: {
        channel: 'imessage',
        to: '+14165550101',
        chatId: CHAT,
        replyToMessageId: 'in-delayed',
      },
      inboundBody: 'It moved to 5.',
      outboundBody: 'Swim is at 5.',
      templateKey: null,
      familyId: FAMILY,
      parentUserId: USER,
      now: new Date(insertedAt.getTime() + 1000),
      fetch: fetchMock,
      edit: {
        decider: decider({
          edit: { messageId: MESSAGE, partIndex: 0, text: 'Swim is at 5.' },
        }),
        candidates: offered,
        audience: 'direct',
        conversationId: CONV,
      },
    });
    expect(moment.handled).toBe(true);
    if (!moment.handled) return;
    expect(moment.threadBody).toBeNull();
    const call = fetchMock.mock.calls[0];
    expect(String(call?.[0])).toContain(`/messages/${MESSAGE}`);
    expect(call?.[1]?.method).toBe('PATCH');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ text: 'Swim is at 5.', part_index: 0 });
    expect(fetchMock.mock.calls.some((sent) => sent[1]?.method === 'POST')).toBe(false);
  });

  it('patches only the text the model wrote and rewrites that bubble', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const fake = makeFakeDb();
    await seedBubble(fake);
    const candidates = await listEditableLinqSends(fake.db, {
      familyId: FAMILY,
      conversationId: CONV,
      chatId: CHAT,
      now: NOW,
      inboundAt: INBOUND,
    });
    const fetchMock = linqFetch();
    const edited = await applyLinqEdit({
      decider: decider({
        edit: { messageId: MESSAGE, partIndex: 0, text: 'Swim is at 5.' },
      }),
      database: fake.db,
      familyId: FAMILY,
      parentUserId: USER,
      conversationId: CONV,
      chatId: CHAT,
      now: NOW,
      read: { audience: 'direct', parentText: 'It moved to 5.', followUp: 'Swim is at 5.' },
      candidates,
      fetch: fetchMock,
    });
    expect(edited.status).toBe('edited');
    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({ text: 'Swim is at 5.', part_index: 0 });
    expect(init?.method).toBe('PATCH');
    expect(fake.rows(schema.messages).map((row) => row.content)).toEqual(['Swim is at 5.']);
    expect(
      fake.rows(schema.auditLog).filter((row) => row.actionTaken === 'linq_message_edited'),
    ).toHaveLength(1);
    expect(fake.rows(schema.channelMessages).some((row) => row.templateKey === 'linq:edit')).toBe(
      true,
    );
  });

  it('sends the follow-up when the model declines, fails, or names a bubble it was not shown', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const fake = makeFakeDb();
    await seedBubble(fake);
    const candidates = await listEditableLinqSends(fake.db, {
      familyId: FAMILY,
      conversationId: CONV,
      chatId: CHAT,
      now: NOW,
      inboundAt: INBOUND,
    });
    const fetchMock = linqFetch();
    const base = {
      database: fake.db,
      familyId: FAMILY,
      parentUserId: USER,
      conversationId: CONV,
      chatId: CHAT,
      now: NOW,
      inboundAt: INBOUND,
      read: { audience: 'direct' as const, parentText: 'ok', followUp: 'See you then.' },
      candidates,
      fetch: fetchMock,
    };
    expect(await applyLinqEdit({ ...base, decider: decider({ edit: null }) })).toEqual({
      status: 'declined',
    });
    expect(await applyLinqEdit({ ...base, decider: decider(null) })).toEqual({
      status: 'not_edited',
      reason: 'model_failed',
    });
    expect(
      await applyLinqEdit({
        ...base,
        decider: decider({
          edit: { messageId: 'not-shown', partIndex: 0, text: 'Swim is at 5.' },
        }),
      }),
    ).toEqual({ status: 'not_edited', reason: 'model_failed' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.rows(schema.messages).map((row) => row.content)).toEqual(['Swim is at 4.']);
  });

  it('refuses a reading that is not one of the bubbles, and does not invent wording', async () => {
    const editable = [{ messageId: MESSAGE, partIndex: 0, text: 'Swim is at 4.' }];
    expect(
      linqEditRefusals(
        { edit: { messageId: 'other', partIndex: 0, text: 'Swim is at 5.' } },
        editable,
      ),
    ).toEqual(['unknown_message']);
    expect(
      linqEditRefusals(
        { edit: { messageId: MESSAGE, partIndex: 0, text: 'Swim is at 4.' } },
        editable,
      ),
    ).toContain('unchanged');
    expect(linqEditRefusals({ edit: null }, editable)).toEqual([]);

    vi.mocked(forceToolJson).mockResolvedValue({
      value: { edit: { messageId: MESSAGE, partIndex: 1, text: 'nope' } },
    } as never);
    const bubble = editable[0];
    if (!bubble) throw new Error('fixture');
    const decided = await createLinqEditDecider(CLIENT).decide({
      audience: 'direct',
      parentText: 'It moved.',
      followUp: 'Swim is at 5.',
      editable: [{ ...bubble, sentAt: NOW.toISOString(), editsUsed: 0 }],
    });
    expect(decided).toBeNull();
    const userMessage = String(vi.mocked(forceToolJson).mock.calls[0]?.[0]?.userMessage);
    expect(userMessage).toContain('Swim is at 5.');
    expect(userMessage).not.toContain('Updated:');
  });

  it('stands in for the follow-up when the model edits', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_MESSAGE_EDIT_ENABLED', 'true');
    const fake = makeFakeDb();
    await seedBubble(fake);
    const candidates = await listEditableLinqSends(fake.db, {
      familyId: FAMILY,
      conversationId: CONV,
      chatId: CHAT,
      now: NOW,
      inboundAt: INBOUND,
    });
    const fetchMock = linqFetch();
    const moment = await considerLinqReply(fake.db, {
      route: { channel: 'imessage', to: '+14165550101', chatId: CHAT, replyToMessageId: 'in-1' },
      inboundBody: 'It moved to 5.',
      outboundBody: 'Swim is at 5.',
      templateKey: null,
      familyId: FAMILY,
      parentUserId: USER,
      now: NOW,
      fetch: fetchMock,
      edit: {
        decider: decider({
          edit: { messageId: MESSAGE, partIndex: 0, text: 'Swim is at 5.' },
        }),
        candidates,
        audience: 'direct',
        conversationId: CONV,
      },
    });
    expect(moment.handled).toBe(true);
    if (!moment.handled) return;
    expect(moment.threadBody).toBeNull();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).text).toBe('Swim is at 5.');
  });
});

describe('VIL-479 message.edited webhook', () => {
  it('rewrites the bubble once and leaves a retry alone', async () => {
    const fake = makeFakeDb();
    await seedBubble(fake);
    const first = await recordLinqEditWebhook(fake.db, {
      messageId: MESSAGE,
      chatId: CHAT,
      partIndex: 0,
      text: 'Swim is at 5.',
      editedAt: NOW,
      direction: 'outbound',
      isFromMe: true,
    });
    const second = await recordLinqEditWebhook(fake.db, {
      messageId: MESSAGE,
      chatId: CHAT,
      partIndex: 0,
      text: 'Swim is at 5.',
      editedAt: NOW,
      direction: 'outbound',
      isFromMe: true,
    });
    expect(first).toBe('updated');
    expect(second).toBe('unchanged');
    expect(fake.rows(schema.messages).map((row) => row.content)).toEqual(['Swim is at 5.']);
    expect(
      fake.rows(schema.auditLog).filter((row) => row.actionTaken === 'linq_message_edited'),
    ).toHaveLength(1);
  });

  it('names an unknown message and records a parent edit of their own bubble', async () => {
    const fake = makeFakeDb();
    expect(
      await recordLinqEditWebhook(fake.db, {
        messageId: 'missing',
        chatId: CHAT,
        partIndex: 0,
        text: 'Swim is at 5.',
        editedAt: null,
        direction: 'outbound',
        isFromMe: true,
      }),
    ).toBe('unknown_message');

    await fake.db.insert(schema.channelMessages).values({
      familyId: FAMILY,
      parentUserId: USER,
      channel: 'imessage',
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      providerMessageId: 'in-1',
      providerChatId: CHAT,
      body: 'It is at 4.',
    });
    const applied = await recordLinqEditWebhook(fake.db, {
      messageId: 'in-1',
      chatId: CHAT,
      partIndex: 0,
      text: 'It is at 5.',
      editedAt: NOW,
      direction: 'inbound',
      isFromMe: false,
    });
    expect(applied).toBe('updated');
    expect(fake.rows(schema.channelMessages).find((row) => row.direction === 'in')?.body).toBe(
      'It is at 5.',
    );
    expect(
      fake.rows(schema.auditLog).filter((row) => row.actionTaken === 'linq_parent_message_edited'),
    ).toHaveLength(1);
  });

  const outbound = (text: string, editedAt: Date | null, partIndex = 0) => ({
    messageId: MESSAGE,
    chatId: CHAT,
    partIndex,
    text,
    editedAt,
    direction: 'outbound' as const,
    isFromMe: true,
  });

  it('does not let a late, older callback undo a newer edit', async () => {
    const fake = makeFakeDb();
    await seedBubble(fake);
    const at1001 = new Date('2026-10-31T16:01:00.000Z');
    const at1002 = new Date('2026-10-31T16:02:00.000Z');
    expect(await recordLinqEditWebhook(fake.db, outbound('Swim is at 6.', at1002))).toBe('updated');
    expect(await recordLinqEditWebhook(fake.db, outbound('Swim is at 5.', at1001))).toBe(
      'unchanged',
    );
    expect(fake.rows(schema.messages).map((row) => row.content)).toEqual(['Swim is at 6.']);
  });

  it('refuses an edit of a part other than the one text Hale stores', async () => {
    const fake = makeFakeDb();
    await seedBubble(fake);
    expect(await recordLinqEditWebhook(fake.db, outbound('at 5', NOW, 1))).toBe('unchanged');
    expect(fake.rows(schema.messages).map((row) => row.content)).toEqual(['Swim is at 4.']);
  });

  async function seedParentText(fake: ReturnType<typeof makeFakeDb>, body: string | null) {
    await fake.db.insert(schema.channelMessages).values({
      familyId: FAMILY,
      parentUserId: USER,
      channel: 'imessage',
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      providerMessageId: 'in-1',
      providerChatId: CHAT,
      body,
    });
    await fake.db.insert(schema.messages).values({
      conversationId: CONV,
      role: 'user',
      content: 'Swim is at 4',
      providerMessageId: 'in-1',
    });
  }
  const parentEdit = (text: string, editedAt: Date | null) => ({
    messageId: 'in-1',
    chatId: CHAT,
    partIndex: 0,
    text,
    editedAt,
    direction: 'inbound' as const,
    isFromMe: false,
  });

  it("rewrites the parent's own turn in the coach thread, not only the ledger", async () => {
    const fake = makeFakeDb();
    await seedParentText(fake, 'Swim is at 4');
    expect(await recordLinqEditWebhook(fake.db, parentEdit('Swim is at 5', NOW))).toBe('updated');
    expect(fake.rows(schema.messages).find((row) => row.role === 'user')?.content).toBe(
      'Swim is at 5',
    );
    const older = new Date(NOW.getTime() - 60_000);
    expect(await recordLinqEditWebhook(fake.db, parentEdit('Swim is at 3', older))).toBe(
      'unchanged',
    );
    expect(fake.rows(schema.channelMessages).find((row) => row.direction === 'in')?.body).toBe(
      'Swim is at 5',
    );
  });

  it('does not bring back a parent text retention already cleared', async () => {
    const fake = makeFakeDb();
    await seedParentText(fake, null);
    expect(await recordLinqEditWebhook(fake.db, parentEdit('Swim is at 5', NOW))).toBe('unchanged');
    expect(fake.rows(schema.channelMessages).find((row) => row.direction === 'in')?.body).toBe(
      null,
    );
  });
});

describe('VIL-479 edit after the turn deadline', () => {
  it('does not patch the bubble when the turn expired during the model read', async () => {
    const { runTurn } = await import('~/lib/channel/router/deadline');
    const fake = makeFakeDb();
    await seedBubble(fake);
    const controller = new AbortController();
    const fetchImpl = linqFetch();
    const late: LinqEditDecider = {
      async decide() {
        controller.abort();
        return { edit: { messageId: MESSAGE, partIndex: 0, text: 'Swim is at 5.' } };
      },
    };
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const candidates = await listEditableLinqSends(fake.db, {
      familyId: FAMILY,
      conversationId: CONV,
      chatId: CHAT,
      now: NOW,
      inboundAt: INBOUND,
    });
    let pending: Promise<unknown> = Promise.resolve();
    const turn = runTurn(controller.signal, () => {
      pending = applyLinqEdit({
        decider: late,
        database: fake.db,
        familyId: FAMILY,
        parentUserId: USER,
        conversationId: CONV,
        chatId: CHAT,
        now: NOW,
        read: { audience: 'direct', parentText: 'wait 5', followUp: 'Swim is at 5.' },
        candidates,
        fetch: fetchImpl as unknown as typeof fetch,
      });
      return pending;
    });
    await expect(turn).rejects.toThrow();
    await expect(pending).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fake.rows(schema.messages).map((row) => row.content)).toEqual(['Swim is at 4.']);
  });
});
