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

import { API_BASE, ApiError, api } from './api-client';
import type { OnboardingInput } from './onboarding-draft';

export type AuthResult = { token: string };

const GENERIC_PASSWORD_ERROR = "That email and password didn't match. Please try again.";
const GENERIC_GOOGLE_ERROR = "Couldn't sign in with Google. Please try again.";
const GENERIC_SIGNUP_ERROR = "Couldn't create your account just now. Please try again.";
const GENERIC_ONBOARDING_ERROR = "Couldn't finish setting up your family — please try again.";
const REGION_UNAVAILABLE_ERROR = "Hale isn't available in your region yet — we're Canada-first.";

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

/**
 * Native email+password sign-up. Verification is required, so the server NEVER
 * mints a session here — it fires the verification email and returns
 * `check_email`. A pre-auth call (no token yet), so it uses fetch directly like
 * the sign-in helpers; every non-2xx maps to one generic message (the server
 * already returns a non-revealing error, incl. the account-enumeration defense).
 */
export async function signUpWithPassword(
  email: string,
  password: string,
): Promise<{ status: 'check_email' }> {
  if (!API_BASE) throw new Error(GENERIC_SIGNUP_ERROR);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/mobile/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    throw new Error(GENERIC_SIGNUP_ERROR);
  }

  if (!res.ok) throw new Error(GENERIC_SIGNUP_ERROR);
  const body = (await res.json().catch(() => null)) as { status?: string } | null;
  if (body?.status !== 'check_email') throw new Error(GENERIC_SIGNUP_ERROR);
  return { status: 'check_email' };
}

/**
 * Complete onboarding — POST the collected intake to the mobile route, which is a
 * thin mapper over the SHARED completeOnboarding (the 4 consents, the Canada
 * region gate, and the atomic child-PII write all live server-side, rule #1). Goes
 * through the api() client so the Bearer token is attached. Idempotent: a repeat
 * submit for a user who already has a family returns `completed` without
 * re-provisioning children — safe for the resume-after-verification path.
 *
 * A 401 is handled by the client (clears the session, bounces to sign-in). A 422
 * is the region gate, surfaced with the Canada-first copy; any other error maps to
 * one generic message.
 */
export async function submitOnboarding(
  input: OnboardingInput,
): Promise<{ status: 'completed'; familyId: string }> {
  try {
    return await api<{ status: 'completed'; familyId: string }>('/api/mobile/onboarding', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 401) throw e; // already bounced to sign-in; propagate as-is.
      if (e.status === 422) throw new Error(REGION_UNAVAILABLE_ERROR);
    }
    throw new Error(GENERIC_ONBOARDING_ERROR);
  }
}
