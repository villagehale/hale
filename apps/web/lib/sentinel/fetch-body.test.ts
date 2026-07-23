import { describe, expect, it, vi } from 'vitest';
import type { GoogleFetch } from '~/lib/integrations/sync';
import { fetchGmailMessageBody } from './fetch-body';

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fakeGoogleFetch(json: unknown, ok = true, status = 200): GoogleFetch {
  return vi.fn().mockResolvedValue({ ok, status, json: async () => json }) as unknown as GoogleFetch;
}

describe('fetchGmailMessageBody', () => {
  it('extracts a top-level text/plain part', async () => {
    const googleFetch = fakeGoogleFetch({
      payload: { mimeType: 'text/plain', body: { data: b64url('Swim class cancelled Saturday.') } },
    });
    const body = await fetchGmailMessageBody('msg-1', 'token', googleFetch);
    expect(body).toBe('Swim class cancelled Saturday.');
  });

  it('finds a nested text/plain part under multipart/alternative, preferring it over html', async () => {
    const googleFetch = fakeGoogleFetch({
      payload: {
        mimeType: 'multipart/mixed',
        parts: [
          {
            mimeType: 'multipart/alternative',
            parts: [
              { mimeType: 'text/plain', body: { data: b64url('Plain version.') } },
              { mimeType: 'text/html', body: { data: b64url('<p>Html version.</p>') } },
            ],
          },
        ],
      },
    });
    const body = await fetchGmailMessageBody('msg-2', 'token', googleFetch);
    expect(body).toBe('Plain version.');
  });

  it('falls back to a tag-stripped text/html when no text/plain part exists', async () => {
    const googleFetch = fakeGoogleFetch({
      payload: {
        mimeType: 'multipart/alternative',
        parts: [{ mimeType: 'text/html', body: { data: b64url('<div><p>Class <b>cancelled</b>.</p></div>') } }],
      },
    });
    const body = await fetchGmailMessageBody('msg-3', 'token', googleFetch);
    expect(body).toBe('Class cancelled .');
  });

  it('returns an empty string when the message has no body data anywhere', async () => {
    const googleFetch = fakeGoogleFetch({ payload: { mimeType: 'multipart/mixed', parts: [] } });
    const body = await fetchGmailMessageBody('msg-4', 'token', googleFetch);
    expect(body).toBe('');
  });

  it('throws on a non-ok response', async () => {
    const googleFetch = fakeGoogleFetch({}, false, 404);
    await expect(fetchGmailMessageBody('msg-5', 'token', googleFetch)).rejects.toThrow(/404/);
  });

  it('requests format=full for the given message id', async () => {
    const googleFetch = fakeGoogleFetch({ payload: { mimeType: 'text/plain', body: { data: b64url('x') } } });
    await fetchGmailMessageBody('msg-6', 'token-abc', googleFetch);
    expect(googleFetch).toHaveBeenCalledWith(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-6?format=full',
      'token-abc',
    );
  });
});
