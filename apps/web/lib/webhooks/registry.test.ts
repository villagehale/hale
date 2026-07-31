import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAdapter, SUPPORTED_PROVIDERS } from './registry.js';

/**
 * Fixtures hand-built from each provider's documented webhook contract (the
 * external-id field each carries), never copied from runtime output:
 *   gmail   → emailAddress           gcal   → channelId / resourceId
 *   outlook → subscriptionId         stripe → account
 *
 * 'twilio' is deliberately ABSENT: VIL-214 · A3 removed its adapter (its verify()
 * could never be correct here — this interface never sees the request URL that
 * Twilio signs). All Twilio ingress goes through /api/channels/twilio/*, so this
 * route must now treat it as an unknown provider.
 *
 * The three scaffold legs (brightwheel / himama / google_classroom) are
 * KNOWN-but-NOT-LIVE: verify() must return not_configured so the route answers
 * 501 and the payload is never ingested — even with a well-formed signature and
 * even if the leg's documented secret env var happens to be present.
 */

const LIVE_PROVIDERS = ['gmail', 'gcal', 'outlook', 'stripe'] as const;
const SCAFFOLD_PROVIDERS = ['brightwheel', 'himama', 'google_classroom'] as const;

/** VIL-253: the legs whose real verification is not implemented. They must refuse
 * everything — stripe is excluded because it verifies an HMAC for real. */
const UNIMPLEMENTED_PROVIDERS = [
  'gmail',
  'gcal',
  'outlook',
  ...SCAFFOLD_PROVIDERS,
] as const;

/** The env vars whose mere presence used to flip a leg to accept-by-default. */
const CREDENTIAL_ENV_VARS = [
  'GOOGLE_OAUTH_CLIENT_ID',
  'MICROSOFT_OAUTH_CLIENT_ID',
  'BRIGHTWHEEL_WEBHOOK_SECRET',
  'HIMAMA_WEBHOOK_SECRET',
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('registry dispatch', () => {
  it('resolves an adapter for every supported provider', () => {
    for (const provider of SUPPORTED_PROVIDERS) {
      const adapter = getAdapter(provider);
      expect(adapter).not.toBeNull();
      expect(adapter?.provider).toBe(provider);
    }
  });

  it('returns null for an unknown provider (route turns this into a 404)', () => {
    expect(getAdapter('unknown_provider')).toBeNull();
    expect(getAdapter('facebook')).toBeNull();
    expect(getAdapter('')).toBeNull();
  });

  it('SUPPORTED_PROVIDERS is exactly the 5 live legs plus the 3 scaffolds', () => {
    expect([...SUPPORTED_PROVIDERS].sort()).toEqual(
      [...LIVE_PROVIDERS, ...SCAFFOLD_PROVIDERS].sort(),
    );
  });
});

describe('scaffold providers — known but not live', () => {
  it.each(SCAFFOLD_PROVIDERS)(
    '%s verify() returns not_configured with a well-formed signature (never verified → never ingests)',
    (provider) => {
      const adapter = getAdapter(provider);
      const result = adapter?.verify('x-sig-looks-valid', '{"event":"check_in"}');
      expect(result?.status).toBe('not_configured');
    },
  );

  it.each(SCAFFOLD_PROVIDERS)(
    '%s verify() stays not_configured even with no signature (cannot fall through dev-unsigned)',
    (provider) => {
      const adapter = getAdapter(provider);
      expect(adapter?.verify(null, '{}').status).toBe('not_configured');
    },
  );

  it('google_classroom stays not_configured even when GOOGLE_OAUTH_CLIENT_ID is set', () => {
    // The scaffold names GOOGLE_OAUTH_CLIENT_ID as its eventual secret, but the
    // real verify scheme isn't implemented — presence of the var must NOT flip
    // it live (mirrors the stripe-billing invariant: configured ≠ verified).
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'test-client-id');
    const adapter = getAdapter('google_classroom');
    expect(adapter?.verify('sig', '{}').status).toBe('not_configured');
  });
});

