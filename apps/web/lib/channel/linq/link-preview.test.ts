import { schema } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeFakeDb } from '~/lib/channel/intake/fakes';
import { type ChannelTransport, FakeTransport } from '~/lib/channel/intake/transport';
import { liftPreviewLink, sendLinkOnce } from './link-preview';
import { LinqSendError } from './transport';

const URL = 'https://app.example.com/connect?t=abc';
const FAMILY = '00000000-0000-4000-8000-0000000000f1';
const PARENT = '00000000-0000-4000-8000-0000000000a1';
const PHONE = '+15555550101';
const NOW = new Date('2026-09-17T12:00:00.000Z');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('liftPreviewLink', () => {
  it('lifts the one link out of the text', () => {
    expect(liftPreviewLink(`Here is the calendar link\n${URL}`)).toEqual({
      text: 'Here is the calendar link',
      url: URL,
    });
    expect(liftPreviewLink(`Tap ${URL} to connect.`)).toEqual({
      text: 'Tap to connect.',
      url: URL,
    });
  });

  it('leaves a body alone when lifting would change what it says', () => {
    // Two links: lifting one would orphan the sentence that names it.
    expect(liftPreviewLink(`Swim ${URL} and art https://example.org/art`)).toBeNull();
    // A policy page is never a preview.
    expect(liftPreviewLink('Our privacy page: https://app.example.com/privacy')).toBeNull();
    // Nothing would be left to say.
    expect(liftPreviewLink(URL)).toBeNull();
    expect(liftPreviewLink('No link here.')).toBeNull();
  });
});

describe('sendLinkOnce', () => {
  function ledger(fake: ReturnType<typeof makeFakeDb>) {
    return {
      rows: fake.writes.filter((w) => w.table === schema.channelMessages).map((w) => w.payload),
      audits: fake.writes.filter((w) => w.table === schema.auditLog).map((w) => w.payload),
    };
  }

  function linqFetch(status: number) {
    return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      status === 201
        ? Response.json({ message: { id: 'link-1' } }, { status })
        : Response.json({ error: { code: 2001 } }, { status }),
    );
  }

  function base(transport: ChannelTransport, fake: ReturnType<typeof makeFakeDb>) {
    return {
      transport,
      to: PHONE,
      url: URL,
      database: fake.db,
      familyId: FAMILY,
      parentUserId: PARENT,
      now: NOW,
    };
  }

  it('sends the preview bubble and no text on iMessage', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    const fetchMock = linqFetch(201);

    const outcome = await sendLinkOnce({
      ...base(transport, fake),
      channel: 'imessage',
      chatId: 'chat-1',
      fetch: fetchMock,
    });

    expect(outcome).toEqual({ status: 'preview', providerMessageId: 'link-1' });
    expect(transport.sent).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ledger(fake).rows).toEqual([
      expect.objectContaining({ templateKey: 'linq:link_preview' }),
    ]);
  });

  it('sends the link as its own text when the preview is refused, and records it', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const outcome = await sendLinkOnce({
      ...base(transport, fake),
      channel: 'imessage',
      chatId: 'chat-1',
      fetch: linqFetch(400),
    });

    expect(outcome).toEqual({ status: 'text', why: 'refused', providerMessageId: 'fake-out-1' });
    expect(transport.bodies()).toEqual([URL]);
    const { rows, audits } = ledger(fake);
    expect(rows).toEqual([
      expect.objectContaining({ templateKey: 'linq:link_text', providerMessageId: 'fake-out-1' }),
    ]);
    expect(audits).toEqual([expect.objectContaining({ actionTaken: 'sms_reply_sent' })]);
    expect(warn.mock.calls.some((call) => JSON.stringify(call).includes(URL))).toBe(false);
    warn.mockRestore();
  });

  it('sends the link as its own text off iMessage', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();

    const outcome = await sendLinkOnce({ ...base(transport, fake), channel: 'sms', chatId: null });

    expect(outcome).toEqual({
      status: 'text',
      why: 'not_imessage',
      providerMessageId: 'fake-out-1',
    });
    expect(transport.bodies()).toEqual([URL]);
  });

  it('names the failure when neither the preview nor the text goes', async () => {
    const fake = makeFakeDb();
    const transport: ChannelTransport = {
      async send() {
        throw new LinqSendError('21610', 400, true);
      },
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const outcome = await sendLinkOnce({ ...base(transport, fake), channel: 'sms', chatId: null });

    expect(outcome).toEqual({ status: 'not_sent', why: 'not_imessage', code: '21610' });
    expect(ledger(fake).rows).toEqual([]);
    error.mockRestore();
  });
});
