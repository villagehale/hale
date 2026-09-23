import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReplyRoute } from '~/lib/channel/router/reply-route';
import { signalImessageTyping } from './presence';

const CHAT = '8f392755-6865-4b18-880a-227f9d8b458f';
const IMESSAGE: ReplyRoute = { channel: 'imessage', to: '+12025559876', chatId: CHAT };

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
