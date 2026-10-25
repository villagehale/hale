import { describe, expect, it, vi } from 'vitest';
import { GMAIL_COMPOSE_SCOPE } from './google-write-flag';
import { type GmailSendReaders, gmailEmailSender } from './gmail-send-service';

const FAMILY = 'fam-1';
const PARENT = 'parent-1';
const payload = { to: 'clinic@example.com', subject: 'Hi', body: 'hello', cc: ['co@example.com'] };

function readers(over: Partial<GmailSendReaders> = {}): GmailSendReaders {
  return {
    flagOn: () => true,
    listGmail: async () => [
      { id: 'int-other', userId: 'someone-else', scopes: [GMAIL_COMPOSE_SCOPE], draftIds: [] },
      { id: 'int-1', userId: PARENT, scopes: [GMAIL_COMPOSE_SCOPE], draftIds: [] },
    ],
    accessToken: async () => 'token-1',
    send: vi.fn(async () => ({ messageId: 'gm-1' })),
    ...over,
  };
}

describe('gmailEmailSender', () => {
  it("sends from the approving parent's own Gmail connection", async () => {
    const r = readers();
    const accessToken = vi.fn(async () => 'token-1');
    r.accessToken = accessToken;

    const result = await gmailEmailSender(r)(payload, { familyId: FAMILY, actorUserId: PARENT });

    expect(result.messageId).toBe('gm-1');
    expect(accessToken).toHaveBeenCalledWith('int-1');
    expect(r.send).toHaveBeenCalledWith('token-1', payload);
  });

  it('refuses an autonomous pass with no approving parent', async () => {
    const r = readers();
    await expect(
      gmailEmailSender(r)(payload, { familyId: FAMILY, actorUserId: null }),
    ).rejects.toThrow('HALE_NOT_CONFIGURED');
    expect(r.send).not.toHaveBeenCalled();
  });

  it('refuses when the write-scope flag is off for this parent', async () => {
    const r = readers({ flagOn: () => false });
    await expect(
      gmailEmailSender(r)(payload, { familyId: FAMILY, actorUserId: PARENT }),
    ).rejects.toThrow('HALE_NOT_CONFIGURED');
    expect(r.send).not.toHaveBeenCalled();
  });

  it("never sends from a co-parent's mailbox when the approver has none", async () => {
    const r = readers({
      listGmail: async () => [
        { id: 'int-other', userId: 'someone-else', scopes: [GMAIL_COMPOSE_SCOPE], draftIds: [] },
      ],
    });
    await expect(
      gmailEmailSender(r)(payload, { familyId: FAMILY, actorUserId: PARENT }),
    ).rejects.toThrow('not_connected');
    expect(r.send).not.toHaveBeenCalled();
  });

  it('refuses a connection without the compose scope', async () => {
    const r = readers({
      listGmail: async () => [{ id: 'int-1', userId: PARENT, scopes: [], draftIds: [] }],
    });
    await expect(
      gmailEmailSender(r)(payload, { familyId: FAMILY, actorUserId: PARENT }),
    ).rejects.toThrow('scope_missing');
  });

  it('refuses when no access token can be had', async () => {
    const r = readers({ accessToken: async () => null });
    await expect(
      gmailEmailSender(r)(payload, { familyId: FAMILY, actorUserId: PARENT }),
    ).rejects.toThrow('token is unavailable');
    expect(r.send).not.toHaveBeenCalled();
  });
});
