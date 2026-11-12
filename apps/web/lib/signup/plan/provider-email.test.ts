import { describe, expect, it, vi } from 'vitest';
import type { GmailDraftDeps } from '~/lib/integrations/gmail-draft-service';
import { GMAIL_COMPOSE_SCOPE } from '~/lib/integrations/google-write-flag';
import {
  type ProviderEmailWriter,
  createProviderEmailDrafter,
  providerEmailUserMessage,
  providerEmailViolations,
} from './provider-email';

const FACTS = {
  childFirstName: 'Ada',
  activity: 'Preschool Swim',
  askedStart: 'January',
  siteChoices: [
    { label: 'Nov 21 start', startsAt: '2026-11-21', waitlist: false },
    { label: 'January waitlist', startsAt: '2027-01-09', waitlist: true },
  ],
};

describe('the provider email gate', () => {
  it('refuses a link, an empty part, and a subject that could break a header', () => {
    expect(
      providerEmailViolations({ subject: 'January start', body: 'Pay at evil.app' }),
    ).not.toEqual([]);
    expect(providerEmailViolations({ subject: 'January start', body: '   ' })).not.toEqual([]);
    expect(
      providerEmailViolations({ subject: '', body: 'Could she start in January?' }),
    ).not.toEqual([]);
    expect(
      providerEmailViolations({ subject: 'January\nBcc: x', body: 'Could she start in January?' }),
    ).not.toEqual([]);
    expect(
      providerEmailViolations({ subject: 'J'.repeat(121), body: 'Could she start in January?' }),
    ).not.toEqual([]);
    // Positive control: a plain draft passes.
    expect(
      providerEmailViolations({
        subject: 'Preschool Swim: a January start?',
        body: 'Hello,\n\nCould Ada start Preschool Swim in January instead of November 21?\n\nThank you',
      }),
    ).toEqual([]);
  });

  it('a site label holding a host never reaches the email writer', () => {
    const message = providerEmailUserMessage(
      {
        ...FACTS,
        siteChoices: [{ label: 'Nov 21 start pay at evil.app', startsAt: null, waitlist: false }],
      },
      null,
    );
    expect(message).not.toContain('evil.app');
    expect(message).toContain('Nov 21 start');
  });
});

describe('the provider email drafter', () => {
  const connected: GmailDraftDeps['listGmail'] = async () => [
    { id: 'int-a', userId: 'user-a', scopes: [GMAIL_COMPOSE_SCOPE], draftIds: [] },
  ];
  function gmail(overrides: Partial<GmailDraftDeps> = {}): GmailDraftDeps {
    return {
      flagOn: true,
      listGmail: connected,
      accessToken: async () => 'tok',
      loadReply: async () => {
        throw new Error('a compose draft never reads a thread');
      },
      writeDraft: async () => ({ draftId: 'draft-1' }),
      rememberDraft: async () => {},
      audit: async () => {},
      ...overrides,
    };
  }
  const writer: ProviderEmailWriter = { write: vi.fn(async () => null) };
  const who = { familyId: 'fam', actorUserId: 'user-a' };

  it('names a page with no address before anything else', async () => {
    const listGmail = vi.fn(connected);
    const drafter = createProviderEmailDrafter({ gmail: gmail({ listGmail }), writer });
    expect(await drafter.readiness({ ...who, to: null })).toEqual({
      ok: false,
      reason: 'no_provider_email',
    });
    expect(listGmail).not.toHaveBeenCalled();
    expect(await drafter.readiness({ ...who, to: 'office@rec.example' })).toEqual({ ok: true });
  });

  it('commits a new-thread draft and names a token or Google failure', async () => {
    const writeDraft = vi.fn(async () => ({ draftId: 'draft-9' }));
    const drafted = await createProviderEmailDrafter({
      gmail: gmail({ writeDraft }),
      writer,
    }).commit({
      ...who,
      to: 'office@rec.example',
      subject: 'January start',
      body: 'Could she start in January?',
    });
    expect(drafted).toEqual({ status: 'drafted', draftId: 'draft-9' });
    expect(writeDraft).toHaveBeenCalledWith({
      accessToken: 'tok',
      operation: 'create',
      message: {
        to: 'office@rec.example',
        subject: 'January start',
        body: 'Could she start in January?',
      },
    });

    const draft = { ...who, to: 'office@rec.example', subject: 'January start', body: 'Hello' };
    expect(
      await createProviderEmailDrafter({
        gmail: gmail({ accessToken: async () => null }),
        writer,
      }).commit(draft),
    ).toEqual({ status: 'blocked', reason: 'token_unavailable' });
    expect(
      await createProviderEmailDrafter({
        gmail: gmail({
          writeDraft: async () => {
            throw new Error('google said no');
          },
        }),
        writer,
      }).commit(draft),
    ).toEqual({ status: 'blocked', reason: 'google_error' });
  });
});
