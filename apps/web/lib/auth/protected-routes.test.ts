import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROTECTED_PREFIXES, isProtectedPath } from './protected-routes';

/**
 * VIL-256 — the Edge gate is defense in depth for the `(authed)` route group. Its
 * failure mode is silent: a route the layout protects but the middleware doesn't
 * list still works, so nothing surfaces the gap. The first test closes it by
 * deriving the expected list from the route group on disk rather than from this
 * module, so a new authed route fails here the day it lands.
 */

const authedRoutes = readdirSync(fileURLToPath(new URL('../../app/(authed)', import.meta.url)), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => `/${entry.name}`);

describe('the Edge gate covers the authed route group', () => {
  it('gates every route the (authed) group renders', () => {
    expect(authedRoutes.length).toBeGreaterThan(0);
    for (const route of authedRoutes) {
      expect(isProtectedPath(route), `${route} is rendered by (authed) but not gated`).toBe(true);
    }
  });

  it('gates nothing that the group does not render', () => {
    for (const prefix of PROTECTED_PREFIXES) {
      expect(authedRoutes, `${prefix} is gated but no (authed) route renders it`).toContain(prefix);
    }
  });
});

describe('isProtectedPath', () => {
  it('gates a sub-path, so no bookmark under a gated route escapes', () => {
    expect(isProtectedPath('/approvals/8f2c')).toBe(true);
    expect(isProtectedPath('/messages/thread-1')).toBe(true);
  });

  it('does not gate a public route, nor one that merely shares a prefix', () => {
    for (const path of ['/sign-in', '/onboarding', '/unsubscribe', '/', '/planner', '/savedish']) {
      expect(isProtectedPath(path)).toBe(false);
    }
  });
});
