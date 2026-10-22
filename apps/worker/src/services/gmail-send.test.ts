import { describe, expect, it, vi } from 'vitest';
import { GmailSendApiError, buildSendMime, sendGmailMessage } from './gmail-send.js';

function decodeRaw(init: RequestInit): string {
  const { raw } = JSON.parse(String(init.body)) as { raw: string };
  return Buffer.from(raw, 'base64url').toString('utf8');
}

describe('buildSendMime', () => {
  it('writes To, Cc and Subject headers and a CRLF body', () => {
    const mime = buildSendMime({
      to: 'clinic@example.com',
      cc: ['co@example.com', 'other@example.com'],
      subject: 'Hi',
      body: 'line one\nline two',
    });
    expect(mime).toBe(
      'To: clinic@example.com\r\nCc: co@example.com, other@example.com\r\nSubject: Hi\r\n' +
        'MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nline one\r\nline two',
    );
  });

  it('cannot be header-injected through the subject', () => {
    const mime = buildSendMime({ to: 'a@b.com', subject: 'Hi\r\nBcc: x@evil.com', body: 'b' });
    expect(mime).not.toMatch(/\r\nBcc:/);
  });
});

describe('sendGmailMessage', () => {
  it('posts the raw message to users.messages.send and returns the Gmail id', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 'gm-1', threadId: 't-1' }),
    }));

    const result = await sendGmailMessage(
      'token-1',
      { to: 'clinic@example.com', subject: 'Hi', body: 'hello' },
      fetchImpl,
    );

    expect(result).toEqual({ messageId: 'gm-1' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer token-1');
    expect(decodeRaw(init)).toContain('To: clinic@example.com');
  });

  it('throws on a non-200 answer rather than reporting a send', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, text: async () => '' }));
    await expect(
      sendGmailMessage('t', { to: 'a@b.com', subject: 's', body: 'b' }, fetchImpl),
    ).rejects.toBeInstanceOf(GmailSendApiError);
  });
});