describe('VIL-253 · unimplemented legs refuse every request (red team)', () => {
  /**
   * The regression: gmail/gcal/outlook returned `verified` for ANY non-empty
   * signature once their OAuth client-id env var was set — and
   * GOOGLE_OAUTH_CLIENT_ID is provisioned in production, so the gmail path was
   * live-reachable. Each case below is a forged request shape; none may ever come
   * back `verified`, because none of them carries proof of anything.
   */
  const FORGED_CASES: Array<{ name: string; signature: string | null; body: string }> = [
    { name: 'no signature header at all', signature: null, body: '{"emailAddress":"a@b.com"}' },
    { name: 'an empty signature header', signature: '', body: '{"emailAddress":"a@b.com"}' },
    { name: 'an arbitrary non-empty signature', signature: 'anything', body: '{}' },
    { name: 'a plausible base64 signature', signature: 'L/OH5YylLD5NRKLltdqwSvS0BnU=', body: '{}' },
    { name: 'a stripe-shaped signature', signature: 'v1=deadbeef', body: '{}' },
    { name: 'a bearer-token-shaped signature', signature: 'Bearer eyJhbGciOiJSUzI1NiJ9.e30.x', body: '{}' },
    { name: 'a signature over an empty body', signature: 'sig', body: '' },
    {
      name: 'a fully plausible payload naming a real external id',
      signature: 'sig',
      body: '{"emailAddress":"parent@example.com","subscriptionId":"sub_1","channelId":"chan_1"}',
    },
  ];

  for (const provider of UNIMPLEMENTED_PROVIDERS) {
    it.each(FORGED_CASES)(`${provider} refuses %s`, ({ signature, body }) => {
      const result = getAdapter(provider)?.verify(signature, body);
      expect(result?.status).toBe('not_configured');
    });
  }

  it.each(UNIMPLEMENTED_PROVIDERS)(
    '%s refuses even with EVERY credential env var present — a credential is not a verified request',
    (provider) => {
      for (const name of CREDENTIAL_ENV_VARS) {
        vi.stubEnv(name, 'provisioned-value');
      }
      // This is the exact production condition that made gmail exploitable.
      expect(getAdapter(provider)?.verify('sig', '{"emailAddress":"a@b.com"}').status).toBe(
        'not_configured',
      );
    },
  );

  it.each(UNIMPLEMENTED_PROVIDERS)(
    '%s refuses an unsigned request outside production — no dev shortcut survives',
    (provider) => {
      // Vitest runs with NODE_ENV=test, so the deleted `isDevUnsigned` helper WOULD
      // have returned verified here. If this ever passes again, the bypass is back.
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'provisioned-value');
      expect(getAdapter(provider)?.verify(null, '{}').status).toBe('not_configured');
    },
  );

  it('stripe — the one leg that verifies for real — also has no unsigned shortcut', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_test');

    // Unsigned is now `invalid`, not `verified`: the secret exists, so the request
    // is refused for the right reason rather than waved through by environment.
    expect(getAdapter('stripe')?.verify(null, '{}').status).toBe('invalid');
    expect(getAdapter('stripe')?.verify('v1=deadbeef', '{}').status).toBe('invalid');
  });

  it('stripe still ACCEPTS a correctly signed request (the refusal is not blanket)', () => {
    const secret = 'whsec_test';
    const body = '{"account":"acct_1"}';
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', secret);
    const hex = createHmac('sha256', secret).update(body).digest('hex');

    expect(getAdapter('stripe')?.verify(`v1=${hex}`, body).status).toBe('verified');
  });
});

describe('live providers — behaviour preserved', () => {
  it('gmail extracts the mailbox address from emailAddress', () => {
    expect(getAdapter('gmail')?.extractExternalId({ emailAddress: 'a@b.com' })).toBe('a@b.com');
  });

  it('gcal extracts channelId, falling back to resourceId', () => {
    expect(getAdapter('gcal')?.extractExternalId({ channelId: 'chan_1' })).toBe('chan_1');
    expect(getAdapter('gcal')?.extractExternalId({ resourceId: 'res_1' })).toBe('res_1');
  });

  it('outlook extracts the Graph subscriptionId', () => {
    expect(getAdapter('outlook')?.extractExternalId({ subscriptionId: 'sub_1' })).toBe('sub_1');
  });

  it('stripe extracts the connected account id', () => {
    expect(getAdapter('stripe')?.extractExternalId({ account: 'acct_1' })).toBe('acct_1');
  });

  it('does NOT resolve a twilio adapter — this route is no longer a Twilio ingress', () => {
    // The removed placeholder returned `verified` for ANY non-empty signature once
    // TWILIO_AUTH_TOKEN existed. A3 sets that variable, so leaving it would have armed
    // a forged path into events.ingested. 404 (unknown provider) is the correct answer.
    vi.stubEnv('TWILIO_AUTH_TOKEN', 'a_real_token');
    expect(getAdapter('twilio')).toBeNull();
    expect(SUPPORTED_PROVIDERS).not.toContain('twilio');
  });

  it('extractExternalId returns null for a malformed (non-object) payload', () => {
    expect(getAdapter('gmail')?.extractExternalId(null)).toBeNull();
    expect(getAdapter('stripe')?.extractExternalId('not-json')).toBeNull();
  });

  it('extractExternalId returns null when the documented field is absent', () => {
    expect(getAdapter('gmail')?.extractExternalId({ wrong: 'x' })).toBeNull();
  });

  it('verify returns not_configured for a signed request when the leg secret is absent', () => {
    // A signature present means we cannot take the dev-unsigned shortcut, so the
    // leg's secret/OAuth env is the gate. Absent → not_configured (route 501),
    // not silent acceptance.
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', '');
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', '');
    vi.stubEnv('MICROSOFT_OAUTH_CLIENT_ID', '');

    expect(getAdapter('stripe')?.verify('v1=sig', 'body').status).toBe('not_configured');
    expect(getAdapter('gmail')?.verify('sig', 'body').status).toBe('not_configured');
    expect(getAdapter('outlook')?.verify('sig', 'body').status).toBe('not_configured');
  });

  it('toIngestedEvent shapes the events.ingested contract with the provider as source', () => {
    const familyId = '11111111-1111-4111-8111-111111111111';
    const event = getAdapter('gmail')?.toIngestedEvent(familyId, { emailAddress: 'a@b.com' });
    expect(event?.family_id).toBe(familyId);
    expect(event?.source).toBe('gmail');
    expect(event?.payload).toEqual({ emailAddress: 'a@b.com' });
    expect(typeof event?.received_at).toBe('string');
  });
});
