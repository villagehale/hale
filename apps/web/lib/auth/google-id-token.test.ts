import { type KeyLike, SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyGoogleIdToken } from './google-id-token';

// A locally generated RS256 keypair stands in for Google's signing keys so the
// verify runs entirely offline (no network to googleapis.com). The public half
// becomes a local JWKS injected into verifyGoogleIdToken; the private half signs
// the id_tokens under test. Google signs id_tokens with RS256.
let privateKey: KeyLike;
let jwks: ReturnType<typeof createLocalJWKSet>;

const CLIENT_ID = '111-web.apps.googleusercontent.com';
const GOOGLE_ISS = 'https://accounts.google.com';

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  publicJwk.kid = 'test-key-1';
  publicJwk.alg = 'RS256';
  jwks = createLocalJWKSet({ keys: [publicJwk] });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function signIdToken(claims: {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  picture?: string;
  iss?: string;
  aud?: string;
  expiresIn?: string | number;
}): Promise<string> {
  const payload: Record<string, unknown> = {};
  if (claims.email) payload.email = claims.email;
  if (claims.emailVerified !== undefined) payload.email_verified = claims.emailVerified;
  if (claims.picture) payload.picture = claims.picture;
  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setSubject(claims.sub)
    .setIssuer(claims.iss ?? GOOGLE_ISS)
    .setAudience(claims.aud ?? CLIENT_ID)
    .setIssuedAt();
  jwt.setExpirationTime(claims.expiresIn ?? '1h');
  return jwt.sign(privateKey);
}

describe('verifyGoogleIdToken', () => {
  it('returns sub and email for a valid, email-verified Google id_token', async () => {
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', CLIENT_ID);
    const token = await signIdToken({
      sub: 'google-user-123',
      email: 'kid.parent@gmail.com',
      emailVerified: true,
    });

    const result = await verifyGoogleIdToken(token, { jwks });

    expect(result).toEqual({
      sub: 'google-user-123',
      email: 'kid.parent@gmail.com',
      picture: undefined,
    });
  });

  it('returns the profile picture when the id_token carries one (display only)', async () => {
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', CLIENT_ID);
    const token = await signIdToken({
      sub: 'google-user-123',
      email: 'p@gmail.com',
      emailVerified: true,
      picture: 'https://lh3.googleusercontent.com/a/photo',
    });

    const result = await verifyGoogleIdToken(token, { jwks });

    expect(result).toEqual({
      sub: 'google-user-123',
      email: 'p@gmail.com',
      picture: 'https://lh3.googleusercontent.com/a/photo',
    });
  });

  it('accepts the bare-host issuer variant "accounts.google.com"', async () => {
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', CLIENT_ID);
    const token = await signIdToken({
      sub: 'google-user-123',
      email: 'p@gmail.com',
      emailVerified: true,
      iss: 'accounts.google.com',
    });

    const result = await verifyGoogleIdToken(token, { jwks });

    expect(result).toEqual({ sub: 'google-user-123', email: 'p@gmail.com', picture: undefined });
  });

  it('returns email undefined when the id_token omits email', async () => {
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', CLIENT_ID);
    const token = await signIdToken({ sub: 'google-user-123' });

    const result = await verifyGoogleIdToken(token, { jwks });

    expect(result).toEqual({ sub: 'google-user-123', email: undefined, picture: undefined });
  });

  it('drops the email when email_verified is false', async () => {
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', CLIENT_ID);
    const token = await signIdToken({
      sub: 'google-user-123',
      email: 'unverified@gmail.com',
      emailVerified: false,
    });

    const result = await verifyGoogleIdToken(token, { jwks });

    expect(result).toEqual({ sub: 'google-user-123', email: undefined, picture: undefined });
  });

  it('drops the email when email_verified is absent (present email, no claim)', async () => {
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', CLIENT_ID);
    const token = await signIdToken({ sub: 'google-user-123', email: 'no-claim@gmail.com' });

    const result = await verifyGoogleIdToken(token, { jwks });

    expect(result).toEqual({ sub: 'google-user-123', email: undefined, picture: undefined });
  });

  it('accepts a token whose aud is the iOS client id when both ids are configured', async () => {
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', CLIENT_ID);
    vi.stubEnv('GOOGLE_OAUTH_IOS_CLIENT_ID', '222-ios.apps.googleusercontent.com');
    const token = await signIdToken({
      sub: 'google-user-123',
      email: 'p@gmail.com',
      emailVerified: true,
      aud: '222-ios.apps.googleusercontent.com',
    });

    const result = await verifyGoogleIdToken(token, { jwks });

    expect(result).toEqual({ sub: 'google-user-123', email: 'p@gmail.com', picture: undefined });
  });

  it('rejects a token minted for a different audience', async () => {
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', CLIENT_ID);
    const token = await signIdToken({
      sub: 'google-user-123',
      email: 'p@gmail.com',
      aud: 'attacker-999.apps.googleusercontent.com',
    });

    await expect(verifyGoogleIdToken(token, { jwks })).rejects.toThrow();
  });

  it('rejects a token from a non-Google issuer', async () => {
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', CLIENT_ID);
    const token = await signIdToken({
      sub: 'google-user-123',
      email: 'p@gmail.com',
      iss: 'https://evil.example.com',
    });

    await expect(verifyGoogleIdToken(token, { jwks })).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', CLIENT_ID);
    const token = await signIdToken({
      sub: 'google-user-123',
      email: 'p@gmail.com',
      expiresIn: -60,
    });

    await expect(verifyGoogleIdToken(token, { jwks })).rejects.toThrow();
  });

  it('rejects a garbage (non-JWT) string', async () => {
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', CLIENT_ID);

    await expect(verifyGoogleIdToken('not-a-jwt', { jwks })).rejects.toThrow();
  });

  it('fails closed when no Google client id is configured', async () => {
    // Neither client id set → the audience allow-list is empty. A verifier that
    // matched an empty allow-list would accept ANY audience, so this must throw
    // BEFORE verifying rather than trusting the token.
    const token = await signIdToken({ sub: 'google-user-123', email: 'p@gmail.com' });

    await expect(verifyGoogleIdToken(token, { jwks })).rejects.toThrow();
  });
});
