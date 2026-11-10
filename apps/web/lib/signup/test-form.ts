/**
 * Preview-only Harbor Rec test registration (VIL-470).
 *
 * A public form Hale hosts on Preview so Browser Use can fill a page we
 * control. Production (`VERCEL_ENV=production`) does not serve it. Nothing
 * here is a parent-facing Hale sentence, and nothing seeds a family.
 */

export const SIGNUP_TEST_FORM_PATH = '/demo/signup-test';
export const SIGNUP_TEST_SESSION_COOKIE = 'hale_signup_test_session';
export const SIGNUP_TEST_CART_COOKIE = 'hale_signup_test_cart';

export const SIGNUP_TEST_PROVIDER = 'Harbor Rec';
export const SIGNUP_TEST_ACTIVITY = 'Parent & Tot Swim';
export const SIGNUP_TEST_PRICE_CENTS = 4000;

export const SIGNUP_TEST_SESSIONS = [
  {
    id: 'tue-1630',
    label: 'Tue 4:30',
    startsAt: '2026-11-03T20:30:00.000Z',
    endsAt: '2026-11-03T21:15:00.000Z',
    full: false,
    priceCents: SIGNUP_TEST_PRICE_CENTS,
  },
  {
    id: 'sat-1000',
    label: 'Sat 10:00',
    startsAt: '2026-11-07T14:00:00.000Z',
    endsAt: '2026-11-07T14:45:00.000Z',
    full: false,
    priceCents: SIGNUP_TEST_PRICE_CENTS,
  },
] as const;

export type SignupTestSessionId = (typeof SIGNUP_TEST_SESSIONS)[number]['id'];

export interface SignupTestCart {
  childFirstName: string;
  parentEmail: string;
  postalCode: string;
  sessionId: SignupTestSessionId;
}

/** On for local `next start` and Vercel Preview. Off on production. */
export function signupTestFormEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.VERCEL_ENV !== 'production';
}

export function signupTestSession(id: string): (typeof SIGNUP_TEST_SESSIONS)[number] | null {
  return SIGNUP_TEST_SESSIONS.find((session) => session.id === id) ?? null;
}

export function parseSignupTestCart(raw: string | undefined): SignupTestCart | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<SignupTestCart>;
    if (
      typeof value.childFirstName !== 'string' ||
      typeof value.parentEmail !== 'string' ||
      typeof value.postalCode !== 'string' ||
      typeof value.sessionId !== 'string'
    ) {
      return null;
    }
    if (!signupTestSession(value.sessionId)) return null;
    return {
      childFirstName: value.childFirstName,
      parentEmail: value.parentEmail,
      postalCode: value.postalCode,
      sessionId: value.sessionId as SignupTestSessionId,
    };
  } catch {
    return null;
  }
}

/** Playwright storageState for a parent who signed in on this host. */
export function signupTestStorageState(host: string, sessionValue = 'signed-in'): unknown {
  return {
    cookies: [
      {
        name: SIGNUP_TEST_SESSION_COOKIE,
        value: sessionValue,
        domain: host,
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax' as const,
      },
    ],
    origins: [],
  };
}
