import { createHmac } from 'node:crypto';
import type { Database } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleTwilioStatusRequest, mapTwilioStatus, overwritableFrom } from './status';

/**
 * The delivery-callback DECISION, tested as the pure function it is. Callbacks arrive
 * out of order (Twilio makes no ordering guarantee across HTTP requests), so "which
 * ledger states may this callback overwrite" is the whole correctness question — a
 * late `sent` must not un-deliver a message that is already delivered.
 */

describe('mapTwilioStatus', () => {
  it('maps the pre-send lifecycle to queued', () => {
    for (const raw of ['accepted', 'scheduled', 'queued', 'sending']) {
      expect(mapTwilioStatus(raw)).toBe('queued');
    }
  });

  it('maps handoff-to-carrier to sent', () => {
    expect(mapTwilioStatus('sent')).toBe('sent');
  });

  it('maps carrier confirmation (and read receipts) to delivered', () => {
    expect(mapTwilioStatus('delivered')).toBe('delivered');
    expect(mapTwilioStatus('read')).toBe('delivered');
  });

  it('maps both failure terminals to failed', () => {
    expect(mapTwilioStatus('undelivered')).toBe('failed');
    expect(mapTwilioStatus('failed')).toBe('failed');
  });

  it('is case-insensitive on the provider value', () => {
    expect(mapTwilioStatus('Delivered')).toBe('delivered');
  });

  it('returns null for inbound-only and unknown statuses rather than guessing', () => {
    for (const raw of ['receiving', 'received', 'partially_delivered', '', 'nonsense']) {
      expect(mapTwilioStatus(raw)).toBeNull();
    }
  });
});

describe('overwritableFrom', () => {
  it('lets delivered overwrite only the earlier states', () => {
    expect(overwritableFrom('delivered')).toEqual(['queued', 'sent']);
  });

  it('lets sent overwrite only queued — never a delivered row', () => {
    expect(overwritableFrom('sent')).toEqual(['queued']);
    expect(overwritableFrom('sent')).not.toContain('delivered');
  });

  it('lets failed overwrite every non-terminal state, including delivered', () => {
    // A late failure is the more actionable truth than a stale success, and Twilio
    // does report undelivered after an optimistic delivered on some carriers.
    expect(overwritableFrom('failed')).toEqual(['queued', 'sent', 'delivered']);
  });

  it('never lets queued overwrite anything — a late pre-send callback is a no-op', () => {
    expect(overwritableFrom('queued')).toEqual([]);
  });

  it('never overwrites a suppression, which never reached a provider at all', () => {
    for (const next of ['queued', 'sent', 'delivered', 'failed'] as const) {
      const from = overwritableFrom(next);
      expect(from).not.toContain('suppressed_consent');
      expect(from).not.toContain('suppressed_quiet_hours');
      expect(from).not.toContain('suppressed_cap');
      expect(from).not.toContain('suppressed_pref');
    }
  });
});

describe('handleTwilioStatusRequest — the same gates as inbound', () => {
  const AUTH_TOKEN = 'twilio_auth_token_value';
  const APP_URL = 'https://app.villagehale.com';
  const STATUS_URL = `${APP_URL}/api/channels/twilio/status`;
  const PARAMS = {
    MessageSid: 'SM11111111111111111111111111111111',
    MessageStatus: 'delivered',
    To: '+14165551234',
  };

  /** A db handle that fails the test if the gates let a request reach it. */
  function forbiddenDb(): Database {
    const boom = () => {
      throw new Error('database touched on a refused request');
    };
    return { update: boom, select: boom, insert: boom } as unknown as Database;
  }

  function statusRequest(signature: string | null): Request {
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
    };
    if (signature !== null) headers['x-twilio-signature'] = signature;
    return new Request(STATUS_URL, {
      method: 'POST',
      headers,
      body: new URLSearchParams(PARAMS).toString(),
    });
  }

  function sign(url: string): string {
    let base = url;
    for (const key of Object.keys(PARAMS).sort()) {
      base += key + PARAMS[key as keyof typeof PARAMS];
    }
    return createHmac('sha1', AUTH_TOKEN).update(base, 'utf8').digest('base64');
  }

  beforeEach(() => {
    vi.stubEnv('APP_URL', APP_URL);
    vi.stubEnv('TWILIO_ACCOUNT_SID', 'AC00000000000000000000000000000000');
    vi.stubEnv('TWILIO_AUTH_TOKEN', AUTH_TOKEN);
    vi.stubEnv('TWILIO_API_KEY_SID', 'SK11111111111111111111111111111111');
    vi.stubEnv('TWILIO_API_KEY_SECRET', 'api_key_secret_value');
    vi.stubEnv('TWILIO_FROM_NUMBER', '+14165550000');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('answers 503 without touching the ledger when unconfigured', async () => {
    vi.unstubAllEnvs();
    const res = await handleTwilioStatusRequest(statusRequest(sign(STATUS_URL)), {
      database: forbiddenDb(),
    });
    expect(res.status).toBe(503);
  });

  it('answers 403 without touching the ledger on a forged signature', async () => {
    const res = await handleTwilioStatusRequest(statusRequest('forged'), {
      database: forbiddenDb(),
    });
    expect(res.status).toBe(403);
  });

  it('rejects a signature minted for the INBOUND endpoint', async () => {
    const res = await handleTwilioStatusRequest(
      statusRequest(sign(`${APP_URL}/api/channels/twilio/inbound`)),
      { database: forbiddenDb() },
    );
    expect(res.status).toBe(403);
  });

  it('applies an authentic receipt and answers 204', async () => {
    const applied: unknown[] = [];
    const database = {
      update: () => ({
        set: (payload: unknown) => {
          applied.push(payload);
          return {
            where: () => ({ returning: async () => [{ id: 'row-1' }] }),
          };
        },
      }),
    } as unknown as Database;

    const res = await handleTwilioStatusRequest(statusRequest(sign(STATUS_URL)), { database });

    expect(res.status).toBe(204);
    expect(applied).toEqual([{ status: 'delivered', errorCode: null }]);
  });
});
