import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as connectRoute } from '~/app/api/integrations/[provider]/connect/route';
import ConnectPage from '~/app/connect/page';
import { sessionProviders } from '~/auth';
import { redeemChannelLinkAction } from '~/lib/auth/channel-link-actions';
import { mintChannelSigninTokens } from '~/lib/auth/channel-signin';
import { requestClaimCode, verifyClaimCode } from '~/lib/auth/claim-by-phone';
import { CLAIM_CODE_ERROR, CLAIM_RATE_LIMIT } from '~/lib/auth/claim-phone-copy';
import { FakeOtpSender } from '~/lib/channels/otp-sender';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { setRateLimiterForTesting } from '~/lib/rate-limit/apply';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';

/**
 * A texted /connect link proves nothing about who is holding it: it can be forwarded,
 * or posted in a family group. These run the real channel-link provider, the real redeem
 * action and the real code storage on pglite. Only the outside world is replaced: the
 * text transport, and NextAuth's session plumbing around the provider.
 */

const h = vi.hoisted(() => {
  class Redirected extends Error {
    constructor(readonly url: string) {
      super('redirected');
    }
  }
  return {
    Redirected,
    database: null as unknown,
    session: null as { user: { id: string } } | null,
    sender: null as unknown,
    ip: '203.0.113.1',
    freshLink: vi.fn(),
  };
});

vi.mock('~/lib/db', () => ({ db: () => h.database }));
vi.mock('~/lib/auth-config', () => ({ authConfigured: () => true }));
vi.mock('~/lib/auth/claim-code-sender', () => ({ createClaimCodeSender: () => h.sender }));
vi.mock('~/lib/channel/connect/fresh-link', () => ({
  textFreshConnectorLink: (...args: unknown[]) => h.freshLink(...args),
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': h.ip }),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new h.Redirected(url);
  },
}));
vi.mock('next-auth/providers/credentials', () => ({
  default: (config: object) => ({ ...config, type: 'credentials' }),
}));
vi.mock('next-auth', () => {
  class AuthError extends Error {
    type = 'CredentialsSignin';
  }
  type Provider = { id: string; authorize: (raw: object) => Promise<{ id: string } | null> };
  return {
    AuthError,
    default: (config: { providers: Provider[] }) => ({
      handlers: {},
      auth: async () => h.session,
      signOut: async () => undefined,
      signIn: async (id: string, options: { redirectTo: string } & Record<string, unknown>) => {
        const provider = config.providers.find((candidate) => candidate.id === id);
        if (!provider) throw new Error(`no provider ${id}`);
        const { redirectTo, ...credentials } = options;
        const user = await provider.authorize(credentials);
        if (!user) throw new AuthError();
        h.session = { user: { id: user.id } };
        throw new h.Redirected(redirectTo);
      },
    }),
  };
});

const KEY = Buffer.alloc(32, 7).toString('base64');
const START = new Date('2026-11-23T15:01:00.000Z');
const COOLDOWN_PASSED_MS = 61_000;
const CODE_EXPIRED_MS = 10 * 60 * 1000 + 1_000;
const WRONG_CODE = '000000';
const APP_ORIGIN = 'https://app.example.test';

interface Parent {
  familyId: string;
  userId: string;
  phone: string;
  externalAuthId: string;
}

let seq = 0;

