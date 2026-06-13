import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAdapter, SUPPORTED_PROVIDERS } from './registry.js';

/**
 * Fixtures hand-built from each provider's documented webhook contract (the
 * external-id field each carries), never copied from runtime output:
 *   gmail   → emailAddress           gcal   → channelId / resourceId
 *   outlook → subscriptionId         stripe → account
 *   twilio  → AccountSid
 *
 * The three scaffold legs (brightwheel / himama / google_classroom) are
 * KNOWN-but-NOT-LIVE: verify() must return not_configured so the route answers
 * 501 and the payload is never ingested — even with a well-formed signature and
 * even if the leg's documented secret env var happens to be present.
 */

const LIVE_PROVIDERS = ['gmail', 'gcal', 'outlook', 'stripe', 'twilio'] as const;
const SCAFFOLD_PROVIDERS = ['brightwheel', 'himama', 'google_classroom'] as const;

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

  it('twilio extracts the AccountSid', () => {
    expect(getAdapter('twilio')?.extractExternalId({ AccountSid: 'AC123' })).toBe('AC123');
  });

  it('extractExternalId returns null for a malformed (non-object) payload', () => {
    expect(getAdapter('gmail')?.extractExternalId(null)).toBeNull();
    expect(getAdapter('twilio')?.extractExternalId('not-json')).toBeNull();
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
    vi.stubEnv('TWILIO_AUTH_TOKEN', '');

    expect(getAdapter('stripe')?.verify('v1=sig', 'body').status).toBe('not_configured');
    expect(getAdapter('gmail')?.verify('sig', 'body').status).toBe('not_configured');
    expect(getAdapter('outlook')?.verify('sig', 'body').status).toBe('not_configured');
    expect(getAdapter('twilio')?.verify('sig', 'body').status).toBe('not_configured');
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
