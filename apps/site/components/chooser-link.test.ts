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
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function renderPair(
  ua: string,
  search = '',
  source: string | null = null,
): { serverHref: string; href: string; cta: string } {
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
    source,
    children: 'Text Hale',
  };
  const server = ChooserLink(props);
  const element = ChooserLink(props);
  vi.unstubAllGlobals();
  return {
    serverHref: server.props.href as string,
    href: element.props.href as string,
    cta: element.props['data-cta'] as string,
  };
}

describe('ChooserLink hydrates the primary door', () => {
  it('paints /text first, then retargets an iPhone at the iOS composer', () => {
    const link = renderPair(IPHONE);
    expect(link.serverHref).toBe('/text');
    expect(link.cta).toBe('cta_text_click');
    expect(link.href).toBe('sms:+16475551234&body=Hey%20Hale%2C%20what%27s%20going%20on%3F');
  });

  it('treats an iPad as Apple Messages, &body= and the referral suffix', () => {
    const link = renderPair(IPAD, '?s=ab12');
    expect(link.serverHref).toBe('/text');
    expect(link.cta).toBe('cta_text_click');
    expect(link.href).toBe(
      'sms:+16475551234&body=Hey%20Hale%2C%20what%27s%20going%20on%3F%20(via%20ab12)',
    );
  });

  it('retargets Android at ?body=', () => {
    const link = renderPair(ANDROID);
    expect(link.serverHref).toBe('/text');
    expect(link.cta).toBe('cta_text_click');
    expect(link.href).toBe('sms:+16475551234?body=Hey%20Hale%2C%20what%27s%20going%20on%3F');
  });

  it('retargets a Mac at the same &body= form, keeping (via <code>)', () => {
    const link = renderPair(MAC, '', 'friend-0123456789ab');
    expect(link.serverHref).toBe('/text?s=friend-0123456789ab');
    expect(link.cta).toBe('cta_text_click');
    expect(link.href).toBe(
      'sms:+16475551234&body=Hey%20Hale%2C%20what%27s%20going%20on%3F%20(via%20friend-0123456789ab)',
    );
  });

  it('leaves a non-Apple desktop on /text, carrying ?s=', () => {
    const link = renderPair(WINDOWS, '?s=earlyon-richmondhill');
    expect(link.serverHref).toBe('/text');
    expect(link.cta).toBe('cta_message_click');
    expect(link.href).toBe('/text?s=earlyon-richmondhill');
  });

  it('keeps a rejected ?s= off both the server link and the composer', () => {
    const link = renderPair(IPHONE, '?s=JOIN-ABC');
    expect(link.serverHref).toBe('/text');
    expect(link.href).toBe('sms:+16475551234&body=Hey%20Hale%2C%20what%27s%20going%20on%3F');
    expect(link.href).not.toContain('via');
  });
});
