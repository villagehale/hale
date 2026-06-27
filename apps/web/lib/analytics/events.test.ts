import { describe, expect, it } from 'vitest';
import { buildEvent } from './events';

/**
 * The privacy gate for product analytics (hard rule #1). Hale handles
 * children's data, so an event must NEVER carry PII or child/teen content. These
 * tests assert `buildEvent` drops identifying and non-primitive properties while
 * keeping coarse counts/booleans/enums — and that the event name itself always
 * survives so we still get the count. Expected values are derived from the
 * privacy requirement, not from the function's current output.
 */

describe('buildEvent privacy gate', () => {
  it('always preserves the event name even when every property is stripped', () => {
    const built = buildEvent('share', { childName: 'Maya', message: 'hi' });
    expect(built.event).toBe('share');
    expect(built.properties).toEqual({});
  });

  it('drops every property whose key names personal or child/teen data', () => {
    const built = buildEvent('onboarding_completed', {
      name: 'Maya Ramos',
      parentName: 'Sam',
      email: 'sam@example.com',
      phone: '416-555-0100',
      homeAddress: '123 Main St',
      childDob: '2020-01-01',
      birthDate: '2020-01-01',
      childId: 'abc',
      teenContent: 'secret',
      message: 'a message',
      messageBody: 'body',
      questionText: 'why?',
      noteContent: 'note',
      location: 'Toronto',
      lat: 43.6,
      lng: -79.3,
      postalCode: 'M5V',
      ipAddress: '1.2.3.4',
      authToken: 'xyz',
    });
    expect(built.properties).toEqual({});
  });

  it('drops non-primitive values (objects/arrays) that could smuggle PII', () => {
    const built = buildEvent('ask_hale', {
      payload: { childName: 'Maya' },
      tags: ['a', 'b'],
      callback: 1,
    });
    // `payload` and `tags` are non-primitive → dropped; `callback` survives (primitive, non-identifying key).
    expect(built.properties).toEqual({ callback: 1 });
  });

  it('keeps coarse, non-identifying primitives the call sites actually send', () => {
    const built = buildEvent('onboarding_completed', {
      kidCount: 2,
      planTier: 'plus',
      scoped: true,
    });
    expect(built.properties).toEqual({ kidCount: 2, planTier: 'plus', scoped: true });
  });

  it('strips a "child"-keyed count even though it is just a number (strict default)', () => {
    // The gate errs safe: any key containing "child" is dropped, so a careless
    // `childCount`/`childName` mix-up can never leak the latter. Call sites use
    // neutral keys (kidCount, scoped) to send the coarse aggregate instead.
    const built = buildEvent('onboarding_completed', { childCount: 2 });
    expect(built.properties).toEqual({});
  });

  it('keeps preview_submitted coarse and drops any location-keyed free text', () => {
    const built = buildEvent('preview_submitted', {
      stage: 'toddler',
      hasArea: true,
      intentCount: 3,
      postalCode: 'M5V 2T6',
      areaLocation: 'Toronto',
    });
    // The call site sends ONLY the coarse trio; the gate additionally drops any
    // location-keyed free text (postal/location) so a careless area string can
    // never narrow a family's whereabouts.
    expect(built.properties).toEqual({ stage: 'toddler', hasArea: true, intentCount: 3 });
    expect(JSON.stringify(built)).not.toContain('M5V');
    expect(JSON.stringify(built)).not.toContain('Toronto');
  });

  it('keeps the signup method but never the email used to sign up', () => {
    const built = buildEvent('signup_completed', { method: 'email', email: 'sam@example.com' });
    expect(built.properties).toEqual({ method: 'email' });
    expect(JSON.stringify(built)).not.toContain('sam@example.com');
  });

  it('fires the first-activation funnel events with no properties', () => {
    expect(buildEvent('first_activity_added').properties).toEqual({});
    expect(buildEvent('first_ask').properties).toEqual({});
    expect(buildEvent('first_invite').properties).toEqual({});
  });

  it('never lets a name/email/content field through under any casing', () => {
    const built = buildEvent('endorse', {
      ChildName: 'Maya',
      EMAIL: 'x@y.z',
      Body: 'text',
      count: 7,
    });
    expect(built.properties).toEqual({ count: 7 });
    const serialized = JSON.stringify(built);
    expect(serialized).not.toContain('Maya');
    expect(serialized).not.toContain('x@y.z');
  });
});
