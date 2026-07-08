import { createHash } from 'node:crypto';
import {
  type KeyLike,
  SignJWT,
  createLocalJWKSet,
  errors,
  exportJWK,
  generateKeyPair,
} from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppleTokenError, verifyAppleIdToken } from './apple-id-token';

// A locally generated RS256 keypair stands in for Apple's signing keys so the
// verify runs entirely offline (no network to appleid.apple.com). The public half
// becomes a local JWKS injected into verifyAppleIdToken; the private half signs
// the identity tokens under test. Apple signs identity tokens with RS256.
let privateKey: KeyLike;
let jwks: ReturnType<typeof createLocalJWKSet>;
// A SECOND keypair whose public half is NOT in the injected JWKS — used to forge a
// token that carries the trusted kid but is signed by an untrusted key.
let forgePrivateKey: KeyLike;

const BUNDLE_ID = 'family.villagehale.app';
const APPLE_ISS = 'https://appleid.apple.com';

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  publicJwk.kid = 'test-key-1';
  publicJwk.alg = 'RS256';
  jwks = createLocalJWKSet({ keys: [publicJwk] });

  forgePrivateKey = (await generateKeyPair('RS256')).privateKey;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** SHA-256 hex of the raw nonce — the value Apple echoes into the token's
 * `nonce` claim (the client passes this hash to signInAsync). */
