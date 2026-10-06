import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  type GmailDraftFetch,
  buildDraftMime,
  createGmailDraft,
  deleteGmailDraft,
  encodeDraftRaw,
  updateGmailDraft,
} from './gmail-drafts.js';

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === null ? '' : JSON.stringify(body)),
  };
}

const message = {
  to: 'coach@camp.example',
  subject: 'Re: Thursday swim',
  body: 'We can make Thursday.',
  threadId: 'thr-1',
  inReplyTo: '<msg-1@mail.gmail.com>',
  references: '<msg-0@mail.gmail.com> <msg-1@mail.gmail.com>',
};

describe('Gmail drafts', () => {
  it('creates a draft reply and never a send', async () => {
    const fetchImpl = vi.fn<GmailDraftFetch>(async () => jsonResponse(200, { id: 'draft-1' }));
    const result = await createGmailDraft('tok', message, fetchImpl);
    expect(result).toEqual({ draftId: 'draft-1' });
    const call = fetchImpl.mock.calls[0];
    expect(call?.[0]).toBe('https://gmail.googleapis.com/gmail/v1/users/me/drafts');
    expect(String(call?.[0])).not.toMatch(/\/(messages|drafts)\/send/);
    expect(call?.[1].method).toBe('POST');
    const body = JSON.parse(String(call?.[1].body)) as {
      message: { raw: string; threadId: string };
    };
    expect(body.message.threadId).toBe('thr-1');
    const mime = Buffer.from(body.message.raw, 'base64url').toString('utf8');
    expect(mime).toContain('In-Reply-To: <msg-1@mail.gmail.com>');
    expect(mime).toContain('References: <msg-0@mail.gmail.com> <msg-1@mail.gmail.com>');
    expect(mime).toContain('To: coach@camp.example');
    expect(mime).toContain('We can make Thursday.');
  });

  it('updates and deletes by draft id', async () => {
    const fetchImpl = vi.fn<GmailDraftFetch>(async (_url, init) => {
      if (init.method === 'DELETE') return jsonResponse(204, null);
      return jsonResponse(200, { id: 'draft-2' });
    });
    await updateGmailDraft('tok', 'draft-2', message, fetchImpl);
    await deleteGmailDraft('tok', 'draft-2', fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://gmail.googleapis.com/gmail/v1/users/me/drafts/draft-2',
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('PUT');
    expect(fetchImpl.mock.calls[1]?.[1]?.method).toBe('DELETE');
    for (const call of fetchImpl.mock.calls) {
      expect(String(call[0])).not.toMatch(/send/);
    }
  });

  it('strips newlines out of headers before they can become a second header', () => {
    const mime = buildDraftMime({
      to: 'a@b.example\r\nBcc: evil@example',
      subject: 'Hi',
      body: 'ok',
    });
    expect(mime.startsWith('To: a@b.example Bcc: evil@example\r\n')).toBe(true);
    expect(mime).not.toMatch(/^Bcc:/m);
    expect(encodeDraftRaw(mime).length).toBeGreaterThan(0);
  });

  it('has no Gmail send path in this module', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'gmail-drafts.ts'),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toContain('gmail.send');
    expect(code).not.toContain('https://www.googleapis.com/auth/gmail.send');
    expect(code).not.toContain('messages/send');
    expect(code).not.toContain('drafts/send');
    expect(code).not.toContain('users/me/messages');
  });
});
