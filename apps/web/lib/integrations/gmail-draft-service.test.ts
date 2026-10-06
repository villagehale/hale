import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  type GmailDraftDeps,
  type GmailDraftRequest,
  commitGmailDraft,
  gateGmailDraft,
  replyContextFromMessage,
  replySubject,
  replyToAddress,
  selectGmailConnection,
} from './gmail-draft-service';
import { GMAIL_COMPOSE_SCOPE } from './google-write-flag';

const READONLY = 'https://www.googleapis.com/auth/gmail.readonly';

function request(overrides: Partial<GmailDraftRequest> = {}): GmailDraftRequest {
  return {
    familyId: 'fam',
    actorUserId: 'user-a',
    operation: 'create',
    body: 'We can make Thursday.',
    about: 'swim',
    ...overrides,
  };
}

function deps(overrides: Partial<GmailDraftDeps> = {}): GmailDraftDeps {
  return {
    flagOn: true,
    listGmail: async () => [
      {
        id: 'int-a',
        userId: 'user-a',
        scopes: [READONLY, GMAIL_COMPOSE_SCOPE],
        draftIds: ['draft-1'],
      },
    ],
    accessToken: async () => 'tok',
    loadReply: async () => ({
      threadId: 'thr-1',
      to: 'coach@camp.example',
      subject: 'Re: Thursday swim',
      inReplyTo: '<msg-1@mail.gmail.com>',
      references: '<msg-1@mail.gmail.com>',
    }),
    writeDraft: async () => ({ draftId: 'draft-2' }),
    rememberDraft: async () => {},
    audit: async () => {},
    ...overrides,
  };
}

describe('Gmail draft service', () => {
  it('does not open a mailbox when the flag is off', async () => {
    const listGmail = vi.fn();
    const report = await gateGmailDraft(request(), deps({ flagOn: false, listGmail }));
    expect(report).toEqual({ status: 'skipped', reason: 'flag_off' });
    expect(listGmail).not.toHaveBeenCalled();
  });

  it('names a missing compose scope and does not write', async () => {
    const writeDraft = vi.fn();
    const report = await commitGmailDraft(
      request(),
      deps({
        writeDraft,
        listGmail: async () => [
          { id: 'int-a', userId: 'user-a', scopes: [READONLY], draftIds: [] },
        ],
      }),
    );
    expect(report).toEqual({ status: 'skipped', reason: 'scope_missing' });
    expect(writeDraft).not.toHaveBeenCalled();
    expect(
      selectGmailConnection({
        actorUserId: 'user-a',
        connections: [],
      }),
    ).toEqual({ ok: false, reason: 'not_connected' });
  });

  it('creates, updates, and deletes only a draft Hale stored', async () => {
    const writes: string[] = [];
    const remembered: string[] = [];
    const harness = deps({
      writeDraft: async (args) => {
        writes.push(args.operation);
        if (args.operation !== 'delete') {
          expect(args.message?.inReplyTo).toBe('<msg-1@mail.gmail.com>');
          expect(args.message?.threadId).toBe('thr-1');
        }
        if (args.operation === 'create') {
          expect(args.message?.body).toContain('Thursday');
        }
        return { draftId: args.draftId ?? 'draft-2' };
      },
      rememberDraft: async (_id, draftId, operation) => {
        remembered.push(`${operation}:${draftId}`);
      },
    });

    expect(await gateGmailDraft(request(), harness)).toEqual({ status: 'proceed' });
    expect(await commitGmailDraft(request(), harness)).toEqual({
      status: 'drafted',
      draftId: 'draft-2',
      operation: 'create',
    });
    expect(
      await commitGmailDraft(
        request({ operation: 'update', draftId: 'draft-1', body: 'Updated.' }),
        harness,
      ),
    ).toMatchObject({ status: 'drafted', operation: 'update' });
    expect(
      await commitGmailDraft(
        request({ operation: 'delete', draftId: 'draft-1', body: undefined }),
        harness,
      ),
    ).toMatchObject({ status: 'drafted', operation: 'delete' });
    expect(writes).toEqual(['create', 'update', 'delete']);
    expect(remembered).toEqual(['create:draft-2', 'update:draft-1', 'delete:draft-1']);

    const foreign = await commitGmailDraft(
      request({ operation: 'delete', draftId: 'someone-elses', body: undefined }),
      harness,
    );
    expect(foreign).toEqual({ status: 'skipped', reason: 'not_ours' });
  });

  it('builds a reply context from Gmail metadata headers', () => {
    expect(replyToAddress('Coach Kim <coach@camp.example>')).toBe('coach@camp.example');
    expect(replySubject('Thursday swim')).toBe('Re: Thursday swim');
    expect(replySubject('Re: Thursday swim')).toBe('Re: Thursday swim');
    expect(
      replyContextFromMessage({
        threadId: 'thr-1',
        payload: {
          headers: [
            { name: 'From', value: 'Camp <coach@camp.example>' },
            { name: 'Subject', value: 'Thursday swim' },
            { name: 'Message-ID', value: '<msg-1@mail.gmail.com>' },
            { name: 'References', value: '<msg-0@mail.gmail.com>' },
          ],
        },
      }),
    ).toEqual({
      threadId: 'thr-1',
      to: 'coach@camp.example',
      subject: 'Re: Thursday swim',
      inReplyTo: '<msg-1@mail.gmail.com>',
      references: '<msg-0@mail.gmail.com> <msg-1@mail.gmail.com>',
    });
  });

  it('has no Gmail send path in the draft service or the scopes it requests', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const files = [
      join(here, 'gmail-draft-service.ts'),
      join(here, 'google-oauth.ts'),
      join(here, 'google-write-flag.ts'),
      join(here, '../../../../apps/worker/src/services/gmail-drafts.ts'),
    ];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, file).not.toContain('gmail.send');
      expect(code, file).not.toContain('https://www.googleapis.com/auth/gmail.send');
      expect(code, file).not.toContain('messages/send');
      expect(code, file).not.toContain('drafts/send');
    }
  });
});