function hashNonce(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

async function signIdToken(
  claims: {
    sub: string;
    email?: string;
    emailVerified?: boolean | string;
    iss?: string;
    aud?: string;
    nonce?: string;
    expiresIn?: string | number;
  },
  signingKey: KeyLike = privateKey,
): Promise<string> {
  const payload: Record<string, unknown> = {};
  if (claims.email) payload.email = claims.email;
  if (claims.emailVerified !== undefined) payload.email_verified = claims.emailVerified;
  if (claims.nonce !== undefined) payload.nonce = claims.nonce;
  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setSubject(claims.sub)
    .setIssuer(claims.iss ?? APPLE_ISS)
    .setAudience(claims.aud ?? BUNDLE_ID)
    .setIssuedAt();
  jwt.setExpirationTime(claims.expiresIn ?? '1h');
  return jwt.sign(signingKey);
}

describe('verifyAppleIdToken', () => {
  it('returns sub and email for a valid, email-verified Apple identity token', async () => {
    vi.stubEnv('APPLE_APP_BUNDLE_ID', BUNDLE_ID);
    const token = await signIdToken({
      sub: 'apple-user-000123.abcdef',
      email: 'kid.parent@icloud.com',
      emailVerified: true,
    });

    const result = await verifyAppleIdToken(token, {}, { jwks });

    expect(result).toEqual({ sub: 'apple-user-000123.abcdef', email: 'kid.parent@icloud.com' });
  });

  it('trusts the email when email_verified is the string "true" (Apple sends it as a string)', async () => {
    vi.stubEnv('APPLE_APP_BUNDLE_ID', BUNDLE_ID);
    const token = await signIdToken({
      sub: 'apple-user-1',
      email: 'relay@privaterelay.appleid.com',
      emailVerified: 'true',
    });

    const result = await verifyAppleIdToken(token, {}, { jwks });

    expect(result).toEqual({ sub: 'apple-user-1', email: 'relay@privaterelay.appleid.com' });
  });

  it('returns email undefined when the identity token omits email', async () => {
    vi.stubEnv('APPLE_APP_BUNDLE_ID', BUNDLE_ID);
    const token = await signIdToken({ sub: 'apple-user-1' });

    const result = await verifyAppleIdToken(token, {}, { jwks });

    expect(result).toEqual({ sub: 'apple-user-1', email: undefined });
  });

  it('drops the email when email_verified is false', async () => {
    vi.stubEnv('APPLE_APP_BUNDLE_ID', BUNDLE_ID);
    const token = await signIdToken({
      sub: 'apple-user-1',
      email: 'unverified@icloud.com',
      emailVerified: false,
    });

    const result = await verifyAppleIdToken(token, {}, { jwks });

    expect(result).toEqual({ sub: 'apple-user-1', email: undefined });
  });

  it('drops the email when email_verified is the string "false"', async () => {
    vi.stubEnv('APPLE_APP_BUNDLE_ID', BUNDLE_ID);
    const token = await signIdToken({
      sub: 'apple-user-1',
      email: 'unverified@icloud.com',
      emailVerified: 'false',
    });

    const result = await verifyAppleIdToken(token, {}, { jwks });

    expect(result).toEqual({ sub: 'apple-user-1', email: undefined });
  });

  it('accepts a valid token when the raw nonce hashes to the token nonce claim', async () => {
    vi.stubEnv('APPLE_APP_BUNDLE_ID', BUNDLE_ID);
    const rawNonce = 'random-client-nonce-xyz';
    const token = await signIdToken({
      sub: 'apple-user-1',
      email: 'p@icloud.com',
      emailVerified: true,
      nonce: hashNonce(rawNonce),
    });

    const result = await verifyAppleIdToken(token, { rawNonce }, { jwks });

    expect(result).toEqual({ sub: 'apple-user-1', email: 'p@icloud.com' });
  });

  it('rejects when the raw nonce does not hash to the token nonce claim (replay defense)', async () => {
    vi.stubEnv('APPLE_APP_BUNDLE_ID', BUNDLE_ID);
    const token = await signIdToken({
      sub: 'apple-user-1',
      nonce: hashNonce('the-real-nonce'),
    });

    await expect(
      verifyAppleIdToken(token, { rawNonce: 'a-different-nonce' }, { jwks }),
    ).rejects.toBeInstanceOf(AppleTokenError);
  });

  it('rejects when a raw nonce is supplied but the token carries no nonce claim', async () => {
    vi.stubEnv('APPLE_APP_BUNDLE_ID', BUNDLE_ID);
    const token = await signIdToken({ sub: 'apple-user-1' });

    await expect(
      verifyAppleIdToken(token, { rawNonce: 'expected-nonce' }, { jwks }),
    ).rejects.toBeInstanceOf(AppleTokenError);
  });

  it('rejects when the token carries a nonce claim but no raw nonce is supplied to check it', async () => {
    // A token bound to a nonce must not be accepted unbound — that would let a
    // captured nonce-bound token replay against a call that forgot to pass it.
    vi.stubEnv('APPLE_APP_BUNDLE_ID', BUNDLE_ID);
    const token = await signIdToken({
      sub: 'apple-user-1',
      nonce: hashNonce('some-nonce'),
    });

    await expect(verifyAppleIdToken(token, {}, { jwks })).rejects.toBeInstanceOf(AppleTokenError);
  });

  it('rejects a token signed by an untrusted key under the trusted kid (forged signature)', async () => {
    // The single most important regression case: a token with correct iss/aud/exp/sub
    // and the trusted kid, but signed by a DIFFERENT private key whose public half is
    // not in the JWKS. The signature must fail against Apple's published key — a
    // spoofed kid must never let an attacker-signed token through.
    vi.stubEnv('APPLE_APP_BUNDLE_ID', BUNDLE_ID);
    const token = await signIdToken(
      {
        sub: 'apple-user-1',
        email: 'attacker@icloud.com',
        emailVerified: true,
      },
      forgePrivateKey,
    );

    await expect(verifyAppleIdToken(token, {}, { jwks })).rejects.toBeInstanceOf(errors.JOSEError);
  });

  it('rejects a token minted for a different audience (another app)', async () => {
    vi.stubEnv('APPLE_APP_BUNDLE_ID', BUNDLE_ID);
    const token = await signIdToken({
      sub: 'apple-user-1',
      aud: 'com.attacker.app',
    });

    await expect(verifyAppleIdToken(token, {}, { jwks })).rejects.toBeInstanceOf(errors.JOSEError);
  });

  it('rejects a token from a non-Apple issuer', async () => {
    vi.stubEnv('APPLE_APP_BUNDLE_ID', BUNDLE_ID);
    const token = await signIdToken({
      sub: 'apple-user-1',
      iss: 'https://evil.example.com',
    });

    await expect(verifyAppleIdToken(token, {}, { jwks })).rejects.toBeInstanceOf(errors.JOSEError);
  });

  it('rejects an expired token', async () => {
    vi.stubEnv('APPLE_APP_BUNDLE_ID', BUNDLE_ID);
    const token = await signIdToken({ sub: 'apple-user-1', expiresIn: -60 });

    await expect(verifyAppleIdToken(token, {}, { jwks })).rejects.toBeInstanceOf(errors.JOSEError);
  });

  it('rejects a garbage (non-JWT) string', async () => {
    vi.stubEnv('APPLE_APP_BUNDLE_ID', BUNDLE_ID);

    await expect(verifyAppleIdToken('not-a-jwt', {}, { jwks })).rejects.toBeInstanceOf(
      errors.JOSEError,
    );
  });

  it('fails closed when no Apple bundle id is configured', async () => {
    // No bundle id set → the audience allow-list is empty. A verifier that matched
    // an empty allow-list would accept ANY audience, so this must throw BEFORE
    // verifying rather than trusting the token.
    const token = await signIdToken({ sub: 'apple-user-1' });

    await expect(verifyAppleIdToken(token, {}, { jwks })).rejects.toThrow();
  });
});
