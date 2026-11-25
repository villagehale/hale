import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureFunnelEvent, signupFunnelExtras } from './funnel';
import { createFakeFunnelSender } from './funnel.testkit';
import { hashFamilyId } from './server-capture';

const FLAG = 'FUNNEL_ATTRIBUTION_ENABLED';
const ON = { [FLAG]: 'true' };
const FAMILY = 'fam-funnel-1';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('captureFunnelEvent', () => {
  it('sends the event on the hashed family id with the attribution keys', async () => {
    const fake = createFakeFunnelSender();
    const outcome = await captureFunnelEvent(
      {
        event: 'checkout_started',
        familyId: FAMILY,
        attribution: { utm_source: 'google', gclid: 'Cj0Click', source_code: 'poster-oakville' },
        properties: { plan: 'plus', period: 'annual' },
      },
      { sender: fake.sender, env: ON },
    );
    expect(outcome).toBe('sent');
    expect(fake.sent).toEqual([
      {
        event: 'checkout_started',
        distinctId: hashFamilyId(FAMILY),
        properties: {
          plan: 'plus',
          period: 'annual',
          utm_source: 'google',
          gclid: 'Cj0Click',
          source_code: 'poster-oakville',
        },
      },
    ]);
  });

  it.each(['email', 'phone', 'name', 'child_age', 'parent_email'])(
    'refuses the whole event when a property is identifying (%s)',
    async (key) => {
      const fake = createFakeFunnelSender();
      const outcome = await captureFunnelEvent(
        {
          event: 'checkout_completed',
          familyId: FAMILY,
          attribution: { utm_source: 'google' },
          properties: { plan: 'plus', [key]: 'leak' },
        },
        { sender: fake.sender, env: ON },
      );
      expect(outcome).toBe('refused_identifying');
      expect(fake.sent).toEqual([]);
    },
  );

  it('refuses an identifying person property too', async () => {
    const fake = createFakeFunnelSender();
    const outcome = await captureFunnelEvent(
      {
        event: 'checkout_completed',
        familyId: FAMILY,
        attribution: {},
        properties: { plan: 'plus' },
        set: { plan: 'plus', email: 'parent@example.com' },
      },
      { sender: fake.sender, env: ON },
    );
    expect(outcome).toBe('refused_identifying');
    expect(fake.sent).toEqual([]);
  });

  it.each([undefined, 'TRUE', 'true\n', '1', 'false'])(
    'sends nothing while the flag is %s',
    async (value) => {
      const fake = createFakeFunnelSender();
      const outcome = await captureFunnelEvent(
        { event: 'checkout_started', familyId: FAMILY, attribution: { utm_source: 'google' } },
        { sender: fake.sender, env: { [FLAG]: value } },
      );
      expect(outcome).toBe('flag_off');
      expect(fake.sent).toEqual([]);
    },
  );

  it('names a sender that is not configured instead of reporting sent', async () => {
    const fake = createFakeFunnelSender('not_configured');
    const outcome = await captureFunnelEvent(
      { event: 'checkout_started', familyId: FAMILY, attribution: {} },
      { sender: fake.sender, env: ON },
    );
    expect(outcome).toBe('not_configured');
    expect(fake.sent).toHaveLength(1);
  });

  it('turns a throwing sender into provider_error, never a thrown checkout', async () => {
    const outcome = await captureFunnelEvent(
      { event: 'checkout_started', familyId: FAMILY, attribution: {} },
      {
        sender: {
          send: async () => {
            throw new Error('posthog down');
          },
        },
        env: ON,
      },
    );
    expect(outcome).toBe('provider_error');
  });
});

describe('signupFunnelExtras', () => {
  const now = new Date('2026-11-25T03:00:00Z');

  it('carries the card code and the signup date when the flag is on', () => {
    expect(signupFunnelExtras({ sourceCode: 'poster-oakville', now }, ON)).toEqual({
      properties: { source_code: 'poster-oakville' },
      options: { setOnce: { signup_date: '2026-11-25' } },
    });
  });

  it('leaves an untagged signup without a source code (absent, not "direct")', () => {
    expect(signupFunnelExtras({ sourceCode: null, now }, ON)).toEqual({
      properties: {},
      options: { setOnce: { signup_date: '2026-11-25' } },
    });
  });

  it('adds nothing while the flag is off', () => {
    expect(signupFunnelExtras({ sourceCode: 'poster-oakville', now }, {})).toEqual({
      properties: {},
      options: {},
    });
  });
});
