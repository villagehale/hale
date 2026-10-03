import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReplyRoute } from '~/lib/channel/router/reply-route';
import {
  LINQ_TYPING_SHOW_DELAY_MS,
  armDelayedImessageTyping,
  signalImessageTyping,
} from './presence';

const CHAT = '8f392755-6865-4b18-880a-227f9d8b458f';
const IMESSAGE: ReplyRoute = {
  channel: 'imessage',
  to: '+12025559876',
  chatId: CHAT,
  replyToMessageId: null,
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('signalImessageTyping', () => {
  it('does not call Linq for an SMS route', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.fn();
    await signalImessageTyping({ channel: 'sms', to: '+12025559876' }, 'start', { warn });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs a named miss and does not throw when the key is absent', async () => {
    vi.stubEnv('LINQ_API_KEY', '');
    const warn = vi.fn();
    await expect(signalImessageTyping(IMESSAGE, 'stop', { warn })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ phase: 'stop', outcome: 'not_configured' });
    expect(String(warn.mock.calls[0]?.[1])).toContain('did not stop');
  });
});

describe('armDelayedImessageTyping', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not call Linq for SMS or a chat with no id', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.fn();
    const sms = armDelayedImessageTyping({ channel: 'sms', chatId: CHAT, log: { warn } });
    const missing = armDelayedImessageTyping({ channel: 'imessage', chatId: null, log: { warn } });
    await sms.stop();
    await missing.stop();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('waits before starting, and a stop inside the delay never paints the bubble', async () => {
    vi.useFakeTimers();
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.fn();
    const typing = armDelayedImessageTyping({
      channel: 'imessage',
      chatId: CHAT,
      log: { warn },
    });
    await vi.advanceTimersByTimeAsync(LINQ_TYPING_SHOW_DELAY_MS - 1);
    expect(fetchMock).not.toHaveBeenCalled();
    await typing.stop();
    await vi.advanceTimersByTimeAsync(LINQ_TYPING_SHOW_DELAY_MS);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('starts after the delay and stops without throwing when Linq refuses', async () => {
    vi.useFakeTimers();
    vi.stubEnv('LINQ_API_KEY', '');
    const warn = vi.fn();
    const typing = armDelayedImessageTyping({
      channel: 'imessage',
      chatId: CHAT,
      log: { warn },
    });
    await vi.advanceTimersByTimeAsync(LINQ_TYPING_SHOW_DELAY_MS);
    await typing.stop();
    expect(warn.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'start', outcome: 'not_configured' }),
        expect.objectContaining({ phase: 'stop', outcome: 'not_configured' }),
      ]),
    );
  });
});
