import { describe, expect, it } from 'vitest';
import { attributionCookie, readFirstTouchAttribution } from './attribution';
import { buildEvent } from './events';
import {
  createFunnelViewTracker,
  funnelAttributionForCookie,
  funnelViewForPath,
} from './funnel-views';

function memorySession() {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

describe('funnelViewForPath', () => {
  it.each(['/pricing', '/pricing/', '/fr/pricing', '/zh/pricing', '/en/pricing'])(
    '%s is a pricing view',
    (path) => {
      expect(funnelViewForPath(path)).toBe('pricing_viewed');
    },
  );

  it.each(['/', '/faq', '/pricing-old', '/fr', '/de/pricing', '/checkout/success'])(
    '%s is not',
    (path) => {
      expect(funnelViewForPath(path)).toBeNull();
    },
  );
});

describe('createFunnelViewTracker', () => {
  it('fires pricing_viewed once per arrival, never on a re-render or a query change', () => {
    const tracker = createFunnelViewTracker();
    const fired = [
      tracker.observe('/pricing', true),
      tracker.observe('/pricing', true),
      tracker.observe('/pricing', true),
    ].filter(Boolean);
    expect(fired).toEqual(['pricing_viewed']);
  });

  it('waits for the client instead of losing the view', () => {
    const tracker = createFunnelViewTracker();
    expect(tracker.observe('/pricing', false)).toBeNull();
    expect(tracker.observe('/pricing', false)).toBeNull();
    expect(tracker.observe('/pricing', true)).toBe('pricing_viewed');
    expect(tracker.observe('/pricing', true)).toBeNull();
  });

  it('counts a second visit after leaving the page as a second view', () => {
    const tracker = createFunnelViewTracker();
    const fired = [
      tracker.observe('/pricing', true),
      tracker.observe('/faq', true),
      tracker.observe('/fr/pricing', true),
    ].filter(Boolean);
    expect(fired).toEqual(['pricing_viewed', 'pricing_viewed']);
  });

  it('fires nothing while capture cannot send (analytics off or no consent)', () => {
    const tracker = createFunnelViewTracker();
    expect(['/pricing', '/faq', '/pricing'].map((path) => tracker.observe(path, false))).toEqual([
      null,
      null,
      null,
    ]);
  });
});

describe('pricing_viewed privacy gate', () => {
  it('keeps the attribution keys and drops identifying properties', () => {
    const built = buildEvent('pricing_viewed', {
      utm_source: 'google',
      utm_content: 'hero',
      gclid: 'Cj0Click',
      source_code: 'poster-oakville',
      email: 'parent@example.com',
      phone: 'a-phone-number',
      name: 'Sam',
      child: 'Ava',
    });
    expect(built).toEqual({
      event: 'pricing_viewed',
      properties: {
        utm_source: 'google',
        utm_content: 'hero',
        gclid: 'Cj0Click',
        source_code: 'poster-oakville',
      },
    });
  });
});

describe('the attribution cookie and the card code', () => {
  it('does not take a card code from a landing URL under the attribution name', () => {
    const session = memorySession();
    expect(
      readFirstTouchAttribution('?utm_source=google&source_code=forged-code', session),
    ).toEqual({ utm_source: 'google' });
  });

  it('adds the first-touch card code to the cookie only with web analytics on', () => {
    const attribution = { utm_source: 'poster' };
    let reads = 0;
    const readCode = () => {
      reads += 1;
      return 'poster-oakville';
    };
    const on = funnelAttributionForCookie(attribution, readCode, {
      NEXT_PUBLIC_POSTHOG_WEB_ENABLED: 'true',
    });
    expect(on).toEqual({ utm_source: 'poster', source_code: 'poster-oakville' });
    expect(attributionCookie(on, 'www.villagehale.com')).toContain(
      encodeURIComponent('source_code=poster-oakville'),
    );
    expect(reads).toBe(1);

    const off = funnelAttributionForCookie(attribution, readCode, {});
    expect(off).toEqual({ utm_source: 'poster' });
    expect(attributionCookie(off, 'www.villagehale.com')).not.toContain('source_code');
    expect(reads).toBe(1);
  });

  it('leaves an untagged visit without a card code', () => {
    expect(
      funnelAttributionForCookie({ utm_source: 'google' }, () => null, {
        NEXT_PUBLIC_POSTHOG_WEB_ENABLED: 'true',
      }),
    ).toEqual({ utm_source: 'google' });
  });
});
