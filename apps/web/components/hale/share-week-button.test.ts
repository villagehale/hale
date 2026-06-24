import { describe, expect, it } from 'vitest';
import { errorMessage } from './share-week-button';

/**
 * T1: POST /api/village/share returns distinct non-200 codes for distinct
 * reasons — 404 no plan, 401 signed out, 403/501 unavailable, 5xx/network
 * transient. The button must not collapse them into one "try again". Expected
 * meanings are derived from the route's documented status contract, not copied
 * from the component's wording.
 */
describe('errorMessage', () => {
  it('404 names the missing week plan, not a retry', () => {
    const msg = errorMessage(404);
    expect(msg).toMatch(/week plan/i);
    expect(msg).not.toMatch(/try again/i);
  });

  it('401 asks the parent to sign in', () => {
    expect(errorMessage(401)).toMatch(/sign in/i);
  });

  it('403 and 501 read as unavailable, never sign-in or retry', () => {
    for (const status of [403, 501]) {
      const msg = errorMessage(status);
      expect(msg).toMatch(/available/i);
      expect(msg).not.toMatch(/sign in|try again/i);
    }
  });

  it('5xx and network (0) are the only retryable reasons', () => {
    for (const status of [0, 500, 503]) {
      expect(errorMessage(status)).toMatch(/try again/i);
    }
  });

  it('gives each reason its own message — no blanket fallback', () => {
    const messages = [404, 401, 403, 500].map(errorMessage);
    expect(new Set(messages).size).toBe(messages.length);
  });
});
