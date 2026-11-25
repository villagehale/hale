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

/**
 * VIL-718 · a step only the parent can do, for the takeover link's Preview runs. A session
 * carrying this cookie meets the step before the registration form; passing it sets
 * `passed`. A sign-in wall needs no cookie: a session whose session cookie is not
 * `signed-in` already lands on the sign-in page.
 */
export const SIGNUP_TEST_CHALLENGE_COOKIE = 'hale_signup_test_challenge';
export const SIGNUP_TEST_CHALLENGES = ['code', 'passkey', 'captcha'] as const;
export type SignupTestChallenge = (typeof SIGNUP_TEST_CHALLENGES)[number];
/** The one-time code the fake provider "texted". Shown on its page: it is a test site. */
export const SIGNUP_TEST_CODE = '424242';
/** The word the fake "prove you are human" check asks for. */
export const SIGNUP_TEST_CAPTCHA_WORD = 'harbor';

export function signupTestChallenge(raw: string | undefined): SignupTestChallenge | null {
  return (SIGNUP_TEST_CHALLENGES as readonly string[]).includes(raw ?? '')
    ? (raw as SignupTestChallenge)
    : null;
}

/** Whether an answer passes the step. A passkey never does: there is none on this browser. */
export function signupTestChallengePassed(kind: SignupTestChallenge, answer: string): boolean {
  if (kind === 'code') return answer.trim() === SIGNUP_TEST_CODE;
  if (kind === 'captcha') return answer.trim().toLowerCase() === SIGNUP_TEST_CAPTCHA_WORD;
  return false;
}

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

/**
 * Playwright storageState for a parent who signed in on this host. With `challenge`, the
 * session meets that step before the form (VIL-718); a `sessionValue` other than
 * `signed-in` meets the sign-in wall.
 */
export function signupTestStorageState(
  host: string,
  sessionValue = 'signed-in',
  challenge: SignupTestChallenge | null = null,
): unknown {
  const cookie = (name: string, value: string) => ({
    name,
    value,
    domain: host,
    path: '/',
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax' as const,
  });
  return {
    cookies: [
      cookie(SIGNUP_TEST_SESSION_COOKIE, sessionValue),
      ...(challenge ? [cookie(SIGNUP_TEST_CHALLENGE_COOKIE, challenge)] : []),
    ],
    origins: [],
  };
}
