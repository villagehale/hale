import { afterEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_USE_ASSISTED_OUTPUT_SCHEMA } from '../browser-use/assisted-engine';
import { parentTakesOverLiveView } from '../browser-use/keep-alive';
import {
  BROWSER_USE_PLAN_OUTPUT_SCHEMA,
  BROWSER_USE_SIGNUP_OUTPUT_SCHEMA,
  detailForLane,
} from '../browser-use/outcome';
import { LOGIN_CODE_TTL_MS } from '../login-link/code';
import { TAKEOVER_LINK_ENABLED_ENV, takeoverLinkEnabled } from './flag';
import {
  TAKEOVER_MIN_WINDOW_MS,
  TAKEOVER_RESUME_MARGIN_MS,
  isTakeoverPurpose,
  takeoverPurpose,
} from './purpose';
import { takeoverWindow } from './window';

// Pinned instants only: nothing here reads the wall clock.
const NOW = new Date('2026-12-01T12:01:00.000Z');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('takeoverPurpose', () => {
  it.each([
    ['needs_human', 'captcha', 'captcha'],
    ['needs_login', 'passkey', 'passkey'],
    ['needs_human', 'passkey', 'passkey'],
    ['needs_login', 'verification_code', 'code'],
    ['needs_human', 'verification_code', 'code'],
    ['needs_login', 'login_wall', 'sign_in'],
    ['needs_human', 'login_wall', 'sign_in'],
    ['needs_login', 'none', 'sign_in'],
  ])('%s / %s is a %s takeover', (outcome, detail, purpose) => {
    expect(takeoverPurpose(outcome, detail)).toBe(purpose);
  });

  it.each([
    // A rejected account password keeps its own saved-login card.
    ['needs_login', 'password_rejected'],
    // Checkout and filled-form hand-offs are not takeovers.
    ['needs_human', 'security_code'],
    ['needs_human', 'no_saved_card'],
    ['needs_human', 'price_change'],
    ['needs_human', 'waiver'],
    ['needs_human', 'medical'],
    ['needs_human', 'none'],
    ['needs_human', 'session_not_found'],
    ['reached_checkout', 'none'],
    ['ready_for_parent', 'none'],
    ['not_open', 'captcha'],
    ['error', 'captcha'],
  ])('%s / %s is not a takeover', (outcome, detail) => {
    expect(takeoverPurpose(outcome, detail)).toBeNull();
  });

  it('knows its own steps and nothing else', () => {
    for (const purpose of ['sign_in', 'code', 'passkey', 'captcha']) {
      expect(isTakeoverPurpose(purpose)).toBe(true);
    }
    for (const other of ['sms_code', 'login_wall', '', null, 3]) {
      expect(isTakeoverPurpose(other)).toBe(false);
    }
  });
});

describe('takeoverWindow', () => {
  it('closes the link before the browser does', () => {
    const browserEndsAt = new Date(NOW.getTime() + 15 * 60_000);
    const window = takeoverWindow({ now: NOW, browserEndsAt });
    expect(window?.expiresAt.toISOString()).toBe(
      new Date(browserEndsAt.getTime() - TAKEOVER_RESUME_MARGIN_MS).toISOString(),
    );
    expect(window?.minutes).toBe(13);
  });

  it('never outlives the card itself', () => {
    const browserEndsAt = new Date(NOW.getTime() + 4 * 60 * 60_000);
    const window = takeoverWindow({ now: NOW, browserEndsAt });
    expect(window?.expiresAt.toISOString()).toBe(
      new Date(NOW.getTime() + LOGIN_CODE_TTL_MS).toISOString(),
    );
  });

  it('offers nothing when too little time is left', () => {
    const browserEndsAt = new Date(
      NOW.getTime() + TAKEOVER_RESUME_MARGIN_MS + TAKEOVER_MIN_WINDOW_MS - 1,
    );
    expect(takeoverWindow({ now: NOW, browserEndsAt })).toBeNull();
    expect(
      takeoverWindow({
        now: NOW,
        browserEndsAt: new Date(browserEndsAt.getTime() + 1),
      }),
    ).not.toBeNull();
  });
});

describe('TAKEOVER_LINK_ENABLED', () => {
  it('is on only for exactly `true`', () => {
    vi.stubEnv(TAKEOVER_LINK_ENABLED_ENV, 'true');
    expect(takeoverLinkEnabled()).toBe(true);
  });

  it.each([undefined, '', 'TRUE', 'True', 'true\n', ' true', '1', 'on', 'yes', 'false'])(
    'is off for %j',
    (value) => {
      vi.stubEnv(TAKEOVER_LINK_ENABLED_ENV, value);
      expect(takeoverLinkEnabled()).toBe(false);
    },
  );
});

describe('the live view stays for the parent', () => {
  it('keeps a captcha and a passkey only with the takeover link on', () => {
    expect(parentTakesOverLiveView('needs_human', 'captcha')).toBe(false);
    expect(parentTakesOverLiveView('needs_human', 'captcha', true)).toBe(true);
    expect(parentTakesOverLiveView('needs_human', 'passkey')).toBe(false);
    expect(parentTakesOverLiveView('needs_human', 'passkey', true)).toBe(true);
  });

  it('leaves every other answer where it was', () => {
    for (const takeover of [false, true]) {
      expect(parentTakesOverLiveView('needs_login', 'login_wall', takeover)).toBe(true);
      expect(parentTakesOverLiveView('needs_human', 'verification_code', takeover)).toBe(true);
      expect(parentTakesOverLiveView('needs_human', 'session_not_found', takeover)).toBe(false);
      expect(parentTakesOverLiveView('reached_checkout', 'none', takeover)).toBe(true);
      expect(parentTakesOverLiveView('sold_out', 'none', takeover)).toBe(false);
    }
  });

  it('reads a passkey as a sign-in wall on a lane without the link', () => {
    expect(detailForLane('passkey', false)).toBe('login_wall');
    expect(detailForLane('passkey', true)).toBe('passkey');
    expect(detailForLane('captcha', false)).toBe('captcha');
  });
});

describe('the passkey detail belongs to the plan and assisted lanes', () => {
  const detailEnum = (schema: Record<string, unknown>) =>
    (schema.properties as { detail: { enum: string[] } }).detail.enum;

  it('leaves the one-shot lane’s schema as it was', () => {
    expect(detailEnum(BROWSER_USE_SIGNUP_OUTPUT_SCHEMA)).toEqual([
      'none',
      'captcha',
      'verification_code',
      'login_wall',
      'password_rejected',
      'waiting_room',
      'timed_open',
      'waiver',
      'medical',
      'unexpected_field',
      'session_not_found',
      'price_change',
      'page_error',
    ]);
  });

  it('offers it to the two lanes a takeover can pick up', () => {
    expect(detailEnum(BROWSER_USE_PLAN_OUTPUT_SCHEMA)).toContain('passkey');
    expect(detailEnum(BROWSER_USE_ASSISTED_OUTPUT_SCHEMA)).toContain('passkey');
  });
});
