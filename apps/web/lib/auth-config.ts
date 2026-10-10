// Single source of truth for whether auth is wired. Both the middleware and the
// (authed) layout read this so the auth gate and the dev-preview fallback can
// never disagree about which mode the app is in.
//
// Two things can satisfy it: Google OAuth (its client id + secret), or AUTH_SECRET,
// which signs every session JWT — phone sign-in, the texted /connect link, and
// MCP secrets. Auth is "configured" when EITHER is available, so a phone-only
// deploy still protects routes instead of falling into dev preview.
export function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}

export function authConfigured(): boolean {
  return googleConfigured() || Boolean(process.env.AUTH_SECRET);
}