describe('a texted connect link needs a code', () => {
  let db: TestDb;
  let sender: FakeOtpSender;

  beforeAll(async () => {
    vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
    db = await createTestDb();
    h.database = db.database;
    setRateLimiterForTesting(undefined);
  });

  afterAll(async () => {
    setRateLimiterForTesting(undefined);
    await db.close();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: START });
    vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
    vi.stubEnv('CONNECT_LINK_CODE_ENABLED', 'true');
    sender = new FakeOtpSender();
    h.sender = sender;
    h.session = null;
    seq += 1;
    h.ip = `203.0.113.${seq}`;
    h.freshLink.mockReset();
    h.freshLink.mockResolvedValue('sent');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function seedParent(familyId?: string): Promise<Parent> {
    seq += 1;
    const phone = `+1416555${String(100 + (seq % 100)).padStart(4, '0')}`;
    const seeded = await seedFamily(db.database);
    const userId = seeded.parentUserId;
    let family = seeded.familyId;
    if (familyId) {
      await db.database.delete(schema.familyMembers).where(eq(schema.familyMembers.userId, userId));
      await db.database
        .insert(schema.familyMembers)
        .values({ familyId, userId, role: 'co_parent' });
      family = familyId;
    }
    const externalAuthId = `sms:${phoneBlindIndex(phone)}`;
    await db.database
      .update(schema.users)
      .set({ externalAuthId })
      .where(eq(schema.users.id, userId));
    await db.database.insert(schema.parentChannels).values({
      familyId: family,
      userId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(phone),
      phoneE164Hash: phoneBlindIndex(phone),
      verifiedAt: START,
    });
    return { familyId: family, userId, phone, externalAuthId };
  }

  async function mintLink(userId: string) {
    const [link] = await mintChannelSigninTokens(db.database, {
      userId,
      count: 1,
      now: new Date(),
    });
    if (!link) throw new Error('expected a link');
    return link;
  }

  async function tap(token: string, to: string | null, fields: Record<string, string> = {}) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    try {
      return { state: await redeemChannelLinkAction(token, to, { status: 'idle' }, form) };
    } catch (err) {
      if (err instanceof h.Redirected) return { redirect: err.url };
      throw err;
    }
  }

  function directPost(credentials: Record<string, string>) {
    const provider = sessionProviders.find((candidate) => candidate.id === 'channel-link') as
      | { authorize: (raw: object) => Promise<{ id: string } | null> }
      | undefined;
    if (!provider) throw new Error('channel-link provider missing');
    return provider.authorize(credentials);
  }

  function lastCode(): string {
    const code = sender.sent.at(-1)?.code;
    if (!code) throw new Error('no code was sent');
    return code;
  }

  function stubGoogleConsentEnv() {
    vi.stubEnv('APP_URL', APP_ORIGIN);
    vi.stubEnv('AUTH_SECRET', 'connect-link-code-test-secret');
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'test-client-id');
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'test-client-secret');
  }

  function openConsent(provider: string, tokenId: string) {
    return connectRoute(
      new Request(
        `${APP_ORIGIN}/api/integrations/${provider}/connect?from=text&link=${tokenId}`,
      ) as NextRequest,
      { params: Promise.resolve({ provider }) },
    );
  }

  function advance(ms: number) {
    vi.setSystemTime(new Date(Date.now() + ms));
  }

  describe('the chokepoint', () => {
    it('gives a direct POST with a valid token and no code no session', async () => {
      const parent = await seedParent();
      const link = await mintLink(parent.userId);

      expect(await directPost({ token: link.token })).toBeNull();
      expect(await directPost({ token: link.token, code: WRONG_CODE })).toBeNull();
    });

    it('still signs in on the token alone with the flag off', async () => {
      vi.stubEnv('CONNECT_LINK_CODE_ENABLED', '');
      const parent = await seedParent();
      const link = await mintLink(parent.userId);

      expect(await directPost({ token: link.token })).toEqual({
        id: parent.externalAuthId,
        email: null,
      });
      expect(sender.sent).toEqual([]);
    });

    it('stays off for a value that is not exactly true', async () => {
      vi.stubEnv('CONNECT_LINK_CODE_ENABLED', 'true\n');
      const parent = await seedParent();
      const link = await mintLink(parent.userId);

      expect(await directPost({ token: link.token })).toEqual({
        id: parent.externalAuthId,
        email: null,
      });
    });
  });

  describe('where the code goes', () => {
    it('texts only the number held for the user the token names, whatever the form says', async () => {
      const parent = await seedParent();
      const other = await seedParent();
      const link = await mintLink(parent.userId);

      const result = await tap(link.token, 'gcal', { phone: other.phone, to: other.phone });

      expect(result.state).toEqual({ status: 'code', message: null });
      expect(sender.sent.map((row) => row.phoneE164)).toEqual([parent.phone]);
      expect(JSON.stringify(result)).not.toContain(parent.phone);
    });

    it('keeps the number, the code and the token out of logs and audit rows', async () => {
      const lines: unknown[][] = [];
      for (const level of ['log', 'info', 'warn', 'error'] as const) {
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          lines.push(args);
        });
      }
      const parent = await seedParent();
      const link = await mintLink(parent.userId);

      await tap(link.token, 'gmail');
      const code = lastCode();
      await tap(link.token, 'gmail', { code: WRONG_CODE });
      await tap(link.token, 'gmail', { code });

      const audit = await db.database
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.familyId, parent.familyId));
      const sentRow = audit.find((row) => row.actionTaken === 'connector_link_code_sent');
      expect(sentRow?.audience).toBe(parent.userId);
      expect(sentRow?.targetId).toBe(link.tokenId);
      expect(lines.length).toBeGreaterThan(0);

      const written = JSON.stringify([lines, audit]);
      for (const secret of [parent.phone, code, link.token]) {
        expect(written).not.toContain(secret);
      }
    });
  });

  describe('opening the page', () => {
    it('sends nothing until the tap', async () => {
      const parent = await seedParent();
      const link = await mintLink(parent.userId);

      const html = renderToStaticMarkup(
        await ConnectPage({ searchParams: Promise.resolve({ t: link.token, to: 'gcal' }) }),
      );

      expect(html).toContain('your calendar');
      expect(html).not.toContain(link.token);
      expect(sender.sent).toEqual([]);
      const pending = await db.database
        .select()
        .from(schema.phoneVerifications)
        .where(eq(schema.phoneVerifications.userId, parent.userId));
      expect(pending).toEqual([]);

      await tap(link.token, 'gcal');
      expect(sender.sent).toHaveLength(1);
    });
  });

  describe('the right code', () => {
    it('signs in exactly that user and continues to the same Google consent', async () => {
      const parent = await seedParent();
      const link = await mintLink(parent.userId);

      await tap(link.token, 'gcal');
      const result = await tap(link.token, 'gcal', { code: lastCode() });

      expect(result.redirect).toBe(`/api/integrations/gcal/connect?from=text&link=${link.tokenId}`);
      expect(h.session?.user.id).toBe(parent.externalAuthId);
      const signedIn = await db.database
        .select()
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.familyId, parent.familyId),
            eq(schema.auditLog.actionTaken, 'connector_link_signed_in'),
          ),
        );
      expect(signedIn.map((row) => row.targetId)).toEqual([link.tokenId]);

      stubGoogleConsentEnv();
      const consent = await openConsent('gcal', link.tokenId);
      expect(new URL(consent.headers.get('location') ?? '').host).toBe('accounts.google.com');
    });

    it('continues to the one Google link', async () => {
      vi.stubEnv('THREAD_ONBOARDING_V2_ENABLED', 'true');
      vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
      const parent = await seedParent();
      const link = await mintLink(parent.userId);

      await tap(link.token, 'google');
      const result = await tap(link.token, 'google', { code: lastCode() });

      expect(result.redirect).toBe(
        `/api/integrations/google/connect?from=text&link=${link.tokenId}`,
      );
    });

    it('is spent once: the same code does not sign in a second time', async () => {
      const parent = await seedParent();
      const link = await mintLink(parent.userId);

      await tap(link.token, 'gcal');
      const code = lastCode();
      expect(await directPost({ token: link.token, code })).toEqual({
        id: parent.externalAuthId,
        email: null,
      });
      expect(await directPost({ token: link.token, code })).toBeNull();
    });

    it('does not work with another user or another link', async () => {
      const parent = await seedParent();
      const other = await seedParent();
      const [first, sibling] = await mintChannelSigninTokens(db.database, {
        userId: parent.userId,
        count: 2,
        now: new Date(),
      });
      if (!first || !sibling) throw new Error('expected two links');
      const otherLink = await mintLink(other.userId);

      await tap(first.token, 'gcal');
      const code = lastCode();

      expect(await directPost({ token: otherLink.token, code })).toBeNull();
      expect(await directPost({ token: sibling.token, code })).toBeNull();
      expect(await directPost({ token: first.token, code })).toEqual({
        id: parent.externalAuthId,
        email: null,
      });
    });

    it('does not open /sign-in', async () => {
      const parent = await seedParent();
      const link = await mintLink(parent.userId);
      await tap(link.token, 'gcal');

      expect(
        await verifyClaimCode(db.database, { phoneRaw: parent.phone, code: lastCode() }),
      ).toEqual({ status: 'refused', reason: 'wrong_code' });
    });

    it('does not take a code that was sent for the sign-in page', async () => {
      const parent = await seedParent();
      const link = await mintLink(parent.userId);
      await requestClaimCode(db.database, { phoneRaw: parent.phone }, { sender });

      expect(await directPost({ token: link.token, code: lastCode() })).toBeNull();
    });
  });

  describe('a code that fails', () => {
    it('gives a wrong code no session and leaves the right one usable', async () => {
      const parent = await seedParent();
      const link = await mintLink(parent.userId);
      await tap(link.token, 'gcal');

      const wrong = await tap(link.token, 'gcal', { code: WRONG_CODE });

      expect(wrong.state).toEqual({ status: 'code', message: CLAIM_CODE_ERROR });
      expect(h.session).toBeNull();
      const right = await tap(link.token, 'gcal', { code: lastCode() });
      expect(right.redirect).toContain('/api/integrations/gcal/connect');
    });

    it('refuses an expired code', async () => {
      const parent = await seedParent();
      const link = await mintLink(parent.userId);
      await tap(link.token, 'gcal');
      const code = lastCode();

      advance(CODE_EXPIRED_MS);

      expect(await directPost({ token: link.token, code })).toBeNull();
      expect(h.session).toBeNull();
    });

    it('locks after three wrong tries, even for the right code', async () => {
      const parent = await seedParent();
      const link = await mintLink(parent.userId);
      await tap(link.token, 'gcal');
      const code = lastCode();

      await Promise.all(
        [1, 2, 3, 4, 5].map(() => directPost({ token: link.token, code: WRONG_CODE })),
      );

      const [row] = await db.database
        .select({ attemptCount: schema.phoneVerifications.attemptCount })
        .from(schema.phoneVerifications)
        .where(eq(schema.phoneVerifications.userId, parent.userId));
      expect(row?.attemptCount).toBe(3);
      expect(await directPost({ token: link.token, code })).toBeNull();
    });

    it('does not flood the parent however many times the link is tapped', async () => {
      const parent = await seedParent();
      const link = await mintLink(parent.userId);

      await tap(link.token, 'gcal');
      const immediate = await tap(link.token, 'gcal');
      expect(sender.sent).toHaveLength(1);
      expect(immediate.state).toMatchObject({ status: 'code' });

      const states = [];
      for (let i = 0; i < 6; i += 1) {
        advance(COOLDOWN_PASSED_MS);
        states.push((await tap(link.token, 'gcal')).state);
      }

      expect(sender.sent).toHaveLength(5);
      expect(states.at(-1)).toEqual({ status: 'code', message: CLAIM_RATE_LIMIT });
    });

    it('spends the hourly budget only on real sends, not on taps inside the cooldown', async () => {
      const parent = await seedParent();
      const link = await mintLink(parent.userId);

      for (let i = 0; i < 5; i += 1) await tap(link.token, 'gcal');
      expect(sender.sent).toHaveLength(1);

      advance(COOLDOWN_PASSED_MS);
      const afterCooldown = await tap(link.token, 'gcal');

      expect(afterCooldown.state).toEqual({ status: 'code', message: null });
      expect(sender.sent).toHaveLength(2);
    });

    it('does not promise a usable code to a sibling link tapped inside the cooldown', async () => {
      const parent = await seedParent();
      const [first, sibling] = await mintChannelSigninTokens(db.database, {
        userId: parent.userId,
        count: 2,
        now: new Date(),
      });
      if (!first || !sibling) throw new Error('expected two links');

      await tap(first.token, 'gcal');
      const siblingTap = await tap(sibling.token, 'gcal');

      expect(sender.sent).toHaveLength(1);
      expect(siblingTap.state).toEqual({
        status: 'code',
        message: "A code just went out. If it doesn't work, send a new one in a minute.",
      });

      advance(COOLDOWN_PASSED_MS);
      await tap(sibling.token, 'gcal');
      expect(sender.sent).toHaveLength(2);
      const opened = await tap(sibling.token, 'gcal', { code: lastCode() });
      expect(opened.redirect).toContain('/api/integrations/gcal/connect');
    });
  });

  describe('an existing session', () => {
    it('skips the code for exactly that user', async () => {
      const parent = await seedParent();
      const link = await mintLink(parent.userId);
      h.session = { user: { id: parent.externalAuthId } };

      const result = await tap(link.token, 'gmail');

      expect(result.redirect).toBe(
        `/api/integrations/gmail/connect?from=text&link=${link.tokenId}`,
      );
      expect(sender.sent).toEqual([]);
    });

    it('does not carry over for a different user, who must pass the code', async () => {
      const parent = await seedParent();
      const other = await seedParent();
      const link = await mintLink(parent.userId);
      h.session = { user: { id: other.externalAuthId } };

      const first = await tap(link.token, 'gmail');

      expect(first.redirect).toBeUndefined();
      expect(sender.sent.map((row) => row.phoneE164)).toEqual([parent.phone]);
      expect(h.session?.user.id).toBe(other.externalAuthId);

      const second = await tap(link.token, 'gmail', { code: lastCode() });
      expect(second.redirect).toContain('/api/integrations/gmail/connect');
      expect(h.session?.user.id).toBe(parent.externalAuthId);
    });
  });

  describe('links that cannot take a code', () => {
    it('keeps the fresh-link behaviour for a dead token and sends no code', async () => {
      const parent = await seedParent();
      const link = await mintLink(parent.userId);
      await db.database
        .update(schema.channelSigninTokens)
        .set({ consumedAt: new Date() })
        .where(eq(schema.channelSigninTokens.id, link.tokenId));

      const result = await tap(link.token, 'gcal');

      expect(h.freshLink).toHaveBeenCalledTimes(1);
      expect(h.freshLink.mock.calls[0]?.[1]).toMatchObject({
        familyId: parent.familyId,
        parentUserId: parent.userId,
        provider: 'gcal',
      });
      expect(result.state).toEqual({
        status: 'error',
        message: 'This link is invalid or has expired. A fresh one is in your texts.',
      });
      expect(sender.sent).toEqual([]);
    });

    it('fails closed with a named outcome when the user has no verified number', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const parent = await seedParent();
      const link = await mintLink(parent.userId);
      await db.database
        .update(schema.parentChannels)
        .set({ revokedAt: new Date() })
        .where(eq(schema.parentChannels.userId, parent.userId));

      const result = await tap(link.token, 'gcal');

      expect(result.state).toEqual({
        status: 'error',
        message: "Hale can't send a code for this link. Text Hale and ask for a new one.",
      });
      expect(sender.sent).toEqual([]);
      expect(h.session).toBeNull();
      expect(
        info.mock.calls.some(([first]) => JSON.stringify(first).includes('no_verified_number')),
      ).toBe(true);
    });
  });

  describe('the two reproductions', () => {
    it('a forwarded link opened by someone else cannot sign in or reach Google consent', async () => {
      stubGoogleConsentEnv();
      const parent = await seedParent();
      const link = await mintLink(parent.userId);

      const opened = await tap(link.token, 'gcal');
      const guessed = await tap(link.token, 'gcal', { code: WRONG_CODE });

      expect(opened.redirect).toBeUndefined();
      expect(guessed.redirect).toBeUndefined();
      expect(h.session).toBeNull();
      const consent = await openConsent('gcal', link.tokenId);
      expect(consent.status).toBe(401);
      expect(consent.headers.get('location')).toBeNull();
    });

    it('a link posted in a family group cannot be used by another member', async () => {
      const parent = await seedParent();
      const member = await seedParent(parent.familyId);
      const link = await mintLink(parent.userId);
      h.session = { user: { id: member.externalAuthId } };

      const opened = await tap(link.token, 'gmail');
      const guessed = await tap(link.token, 'gmail', { code: WRONG_CODE });

      expect(opened.redirect).toBeUndefined();
      expect(guessed.redirect).toBeUndefined();
      expect(sender.sent.map((row) => row.phoneE164)).toEqual([parent.phone]);
      expect(h.session?.user.id).toBe(member.externalAuthId);

      const owner = await tap(link.token, 'gmail', { code: lastCode() });
      expect(owner.redirect).toBe(`/api/integrations/gmail/connect?from=text&link=${link.tokenId}`);
      expect(h.session?.user.id).toBe(parent.externalAuthId);
    });
  });

  it('asks for the code with one-time-code autofill and shows no number', async () => {
    const { ConnectCodeCard } = await import('~/components/hale/connect/connect-cards');

    const html = renderToStaticMarkup(
      createElement(ConnectCodeCard, {
        message: CLAIM_CODE_ERROR,
        formAction: async () => undefined,
      }),
    );

    expect(html).toContain('autoComplete="one-time-code"');
    expect(html).toContain('name="code"');
    expect(html.replaceAll('&#x27;', "'")).toContain(CLAIM_CODE_ERROR);
    expect(html).not.toMatch(/\+1\d{10}/);
  });
});
