// Single source of truth for whether portal auth is wired. Both the middleware
// and the (authed) layout read this so the auth gate and the dev-preview
// fallback can never disagree about which mode the app is in.
//
// AUTH_SECRET signs every session JWT — phone sign-in, the texted /connect
// link, and MCP secrets. It is the only switch. The Gmail/Calendar connector
// reads its own client id (GOOGLE_CONNECTOR_CLIENT_*, falling back to
// GOOGLE_OAUTH_CLIENT_*); those do not open this gate and do not register a
// sign-in provider.
export function authConfigured(): boolean {
  return Boolean(process.env.AUTH_SECRET);
}
