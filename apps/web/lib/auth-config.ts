// Single source of truth for whether auth is wired. Both the middleware and the
// (authed) layout read this so the auth gate and the dev-preview fallback can
// never disagree about which mode the app is in. Auth-provider-agnostic: it keys
// off the Google OAuth credentials Auth.js needs to mint a session.
export function authConfigured(): boolean {
  return Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}
