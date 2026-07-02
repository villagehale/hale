/**
 * Token exchange with the Hale backend. The mobile app uses a token flow (not web
 * cookies): these POST to the mobile-auth endpoints on apps/web and return the
 * minted session token, which the app then carries as a Bearer token. Kept behind
 * this interface so the sign-in screen stays unchanged.
 *
 * These are the pre-auth calls (no token yet), so they use fetch directly rather
 * than the api() client — a bad login is a 401 the screen shows inline, not a
 * session expiry that bounces to sign-in. Every non-2xx maps to ONE generic
 * message; the server already returns a non-revealing generic error.
 */

import { API_BASE } from './api-client';

export type AuthResult = { token: string };

const GENERIC_PASSWORD_ERROR = "That email and password didn't match. Please try again.";
const GENERIC_GOOGLE_ERROR = "Couldn't sign in with Google. Please try again.";

async function exchange(path: string, payload: unknown, genericError: string): Promise<AuthResult> {
  if (!API_BASE) throw new Error(genericError);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error(genericError);
  }

  if (!res.ok) throw new Error(genericError);

  const body = (await res.json().catch(() => null)) as { token?: string } | null;
  if (!body?.token) throw new Error(genericError);
  return { token: body.token };
}

export async function exchangeGoogleIdToken(idToken: string): Promise<AuthResult> {
  return exchange('/api/mobile/auth/google', { idToken }, GENERIC_GOOGLE_ERROR);
}

export async function signInWithPassword(email: string, password: string): Promise<AuthResult> {
  return exchange('/api/mobile/auth/password', { email, password }, GENERIC_PASSWORD_ERROR);
}
