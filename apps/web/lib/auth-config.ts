// Single source of truth for whether auth is wired. Both the middleware and the
// (authed) layout read this so the auth gate and the dev-preview fallback can
// never disagree about which mode the app is in.
//
// Two providers can satisfy it: Google OAuth (its client id+secret), or email +
// password (Credentials needs only AUTH_SECRET to sign the session JWT). Auth is
// "configured" when EITHER is available — so an instance running credentials-only
// still protects routes and resolves families instead of falling into dev preview.
export function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}

export function credentialsConfigured(): boolean {
  return Boolean(process.env.AUTH_SECRET);
}

export function authConfigured(): boolean {
  return googleConfigured() || credentialsConfigured();
}

// Whether an unverified email is blocked from signing in. Default ON (rule #1 —
// most restrictive; an unverified account can't be used), so a public launch
// can't be flooded with fake/spam signups. Set REQUIRE_EMAIL_VERIFICATION=false
// only as an escape hatch (e.g. before the sending domain is live).
export function requireEmailVerification(): boolean {
  return process.env.REQUIRE_EMAIL_VERIFICATION !== 'false';
}
