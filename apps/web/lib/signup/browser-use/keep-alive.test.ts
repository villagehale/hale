import { describe, expect, it } from 'vitest';
import { CHECKOUT_KEEP_ALIVE_SECONDS, parentTakesOverLiveView } from './keep-alive';

describe('parentTakesOverLiveView', () => {
  it('keeps the browser only for a real login or a parent hand-off', () => {
    expect(parentTakesOverLiveView('needs_login', 'login_wall')).toBe(true);
    expect(parentTakesOverLiveView('needs_login', 'none')).toBe(true);
    expect(parentTakesOverLiveView('ready_for_parent', 'none')).toBe(true);
    expect(parentTakesOverLiveView('reached_checkout', 'none')).toBe(true);
    expect(parentTakesOverLiveView('payment_not_approved', 'none')).toBe(true);
    expect(parentTakesOverLiveView('needs_human', 'security_code')).toBe(true);
    expect(parentTakesOverLiveView('needs_human', 'verification_code')).toBe(true);
    expect(parentTakesOverLiveView('needs_human', 'waiver')).toBe(true);
  });

  it('closes the browser on needs_human and session_not_found', () => {
    expect(parentTakesOverLiveView('needs_human', 'session_not_found')).toBe(false);
    expect(parentTakesOverLiveView('needs_human', 'captcha')).toBe(false);
    expect(parentTakesOverLiveView('needs_human', 'page_error')).toBe(false);
    expect(parentTakesOverLiveView('needs_human', 'none')).toBe(false);
    expect(parentTakesOverLiveView('sold_out', 'none')).toBe(false);
    expect(parentTakesOverLiveView('error', 'session_not_found')).toBe(false);
  });

  it('is 15 minutes, never the four-hour API default', () => {
    expect(CHECKOUT_KEEP_ALIVE_SECONDS).toBe(900);
    expect(CHECKOUT_KEEP_ALIVE_SECONDS).toBeLessThan(14400);
  });
});
