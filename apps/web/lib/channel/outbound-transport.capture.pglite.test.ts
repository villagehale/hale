import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { createLinqIntroGroupOpener } from '~/lib/village/intros/group';
import { defaultOneToOneSend } from './linq/connect-link-1to1';
import { sendClaimedGroupLine } from './linq/family-outbound';
import * as door from './outbound-transport';
import {
  PreviewCaptureRefused,
  capturedChatOps,
  capturedSends,
  clearCapturedChatOps,
  clearCapturedSends,
} from './preview-capture-transport';

/**
 * With PREVIEW_CAPTURE_TRANSPORT=on on a Preview deploy with no Linq door, every
 * path that used to reach Linq around createOutboundTransport is captured and
 * makes no network call.
 */

let db: TestDb;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv('VERCEL_ENV', 'preview');
  vi.stubEnv('PREVIEW_CAPTURE_TRANSPORT', 'on');
  vi.stubEnv('LINQ_API_KEY', '');
  vi.stubEnv('LINQ_FROM_E164', '');
  fetchSpy = vi.fn(() => {
    throw new Error('network call');
  });
  vi.stubGlobal('fetch', fetchSpy);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearCapturedSends();
  clearCapturedChatOps();
  await db.exec('truncate table families, users cascade');
});

describe('former bypasses are captured', () => {
  it('connect-link 1:1 text (was createLinqPhoneTransport) and its link part', async () => {
    const send = defaultOneToOneSend();
    const text = await send.text({ to: '+15550000001', body: 'hello' });
    expect(text.providerMessageId).toMatch(/^preview-capture-/);
    expect(capturedSends()).toMatchObject([{ to: '+15550000001', body: 'hello' }]);
    await send.link({ chatId: 'chat-1', url: 'https://example.com/x' });
    expect(capturedChatOps().map((o) => o.op)).toEqual(['parts']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('claimed group line (was gated on linqApiKey only)', async () => {
    const [family] = await db.database
      .insert(schema.families)
      .values({
        displayName: 'Capture family',
        provinceOrState: 'ON',
        postalCode: 'M6H2H9',
        linqGroupChatId: 'chat-group',
      })
      .returning({ id: schema.families.id });
    const [user] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: `imessage:${family?.id}`, name: 'Parent' })
      .returning({ id: schema.users.id });
    const outcome = await sendClaimedGroupLine(db.database, {
      familyId: family?.id as string,
      parentUserId: user?.id as string,
      chatId: 'chat-group',
      body: 'mirrored line',
      now: new Date('2026-10-28T15:00:00.000Z'),
      dedupeKey: 'capture-test-1',
      templateKey: 'capture:test',
      contentClass: 'schedule',
    });
    expect(outcome).toBe('sent');
    expect(capturedChatOps()).toMatchObject([
      { op: 'chat_message', input: { chatId: 'chat-group', text: 'mirrored line' } },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('intro group open (was gated on linqApiKey and LINQ_FROM_E164)', async () => {
    const opened = await createLinqIntroGroupOpener()({
      to: ['+15550000001', '+15550000002'],
      text: 'meet each other',
    });
    expect(opened.status).toBe('opened');
    expect(capturedChatOps().map((o) => o.op)).toEqual(['create_chat']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('iMessage turn reply transport (was createLinqTextTransport)', async () => {
    const t = door.createChatReplyTransport({ chatId: 'chat-1', replyToMessageId: 'm-1' });
    await t.send({ to: '+15550000001', body: 'reply' });
    await t.requestLocation?.({ chatId: 'chat-1' });
    expect(capturedChatOps().map((o) => o.op)).toEqual(['chat_message', 'location_request']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('every chat-addressed door call (group sends, reactions, typing, cards, polls)', async () => {
    await door.sendLinqChatMessage({ chatId: 'c', text: 't' });
    await door.sendLinqParts({ chatId: 'c', parts: [{ type: 'text', value: 't' }] });
    await door.sendLinqEffect({ chatId: 'c', text: 't', effect: { type: 'bubble', name: 'slam' } });
    await door.reactToLinqMessage({ messageId: 'm', operation: 'add', type: 'like' });
    await door.createLinqChat({ from: 'x', to: ['+15550000001'], text: 't' });
    await door.updateLinqGroupChat({ chatId: 'c', displayName: 'n' });
    await door.addLinqParticipant({ chatId: 'c', handle: '+15550000001' });
    await door.removeLinqParticipant({ chatId: 'c', handle: '+15550000001' });
    await door.shareLinqContactCard({ chatId: 'c' });
    await door.setupLinqContactCard({ phoneNumber: 'p', firstName: 'f', imageUrl: 'https://i' });
    await door.patchLinqContactCard({ phoneNumber: 'p', firstName: 'f', imageUrl: 'https://i' });
    const poll = await door.sendLinqPoll({ chatId: 'c', options: ['a', 'b'] });
    expect(poll.options.map((o) => o.text)).toEqual(['a', 'b']);
    await door.markLinqChatRead({ chatId: 'c' });
    await door.startLinqTyping({ chatId: 'c' });
    await door.stopLinqTyping({ chatId: 'c' });
    expect(capturedChatOps()).toHaveLength(15);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses beside a configured Linq key, before any network call', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    await expect(door.sendLinqChatMessage({ chatId: 'c', text: 't' })).rejects.toBeInstanceOf(
      PreviewCaptureRefused,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses outside preview', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    await expect(
      door.reactToLinqMessage({ messageId: 'm', operation: 'add', type: 'like' }),
    ).rejects.toBeInstanceOf(PreviewCaptureRefused);
  });
});

describe('capture off: the door is the same Linq call', () => {
  it('sendLinqChatMessage hits the same Linq endpoint', async () => {
    vi.stubEnv('PREVIEW_CAPTURE_TRANSPORT', '');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const f = vi.fn(
      async () => new Response(JSON.stringify({ message: { id: 'msg-1' } }), { status: 201 }),
    );
    const out = await door.sendLinqChatMessage({ chatId: 'chat-1', text: 'hi', fetch: f as never });
    expect(out.providerMessageId).toBe('msg-1');
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe(
      'https://api.linqapp.com/api/partner/v3/chats/chat-1/messages',
    );
    expect(capturedChatOps()).toHaveLength(0);
  });
});
