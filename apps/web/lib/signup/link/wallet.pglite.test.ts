import { randomBytes } from 'node:crypto';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { LinkApiError, type LinkOAuthApi, type LinkWalletApi } from './client';
import { deleteLinkWallet, loadLinkWallet, storeLinkWallet } from './vault';
import { linkWalletSource } from './wallet';

const LINKED = new Date('2026-10-20T15:00:00.000Z');
const NOW = new Date('2026-10-21T15:00:00.000Z');

function walletApiStub(): LinkWalletApi {
  return {
    createSpendRequest: vi.fn(),
    retrieveSpendRequest: vi.fn(),
    retrieveCard: vi.fn(),
    cancelSpendRequest: vi.fn(),
  };
}

describe('per-parent link wallet', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(() => {
    vi.stubEnv('APP_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  });

  async function linked(scope = 'payment_methods.agentic userinfo:read') {
    const family = await seedFamily(db.database);
    await storeLinkWallet(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      refreshToken: 'liwlrefresh_first',
      scope,
      linkedAt: LINKED,
    });
    return family;
  }

  it('stores the refresh token encrypted and rotates it on every refresh', async () => {
    const family = await linked();
    const refresh = vi.fn(async () => ({
      accessToken: 'liwltoken_fresh',
      refreshToken: 'liwlrefresh_second',
      expiresInSeconds: 3600,
      scope: 'payment_methods.agentic userinfo:read',
    }));
    const walletApi = vi.fn(() => walletApiStub());
    const source = linkWalletSource(db.database, {
      oauth: { refresh, exchangeCode: vi.fn() } as LinkOAuthApi,
      walletApi,
    });
    const lookup = await source.forParent({ ...family, now: NOW });
    expect(lookup.skipped).toBeNull();
    expect(lookup.wallet).toMatchObject({
      kind: 'stripe_link_agent_wallet',
      approvalWindowMinutes: 5,
    });
    expect(refresh).toHaveBeenCalledWith('liwlrefresh_first');
    expect(walletApi).toHaveBeenCalledWith('liwltoken_fresh');

    const [row] = await db.database
      .select()
      .from(schema.familyLinkWallets)
      .where(eq(schema.familyLinkWallets.familyId, family.familyId));
    expect(row?.refreshTokenCiphertext).not.toContain('liwlrefresh');
    expect(row?.refreshedAt?.toISOString()).toBe(NOW.toISOString());
    expect((await loadLinkWallet(db.database, family))?.refreshToken).toBe('liwlrefresh_second');
  });

  it("does not hand one parent's wallet to the other parent", async () => {
    const family = await linked();
    const other = await seedFamily(db.database);
    const refresh = vi.fn();
    const source = linkWalletSource(db.database, {
      oauth: { refresh, exchangeCode: vi.fn() } as unknown as LinkOAuthApi,
      walletApi: () => walletApiStub(),
    });
    expect(
      await source.forParent({
        familyId: family.familyId,
        parentUserId: other.parentUserId,
        now: NOW,
      }),
    ).toEqual({ wallet: null, skipped: 'not_linked' });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('names a wallet linked without the agentic payment scope', async () => {
    const family = await linked('userinfo:read');
    const source = linkWalletSource(db.database, {
      oauth: { refresh: vi.fn(), exchangeCode: vi.fn() } as unknown as LinkOAuthApi,
      walletApi: () => walletApiStub(),
    });
    expect(await source.forParent({ ...family, now: NOW })).toEqual({
      wallet: null,
      skipped: 'missing_scope',
    });
  });

  it('names a refresh Link refuses, and keeps the stored token', async () => {
    const family = await linked();
    const source = linkWalletSource(db.database, {
      oauth: {
        refresh: vi.fn(async () => {
          throw new LinkApiError(400, 'refresh');
        }),
        exchangeCode: vi.fn(),
      } as unknown as LinkOAuthApi,
      walletApi: () => walletApiStub(),
    });
    expect(await source.forParent({ ...family, now: NOW })).toEqual({
      wallet: null,
      skipped: 'token_refresh_failed',
    });
    expect((await loadLinkWallet(db.database, family))?.refreshToken).toBe('liwlrefresh_first');
  });

  it('deletes a parent wallet', async () => {
    const family = await linked();
    expect(await deleteLinkWallet(db.database, family)).toBe(true);
    expect(await loadLinkWallet(db.database, family)).toBeNull();
  });
});
