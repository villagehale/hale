/**
 * Token exchange with the Hale backend. The mobile app uses a token flow (not
 * web cookies), so these hit a mobile-auth endpoint on apps/web that does NOT
 * exist yet — wiring is a TODO gated on that endpoint + the env base URL.
 * Kept behind this interface so the screens stay unchanged when it lands.
 */

export type AuthResult = { token: string };

// TODO(mobile-auth): point at the real API base (expo-constants extra / EXPO_PUBLIC_*).
// const API_BASE = process.env.EXPO_PUBLIC_API_BASE;

export async function exchangeGoogleIdToken(_idToken: string): Promise<AuthResult> {
  // TODO(mobile-auth): POST {idToken} → /api/mobile/auth/google, return the session token.
  throw new Error('Google sign-in is not wired yet — backend mobile-auth endpoint pending.');
}

export async function signInWithPassword(_email: string, _password: string): Promise<AuthResult> {
  // TODO(mobile-auth): POST {email,password} → /api/mobile/auth/password, return the session token.
  throw new Error('Email sign-in is not wired yet — backend mobile-auth endpoint pending.');
}
