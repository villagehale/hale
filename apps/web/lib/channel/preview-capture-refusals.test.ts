import { afterEach, describe, expect, it, vi } from 'vitest';
import { gmailEmailSender } from '~/lib/integrations/gmail-send-service';
import { LinqSendError, sendLinqChatMessage } from './linq/transport';

/**
 * VIL-466 · while a Preview capture run is on, the sends the capture transport does
 * not own are refused before any network call: every direct Linq partner call (group
 * chats, tapbacks, polls) and email from the parent's Gmail.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('preview capture refuses what it does not capture', () => {
  it('refuses a direct Linq chat send, even with a key set, before any fetch', async () => {
    vi.stubEnv('PREVIEW_CAPTURE_TRANSPORT', 'on');
    vi.stubEnv('LINQ_API_KEY', 'configured');
    const fetch = vi.fn();
    const err = await sendLinqChatMessage({ chatId: 'group-1', text: 'x', fetch }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LinqSendError);
    expect((err as LinqSendError).code).toBe('preview_capture');
    expect((err as LinqSendError).permanent).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('leaves Linq untouched when capture is off', async () => {
    vi.stubEnv('PREVIEW_CAPTURE_TRANSPORT', '');
    vi.stubEnv('LINQ_API_KEY', 'configured');
    const fetch = vi.fn(async () => Response.json({ message: { id: 'm1' } }));
    await sendLinqChatMessage({ chatId: 'c', text: 'x', fetch }).catch(() => {});
    expect(fetch).toHaveBeenCalled();
  });

  it('refuses email from the parent Gmail during a capture run', async () => {
    const send = vi.fn();
    const sender = gmailEmailSender({
      listGmail: vi.fn(),
      accessToken: vi.fn(),
      flagOn: () => true,
      send,
      previewCapture: () => true,
    });
    await expect(
      sender({ to: 'a@example.test', subject: 's', body: 'b' }, {
        actorUserId: 'u',
        familyId: 'f',
      } as never),
    ).rejects.toThrow(/HALE_NOT_CONFIGURED/);
    expect(send).not.toHaveBeenCalled();
  });
});
