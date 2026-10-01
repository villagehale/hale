import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@hale/db';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { deliverFamilyOutbound } from '~/lib/channel/linq/family-outbound';
import { LinqSendError } from '~/lib/channel/linq/transport';
import { TwilioSendError } from '~/lib/channel/twilio/transport';
import {
  createOutboundTransport,
  plainTextWithoutLinks,
  readSendRefusal,
  refusalStopsRetry,
  sendResolvingNewChat,
} from './outbound-transport';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const ALLOWED_TWILIO_CONSTRUCTORS = new Set([
  'apps/web/lib/channel/outbound-transport.ts',
  'apps/web/lib/channel/twilio/transport.ts',
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.next') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx|mjs|js)$/.test(name)) continue;
    if (name.includes('.test.') || name.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out;
}

describe('createTwilioTransport stays behind the one factory', () => {
  it('no non-test file under apps/web constructs it except the factory and the definition', () => {
    const root = join(REPO_ROOT, 'apps/web');
    expect(existsSync(root)).toBe(true);
    const strangers = sourceFiles(root)
      .map((file) => file.slice(REPO_ROOT.length + 1))
      .filter((file) =>
        readFileSync(join(REPO_ROOT, file), 'utf8').includes('createTwilioTransport('),
      )
      .filter((file) => !ALLOWED_TWILIO_CONSTRUCTORS.has(file));
    expect(strangers).toEqual([]);
  });
});

describe('readSendRefusal', () => {
  it('classifies Linq and Twilio refusals by the permanent flag', () => {
    expect(readSendRefusal(new LinqSendError('1005', 400, true))).toEqual({
      code: '1005',
      permanent: true,
    });
    expect(readSendRefusal(new LinqSendError('timeout', 0, false))).toEqual({
      code: 'timeout',
      permanent: false,
    });
    expect(readSendRefusal(new LinqSendError('not_configured', 0, true))).toEqual({
      code: 'not_configured',
      permanent: true,
    });
    expect(readSendRefusal(new LinqSendError('link_on_new_chat', 400, true))).toEqual({
      code: 'link_on_new_chat',
      permanent: true,
    });
    expect(readSendRefusal(new LinqSendError('media_on_new_chat', 400, true))).toEqual({
      code: 'media_on_new_chat',
      permanent: true,
    });
    expect(readSendRefusal(new TwilioSendError('21610', 400))).toEqual({
      code: '21610',
      permanent: true,
    });
    expect(readSendRefusal(new TwilioSendError('20500', 503))).toEqual({
      code: '20500',
      permanent: false,
    });
    expect(readSendRefusal(new Error('nope'))).toBeNull();
  });

  it('stops retry on a permanent refusal and not on not_configured or a transient one', () => {
    expect(refusalStopsRetry(new LinqSendError('link_on_new_chat', 400, true))).toBe(true);
    expect(refusalStopsRetry(new TwilioSendError('21610', 400))).toBe(true);
    expect(refusalStopsRetry(new LinqSendError('not_configured', 0, true))).toBe(false);
    expect(refusalStopsRetry(new LinqSendError('timeout', 0, false))).toBe(false);
    expect(refusalStopsRetry(new Error('nope'))).toBe(false);
  });
});

describe('createOutboundTransport', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses Twilio only when OUTBOUND_TRANSPORT is exactly twilio', async () => {
    vi.stubEnv('OUTBOUND_TRANSPORT', 'twilio');
    vi.stubEnv('LINQ_API_KEY', '');
    vi.stubEnv('LINQ_FROM_E164', '');
    const fetchMock = vi.fn();
    const transport = createOutboundTransport({ fetch: fetchMock });
    await expect(transport.send({ to: '+14165550100', body: 'hi' })).rejects.toThrow(
      /twilio not configured/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not treat a near-miss kill switch as Twilio, and names a dark Linq door', async () => {
    const fetchMock = vi.fn();
    for (const value of [undefined, 'Twilio', 'twilio '] as const) {
      if (value === undefined) vi.stubEnv('OUTBOUND_TRANSPORT', '');
      else vi.stubEnv('OUTBOUND_TRANSPORT', value);
      vi.stubEnv('LINQ_API_KEY', '');
      vi.stubEnv('LINQ_FROM_E164', '');
      const transport = createOutboundTransport({ fetch: fetchMock });
      await expect(transport.send({ to: '+14165550100', body: 'hi' })).rejects.toMatchObject({
        code: 'not_configured',
        permanent: true,
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('plainTextWithoutLinks', () => {
  it('strips the URL and keeps the STOP line', () => {
    expect(
      plainTextWithoutLinks('A spot opened https://example.com/spot\nReply STOP to opt out.'),
    ).toBe('A spot opened\nReply STOP to opt out.');
  });

  it('is empty when the body is only a URL', () => {
    expect(plainTextWithoutLinks('https://example.com/only')).toBe('');
  });
});

describe('sendResolvingNewChat', () => {
  it('sends the plain-text version once when a new chat cannot take a link', async () => {
    const bodies: string[] = [];
    const transport: ChannelTransport = {
      async send(input) {
        bodies.push(input.body);
        if (/https?:\/\//.test(input.body)) throw new LinqSendError('link_on_new_chat', 400, true);
        return { providerMessageId: 'plain-1', transport: 'imessage', chatId: 'chat-1' };
      },
    };
    const sent = await sendResolvingNewChat(transport, {
      to: '+14165550100',
      body: 'See https://example.com/x\nReply STOP to opt out.',
    });
    expect(sent).toMatchObject({
      providerMessageId: 'plain-1',
      transport: 'imessage',
      linkOmitted: 'link_on_new_chat',
    });
    expect(bodies).toEqual([
      'See https://example.com/x\nReply STOP to opt out.',
      'See\nReply STOP to opt out.',
    ]);
    expect(bodies[1]).not.toMatch(/https?:\/\//);
    expect(bodies[1]).toContain('Reply STOP to opt out.');
  });

  it('does not drop media, and rethrows not_configured', async () => {
    const transport: ChannelTransport = {
      async send() {
        throw new LinqSendError('media_on_new_chat', 400, true);
      },
    };
    await expect(
      sendResolvingNewChat(transport, {
        to: '+14165550100',
        body: 'card',
        mediaUrls: ['https://example.com/hale.vcf'],
      }),
    ).rejects.toMatchObject({ code: 'media_on_new_chat' });

    const dark: ChannelTransport = {
      async send() {
        throw new LinqSendError('not_configured', 0, true);
      },
    };
    await expect(
      sendResolvingNewChat(dark, { to: '+14165550100', body: 'https://example.com/x' }),
    ).rejects.toMatchObject({ code: 'not_configured', permanent: true });
  });
});

describe('deliverFamilyOutbound legacy skip', () => {
  const database = {} as Database;

  it('ledgers the plain-text send when the new chat cannot take a link', async () => {
    const transport: ChannelTransport = {
      async send(input) {
        if (/https?:\/\//.test(input.body)) throw new LinqSendError('link_on_new_chat', 400, true);
        return { providerMessageId: 'plain-1', transport: 'imessage', chatId: 'chat-1' };
      },
    };
    const delivered = await deliverFamilyOutbound(database, {
      familyId: 'fam',
      body: 'See https://example.com/x\nReply STOP to opt out.',
      to: '+14165550100',
      legacy: transport,
      target: { channel: 'legacy' },
    });
    expect(delivered).toMatchObject({
      status: 'sent',
      providerMessageId: 'plain-1',
      channel: 'imessage',
      chatId: 'chat-1',
      linkOmitted: 'link_on_new_chat',
    });
  });

  it('names a permanent media refusal and a dark door, and rethrows a transient one', async () => {
    const media: ChannelTransport = {
      async send() {
        throw new LinqSendError('media_on_new_chat', 400, true);
      },
    };
    await expect(
      deliverFamilyOutbound(database, {
        familyId: 'fam',
        body: 'card',
        to: '+14165550100',
        legacy: media,
        target: { channel: 'legacy' },
        mediaUrls: ['https://example.com/hale.vcf'],
      }),
    ).resolves.toEqual({ status: 'skipped', reason: 'media_on_new_chat' });

    const dark: ChannelTransport = {
      async send() {
        throw new LinqSendError('not_configured', 0, true);
      },
    };
    await expect(
      deliverFamilyOutbound(database, {
        familyId: 'fam',
        body: 'hello',
        to: '+14165550100',
        legacy: dark,
        target: { channel: 'legacy' },
      }),
    ).resolves.toEqual({ status: 'skipped', reason: 'not_configured' });

    const transient: ChannelTransport = {
      async send() {
        throw new LinqSendError('timeout', 0, false);
      },
    };
    await expect(
      deliverFamilyOutbound(database, {
        familyId: 'fam',
        body: 'hello',
        to: '+14165550100',
        legacy: transient,
        target: { channel: 'legacy' },
      }),
    ).rejects.toMatchObject({ code: 'timeout', permanent: false });
  });
});
