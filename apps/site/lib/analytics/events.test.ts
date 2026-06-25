import { describe, expect, it } from 'vitest';
import { buildEvent } from './events';

/**
 * The waitlist captures a signup, but the email a visitor typed must NEVER reach
 * product analytics (hard rule #1). `buildEvent` is the gate: it keeps the event
 * name and coarse primitives while dropping any identifying or non-primitive
 * property. Expected values are derived from that requirement.
 */

describe('site buildEvent privacy gate', () => {
  it('fires waitlist_signup with no properties by default', () => {
    const built = buildEvent('waitlist_signup');
    expect(built.event).toBe('waitlist_signup');
    expect(built.properties).toEqual({});
  });

  it('never lets an email or name through', () => {
    const built = buildEvent('waitlist_signup', {
      email: 'sam@example.com',
      name: 'Sam',
      referrer: 'twitter',
    });
    expect(built.properties).toEqual({ referrer: 'twitter' });
    expect(JSON.stringify(built)).not.toContain('sam@example.com');
  });
});
