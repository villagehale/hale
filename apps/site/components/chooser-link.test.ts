import { describe, expect, it, vi } from 'vitest';

/**
 * The primary door's client upgrade. Server markup is /text (pinned in
 * site-chrome and landing tests). This file is the hydration: a phone's user
 * agent retargets the anchor at the composer, a desktop leaves it on /text.
 *
 * useState is a one-slot store and useEffect runs inline, then the component
 * is called again so the second render reads what the effect stored. That is
 * the hydration this suite can see without a DOM.
 */

let slot: unknown;

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      if (slot === undefined) slot = initial;
      return [
        slot,
        (next: unknown) => {
          slot = typeof next === 'function' ? (next as (prev: unknown) => unknown)(slot) : next;
        },
      ];
    },
    useEffect: (effect: () => void) => {
      effect();
    },
  };
});

vi.mock('~/lib/analytics/posthog-provider', () => ({
  useAnalytics: () => vi.fn(),
}));

const { ChooserLink } = await import('./chooser-link.js');

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function renderAfterHydration(ua: string, search = ''): { href: string; cta: string } {
  slot = undefined;
  vi.stubGlobal('navigator', { userAgent: ua });
  vi.stubGlobal('window', {
    location: { search },
    sessionStorage: { getItem: () => null, setItem: () => {} },
  });
  const props = {
    locale: 'en' as const,
    placement: 'hero',
    smsNumber: '+16475551234',
    prefill: "Hey Hale, what's going on?",
    children: 'Text Hale',
  };
  ChooserLink(props);
  const element = ChooserLink(props);
  vi.unstubAllGlobals();
  return {
    href: element.props.href as string,
    cta: element.props['data-cta'] as string,
  };
}

describe('ChooserLink hydrates the primary door', () => {
  it('retargets an iPhone at the iOS composer', () => {
    const link = renderAfterHydration(IPHONE);
    expect(link.cta).toBe('cta_text_click');
    expect(link.href).toBe('sms:+16475551234&body=Hey%20Hale%2C%20what%27s%20going%20on%3F');
  });

  it('retargets Android at ?body=', () => {
    const link = renderAfterHydration(ANDROID);
    expect(link.cta).toBe('cta_text_click');
    expect(link.href).toBe('sms:+16475551234?body=Hey%20Hale%2C%20what%27s%20going%20on%3F');
  });

  it('leaves a desktop on /text', () => {
    const link = renderAfterHydration(WINDOWS, '?s=earlyon-richmondhill');
    expect(link.cta).toBe('cta_message_click');
    expect(link.href).toBe('/text?s=earlyon-richmondhill');
  });
});
