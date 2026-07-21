import { describe, expect, it } from 'vitest';
import { notificationRouteFor, routeForDeepLink } from './push-deep-link';

/**
 * The push deep-link → app route mapping. Expected values are derived from the spec:
 * a notification's data.deepLink is a compact, provider-agnostic token that resolves to
 * exactly one whitelisted surface (/plan, /approval/:id, /thread/:id) — anything else
 * (unknown token, missing/traversal id, non-string data) resolves to null so a push can
 * never navigate the app to an arbitrary path.
 */

describe('routeForDeepLink', () => {
  it('maps the plan token to /plan', () => {
    expect(routeForDeepLink('plan')).toBe('/plan');
  });

  it('maps an approval token to its detail route', () => {
    expect(routeForDeepLink('approval:9c161925-a33f-4ef3-85d7-b2f1103ae597')).toBe(
      '/approval/9c161925-a33f-4ef3-85d7-b2f1103ae597',
    );
  });

  it('maps a thread token to its detail route', () => {
    expect(routeForDeepLink('thread:abc-123')).toBe('/thread/abc-123');
  });

  it('trims surrounding whitespace before resolving', () => {
    expect(routeForDeepLink('  plan  ')).toBe('/plan');
  });

  it.each([
    ['an unknown token', 'settings'],
    ['a prefixed token with no id', 'approval:'],
    ['a path-traversal id', 'approval:../../evil'],
    ['a slash in the id', 'thread:a/b'],
    ['a bare prefix with no colon', 'thread'],
    ['an empty string', ''],
  ])('returns null for %s', (_label, token) => {
    expect(routeForDeepLink(token)).toBeNull();
  });
});

describe('notificationRouteFor', () => {
  it('reads data.deepLink and resolves it', () => {
    expect(notificationRouteFor({ deepLink: 'plan' })).toBe('/plan');
    expect(notificationRouteFor({ deepLink: 'approval:abc-123' })).toBe('/approval/abc-123');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a non-object', 'plan'],
    ['an object with no deepLink', { foo: 'bar' }],
    ['a non-string deepLink', { deepLink: 42 }],
    ['an unknown deepLink', { deepLink: 'nope' }],
  ])('returns null for %s', (_label, data) => {
    expect(notificationRouteFor(data)).toBeNull();
  });
});
