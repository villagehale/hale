/**
 * Pure request-shaping for Sign in with Apple, kept native-import-free so it is
 * unit-testable (the button component wiring the native SDK is not). The Apple
 * credential returned by AppleAuthentication.signInAsync carries an OPTIONAL
 * identityToken (string | null); it is the only field the server needs — the
 * subject, email, and nonce all live inside that signed JWT. This extracts it and
 * fails closed when it is absent (no identityToken → nothing to verify server-side,
 * so there is no session to mint).
 */
export function appleIdentityToken(credential: { identityToken: string | null }): string {
  const token = credential.identityToken;
  if (!token) {
    throw new Error('Apple sign-in returned no identity token');
  }
  return token;
}
