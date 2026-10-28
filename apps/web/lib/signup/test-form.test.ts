import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SIGNUP_TEST_ACTIVITY,
  SIGNUP_TEST_FORM_PATH,
  SIGNUP_TEST_SESSIONS,
  SIGNUP_TEST_SESSION_COOKIE,
  parseSignupTestCart,
  signupTestFormEnabled,
  signupTestStorageState,
} from './test-form';

const DEMO = fileURLToPath(new URL('../../app/demo/signup-test', import.meta.url));

describe('Preview Harbor Rec test form', () => {
  it('is off in production and on for Preview or local', () => {
    expect(signupTestFormEnabled({ VERCEL_ENV: 'production' })).toBe(false);
    expect(signupTestFormEnabled({ VERCEL_ENV: 'preview' })).toBe(true);
    expect(signupTestFormEnabled({})).toBe(true);
  });

  it('exposes the fields Browser Use fills, including checkout it must not pay', () => {
    const register = readFileSync(`${DEMO}/register/page.tsx`, 'utf8');
    const checkout = readFileSync(`${DEMO}/checkout/page.tsx`, 'utf8');
    const login = readFileSync(`${DEMO}/login/page.tsx`, 'utf8');
    expect(register).toContain('name="child_first_name"');
    expect(register).toContain('name="parent_email"');
    expect(register).toContain('name="postal_code"');
    expect(register).toContain('name="session"');
    expect(register).toContain('SIGNUP_TEST_SESSIONS');
    expect(SIGNUP_TEST_SESSIONS[0].id).toBe('tue-1630');
    expect(checkout).toContain('name="card_number"');
    expect(checkout).toContain('never charges');
    expect(login).toContain('name="password"');
    expect(SIGNUP_TEST_ACTIVITY).toBe('Parent & Tot Swim');
    expect(SIGNUP_TEST_FORM_PATH).toBe('/demo/signup-test');
  });

  it('builds a storage state without a password-named cookie', () => {
    const state = signupTestStorageState('hale-preview.vercel.app') as {
      cookies: { name: string }[];
    };
    expect(state.cookies[0]?.name).toBe(SIGNUP_TEST_SESSION_COOKIE);
    expect(state.cookies.some((cookie) => /pass/i.test(cookie.name))).toBe(false);
  });

  it('parses a cart only when the session is one Hale listed', () => {
    expect(
      parseSignupTestCart(
        JSON.stringify({
          childFirstName: 'Ada',
          parentEmail: 'ada@example.test',
          postalCode: 'M5V2T6',
          sessionId: 'tue-1630',
        }),
      )?.sessionId,
    ).toBe('tue-1630');
    expect(
      parseSignupTestCart(
        JSON.stringify({
          childFirstName: 'Ada',
          parentEmail: 'ada@example.test',
          postalCode: 'M5V2T6',
          sessionId: 'invented',
        }),
      ),
    ).toBeNull();
  });

  it('404s the login and register doors in production', () => {
    const login = readFileSync(
      fileURLToPath(new URL('../../app/api/demo/signup-test/login/route.ts', import.meta.url)),
      'utf8',
    );
    const register = readFileSync(
      fileURLToPath(new URL('../../app/api/demo/signup-test/register/route.ts', import.meta.url)),
      'utf8',
    );
    expect(login).toContain('signupTestFormEnabled');
    expect(register).toContain('signupTestFormEnabled');
  });
});
