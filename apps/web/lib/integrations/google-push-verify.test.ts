import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  channelTokenMatches,
  decodeGmailPushBody,
  hashChannelToken,
  readBearerToken,
  readCalendarPushHeaders,
  verifyCalendarPush,
  verifyPubSubPushToken,
} from './google-push-verify';

const AUDIENCE = 'https://app.villagehale.com/api/webhooks/gmail';
const SERVICE_ACCOUNT = 'push@hale-test.iam.gserviceaccount.com';

function headers(values: Record<string, string>): { get(name: string): string | null } {
  const lower = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name) => lower.get(name.toLowerCase()) ?? null };
}

async function signedToken(
  over: {
    audience?: string;
    email?: string;
    emailVerified?: boolean;
    issuer?: string;
    expired?: boolean;
  } = {},
) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  jwk.alg = 'RS256';
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const jwt = new SignJWT({
    email: over.email ?? SERVICE_ACCOUNT,
    email_verified: over.emailVerified ?? true,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(over.issuer ?? 'https://accounts.google.com')
    .setAudience(over.audience ?? AUDIENCE)
    .setIssuedAt();
  if (over.expired) jwt.setExpirationTime('-1m');
  else jwt.setExpirationTime('5m');
  return { token: await jwt.sign(privateKey), jwks };
}

describe('calendar channel verification', () => {
  const token = 'channel-secret';
  const stored = {
    channelId: 'chan-1',
    resourceId: 'res-1',
    tokenHash: hashChannelToken(token),
  };

  it('accepts the channel id, resource id and token Google echoes', () => {
    const presented = readCalendarPushHeaders(
      headers({
        'x-goog-channel-id': 'chan-1',
        'x-goog-channel-token': token,
        'x-goog-resource-id': 'res-1',
        'x-goog-resource-state': 'exists',
      }),
    );
    expect(verifyCalendarPush(presented, stored)).toEqual({
      status: 'verified',
      resourceState: 'exists',
    });
  });

  it('rejects a wrong token and a wrong resource id', () => {
    const wrongToken = readCalendarPushHeaders(
      headers({
        'x-goog-channel-id': 'chan-1',
        'x-goog-channel-token': 'other',
        'x-goog-resource-id': 'res-1',
      }),
    );
    expect(verifyCalendarPush(wrongToken, stored).status).toBe('invalid');
    const wrongResource = readCalendarPushHeaders(
      headers({
        'x-goog-channel-id': 'chan-1',
        'x-goog-channel-token': token,
        'x-goog-resource-id': 'res-other',
      }),
    );
    expect(verifyCalendarPush(wrongResource, stored)).toMatchObject({
      status: 'invalid',
      reason: 'resource_mismatch',
    });
  });

  it('does not treat a hash of a different length as a match', () => {
    expect(channelTokenMatches(token, 'abcd')).toBe(false);
    expect(channelTokenMatches(token, stored.tokenHash)).toBe(true);
  });
});

describe('gmail push body', () => {
  it('decodes emailAddress and historyId from the Pub/Sub data field', () => {
    const data = Buffer.from(
      JSON.stringify({ emailAddress: 'parent@example.com', historyId: '4242' }),
    ).toString('base64');
    expect(decodeGmailPushBody(JSON.stringify({ message: { data } }))).toEqual({
      emailAddress: 'parent@example.com',
      historyId: '4242',
    });
  });

  it('accepts a numeric historyId and base64url data', () => {
    const data = Buffer.from(
      JSON.stringify({ emailAddress: 'parent@example.com', historyId: 99 }),
    ).toString('base64url');
    expect(decodeGmailPushBody(JSON.stringify({ message: { data } }))?.historyId).toBe('99');
  });

  it('refuses a body that is not a mailbox notice', () => {
    expect(decodeGmailPushBody('{}')).toBeNull();
    expect(decodeGmailPushBody('not-json')).toBeNull();
  });
});

describe('Pub/Sub OIDC', () => {
  it('reads a bearer token and ignores anything else', () => {
    expect(readBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(readBearerToken('Basic abc')).toBeNull();
    expect(readBearerToken(null)).toBeNull();
  });

  it('verifies a Google-issued token for the configured audience and service account', async () => {
    const { token, jwks } = await signedToken();
    expect(
      await verifyPubSubPushToken(token, {
        audience: AUDIENCE,
        serviceAccount: SERVICE_ACCOUNT,
        jwks,
      }),
    ).toEqual({ status: 'verified' });
  });

  it('rejects a bad signature, the wrong audience, the wrong account, and an expired token', async () => {
    const { token, jwks } = await signedToken();
    expect(
      (
        await verifyPubSubPushToken(`${token}x`, {
          audience: AUDIENCE,
          serviceAccount: SERVICE_ACCOUNT,
          jwks,
        })
      ).status,
    ).toBe('invalid');
    expect(
      await verifyPubSubPushToken(token, {
        audience: 'https://evil.example/hook',
        serviceAccount: SERVICE_ACCOUNT,
        jwks,
      }),
    ).toMatchObject({ status: 'invalid' });

    const other = await signedToken({ email: 'other@hale-test.iam.gserviceaccount.com' });
    expect(
      await verifyPubSubPushToken(other.token, {
        audience: AUDIENCE,
        serviceAccount: SERVICE_ACCOUNT,
        jwks: other.jwks,
      }),
    ).toMatchObject({ reason: 'service_account_mismatch' });

    const expired = await signedToken({ expired: true });
    expect(
      (
        await verifyPubSubPushToken(expired.token, {
          audience: AUDIENCE,
          serviceAccount: SERVICE_ACCOUNT,
          jwks: expired.jwks,
        })
      ).status,
    ).toBe('invalid');
  });

  it('is not configured when the audience or the service account is unset', async () => {
    const { token, jwks } = await signedToken();
    expect(
      await verifyPubSubPushToken(token, {
        audience: undefined,
        serviceAccount: SERVICE_ACCOUNT,
        jwks,
      }),
    ).toMatchObject({ status: 'not_configured', reason: 'GOOGLE_PUBSUB_PUSH_AUDIENCE unset' });
    expect(
      await verifyPubSubPushToken(token, { audience: AUDIENCE, serviceAccount: undefined, jwks }),
    ).toMatchObject({ status: 'not_configured' });
  });
});
