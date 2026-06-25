import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUSINESS_ADDRESS,
  hasOptedOut,
  processUnsubscribe,
  recordOptOut,
  recordEmailSend,
  signUnsubscribeToken,
  unsubscribeUrl,
  verifyUnsubscribeToken,
} from './email-compliance';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const FAMILY_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.stubEnv('UNSUBSCRIBE_SECRET', 'test-unsub-secret');
  vi.stubEnv('APP_URL', 'https://app.example.com');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('unsubscribe token', () => {
  it('verifies a token it signed for the same (user, stream)', () => {
    const token = signUnsubscribeToken({ userId: USER_ID, emailType: 'daily_digest' });
    expect(token).toBeTruthy();
    expect(
      verifyUnsubscribeToken({ userId: USER_ID, emailType: 'daily_digest' }, token as string),
    ).toBe(true);
  });

  it('rejects a token bound to a different user (cannot opt out someone else)', () => {
    const token = signUnsubscribeToken({ userId: USER_ID, emailType: 'daily_digest' }) as string;
    expect(
      verifyUnsubscribeToken({ userId: 'other-user', emailType: 'daily_digest' }, token),
    ).toBe(false);
  });

  it('rejects a garbage / non-hex token', () => {
    expect(verifyUnsubscribeToken({ userId: USER_ID, emailType: 'daily_digest' }, 'not-hex!!')).toBe(
      false,
    );
  });

  it('fails closed when UNSUBSCRIBE_SECRET is unset (no token minted, none verified)', () => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', '');
    expect(signUnsubscribeToken({ userId: USER_ID, emailType: 'daily_digest' })).toBeNull();
    expect(verifyUnsubscribeToken({ userId: USER_ID, emailType: 'daily_digest' }, 'abcd')).toBe(
      false,
    );
  });

  it('builds an absolute unsubscribe URL carrying the user, stream, and signature', () => {
    const url = unsubscribeUrl({ userId: USER_ID, emailType: 'daily_digest' }) as string;
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://app.example.com');
    expect(parsed.pathname).toBe('/unsubscribe');
    expect(parsed.searchParams.get('u')).toBe(USER_ID);
    expect(parsed.searchParams.get('t')).toBe('daily_digest');
    // The signature in the URL verifies for that user+stream (round-trip).
    expect(
      verifyUnsubscribeToken(
        { userId: USER_ID, emailType: 'daily_digest' },
        parsed.searchParams.get('sig') as string,
      ),
    ).toBe(true);
  });
});

describe('opt-out store', () => {
  it('hasOptedOut is true when a matching row exists, false otherwise', async () => {
    const dbWithRow = {
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [{ id: 'x' }] }) }),
      }),
    } as never;
    const dbEmpty = {
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [] }) }),
      }),
    } as never;

    expect(await hasOptedOut(dbWithRow, USER_ID, 'daily_digest')).toBe(true);
    expect(await hasOptedOut(dbEmpty, USER_ID, 'daily_digest')).toBe(false);
  });

  it('recordOptOut inserts into email_opt_outs idempotently (onConflictDoNothing)', async () => {
    const captured: Array<{ table: unknown; values: unknown; conflict: boolean }> = [];
    const db = {
      insert: (table: unknown) => ({
        values: (values: unknown) => ({
          onConflictDoNothing: async () => {
            captured.push({ table, values, conflict: true });
          },
        }),
      }),
    } as never;

    await recordOptOut(db, USER_ID, 'daily_digest');

    expect(captured).toHaveLength(1);
    expect(captured[0]?.table).toBe(schema.emailOptOuts);
    expect(captured[0]?.conflict).toBe(true);
    expect(captured[0]?.values).toMatchObject({ userId: USER_ID, emailType: 'daily_digest' });
  });

  it('recordEmailSend writes one ledger row with recipient + provider id', async () => {
    const captured: Array<{ table: unknown; values: unknown }> = [];
    const db = {
      insert: (table: unknown) => ({
        values: async (values: unknown) => {
          captured.push({ table, values });
        },
      }),
    } as never;

    await recordEmailSend(db, {
      userId: USER_ID,
      familyId: FAMILY_ID,
      emailType: 'daily_digest',
      recipient: 'parent@example.com',
      providerMessageId: 'resend-123',
    });

    expect(captured[0]?.table).toBe(schema.emailSends);
    expect(captured[0]?.values).toMatchObject({
      userId: USER_ID,
      familyId: FAMILY_ID,
      emailType: 'daily_digest',
      recipient: 'parent@example.com',
      providerMessageId: 'resend-123',
    });
  });
});

describe('processUnsubscribe', () => {
  function captureDb() {
    const optOuts: unknown[] = [];
    const db = {
      insert: () => ({
        values: (values: unknown) => ({
          onConflictDoNothing: async () => {
            optOuts.push(values);
          },
        }),
      }),
    } as never;
    return { db, optOuts };
  }

  it('records the opt-out for a validly-signed link', async () => {
    const { db, optOuts } = captureDb();
    const sig = signUnsubscribeToken({ userId: USER_ID, emailType: 'daily_digest' }) as string;

    const result = await processUnsubscribe(db, { u: USER_ID, t: 'daily_digest', sig });

    expect(result).toEqual({ status: 'unsubscribed', emailType: 'daily_digest' });
    expect(optOuts).toHaveLength(1);
    expect(optOuts[0]).toMatchObject({ userId: USER_ID, emailType: 'daily_digest' });
  });

  it('fails closed (no write) on a forged signature', async () => {
    const { db, optOuts } = captureDb();
    const result = await processUnsubscribe(db, {
      u: USER_ID,
      t: 'daily_digest',
      sig: 'deadbeef',
    });
    expect(result).toEqual({ status: 'invalid' });
    expect(optOuts).toEqual([]);
  });

  it('fails closed on an unknown email stream even with a real-looking sig', async () => {
    const { db, optOuts } = captureDb();
    // Sign for the real stream, then claim a different (unknown) stream.
    const sig = signUnsubscribeToken({ userId: USER_ID, emailType: 'daily_digest' }) as string;
    const result = await processUnsubscribe(db, { u: USER_ID, t: 'marketing_blast', sig });
    expect(result).toEqual({ status: 'invalid' });
    expect(optOuts).toEqual([]);
  });

  it('fails closed on missing params', async () => {
    const { db, optOuts } = captureDb();
    expect(await processUnsubscribe(db, { u: null, t: null, sig: null })).toEqual({
      status: 'invalid',
    });
    expect(optOuts).toEqual([]);
  });
});

describe('CASL footer content', () => {
  it('exposes a business mailing address constant', () => {
    expect(BUSINESS_ADDRESS).toContain('Village Hale Technologies Inc.');
  });
});
