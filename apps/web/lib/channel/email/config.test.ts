import { afterEach, describe, expect, it, vi } from 'vitest';
import { emailInboundConfig, requireEmailInboundConfig } from './config';

const ALL = {
  RESEND_API_KEY: 're_test_key',
  RESEND_INBOUND_WEBHOOK_SECRET: 'whsec_dGVzdC1zZWNyZXQ=',
  HALE_INBOUND_EMAIL_DOMAIN: 'mail.villagehale.com',
  HALE_INBOUND_AUTHSERV_ID: 'mx.resend.com',
} as const;

function stub(overrides: Partial<Record<keyof typeof ALL, string | undefined>> = {}): void {
  for (const [name, value] of Object.entries({ ...ALL, ...overrides })) {
    vi.stubEnv(name, value as string | undefined);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('emailInboundConfig', () => {
  it('returns every value when the leg is fully provisioned', () => {
    stub();
    expect(emailInboundConfig()).toEqual({
      apiKey: ALL.RESEND_API_KEY,
      webhookSecret: ALL.RESEND_INBOUND_WEBHOOK_SECRET,
      inboundDomain: ALL.HALE_INBOUND_EMAIL_DOMAIN,
      authservId: ALL.HALE_INBOUND_AUTHSERV_ID,
    });
  });

  /**
   * ALL-OR-NOTHING, mirroring twilioConfig(). The webhook does not merely read mail, it
   * must FETCH the body with the API key and judge the sender against the MTA id — so a
   * deployment holding the signing secret alone would authenticate a parent's message
   * and then be unable to read or trust it. Half-present config is the same 503 as
   * absent config, never a half-working webhook.
   */
  it.each(Object.keys(ALL) as Array<keyof typeof ALL>)(
    'returns null when %s alone is missing',
    (name) => {
      stub({ [name]: undefined });
      expect(emailInboundConfig()).toBeNull();
    },
  );

  it('treats an empty or whitespace-only value as missing', () => {
    stub({ HALE_INBOUND_EMAIL_DOMAIN: '' });
    expect(emailInboundConfig()).toBeNull();
    stub({ HALE_INBOUND_EMAIL_DOMAIN: '   ' });
    expect(emailInboundConfig()).toBeNull();
  });

  it('lowercases the domain and the MTA id so comparisons never hinge on casing', () => {
    stub({ HALE_INBOUND_EMAIL_DOMAIN: 'Mail.VillageHale.com', HALE_INBOUND_AUTHSERV_ID: 'MX.Resend.com' });
    expect(emailInboundConfig()).toMatchObject({
      inboundDomain: 'mail.villagehale.com',
      authservId: 'mx.resend.com',
    });
  });

  it('returns null when nothing is set at all — the leg is dark by construction', () => {
    stub({
      RESEND_API_KEY: undefined,
      RESEND_INBOUND_WEBHOOK_SECRET: undefined,
      HALE_INBOUND_EMAIL_DOMAIN: undefined,
      HALE_INBOUND_AUTHSERV_ID: undefined,
    });
    expect(emailInboundConfig()).toBeNull();
  });
});

describe('requireEmailInboundConfig', () => {
  it('names every missing variable and no value', () => {
    stub({ RESEND_API_KEY: undefined, HALE_INBOUND_AUTHSERV_ID: undefined });
    try {
      requireEmailInboundConfig();
      expect.unreachable('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('RESEND_API_KEY');
      expect(message).toContain('HALE_INBOUND_AUTHSERV_ID');
      expect(message).not.toContain('RESEND_INBOUND_WEBHOOK_SECRET');
      // A thrown config error travels into logs; a secret must never ride along.
      expect(message).not.toContain(ALL.RESEND_INBOUND_WEBHOOK_SECRET);
      expect(message).not.toContain(ALL.RESEND_API_KEY);
    }
  });

  it('returns the config when everything is present', () => {
    stub();
    expect(requireEmailInboundConfig().inboundDomain).toBe('mail.villagehale.com');
  });
});
