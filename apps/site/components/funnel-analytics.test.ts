import { describe, expect, it, vi } from 'vitest';
import { buildEvent } from '~/lib/analytics/events.js';

/**
 * THE ACQUISITION FUNNEL'S CLICK EVENTS — the three things a visitor can do on the
 * marketing site that mean "I am going to text Hale", and what each one is allowed to
 * say about them.
 *
 * The site suite has no DOM, so the components are called directly and their `onClick`
 * is invoked: the seam under test is real (the mocked `useAnalytics` is the same module
 * the components import) and the assertions are on exactly what they pass it.
 */

const capture = vi.fn();

vi.mock('~/lib/analytics/posthog-provider', () => ({
  useAnalytics: () => capture,
  useAnalyticsReady: () => true,
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (initial: unknown) => [initial, () => {}],
    useRef: (initial: unknown) => ({ current: initial }),
    useEffect: (effect: () => unknown) => {
      effect();
    },
  };
});

const { LandingCta } = await import('./landing-cta.js');
const { CopyNumberButton } = await import('./copy-number.js');
const { LandingScrollAnalytics } = await import('./landing-scroll-analytics.js');

function click(element: { props: Record<string, unknown> }): void {
  (element.props.onClick as () => void)();
}

describe('cta_text_click — every sms: CTA is one event with a placement', () => {
  it('names which CTA opened the composer', () => {
    capture.mockClear();
    click(
      LandingCta({
        event: 'cta_text_click',
        placement: 'hero',
        href: 'sms:+16475551234?&body=Hi',
        children: 'Text Hale',
      }),
    );
    expect(capture).toHaveBeenCalledWith('cta_text_click', { cta_placement: 'hero' });
  });

  it('distinguishes a pre-written reply chip from the hero button beside it', () => {
    capture.mockClear();
    click(
      LandingCta({
        event: 'cta_text_click',
        placement: 'hero_chip',
        href: 'sms:+16475551234?&body=When%20should%20Mia%20start%20solids%3F',
        children: 'When should Mia start solids?',
      }),
    );
    expect(capture).toHaveBeenCalledWith('cta_text_click', { cta_placement: 'hero_chip' });
  });

  it('sends no placement where the event only ever has one home', () => {
    capture.mockClear();
    click(LandingCta({ event: 'save_contact_click', href: '/hale.vcf', children: 'Save contact' }));
    expect(capture).toHaveBeenCalledWith('save_contact_click', {});
  });

  it('never carries the href — the number lives in it, and the funnel does not need it', () => {
    capture.mockClear();
    const href = 'sms:+16475551234?&body=Hi%20(via%20earlyon-richmondhill)';
    click(LandingCta({ event: 'cta_text_click', placement: 'header', href, children: 'Text' }));
    expect(JSON.stringify(capture.mock.calls)).not.toContain('6475551234');
  });

  it('names the pipe when the call site stamps one — the funnel splits by channel, not by event', () => {
    capture.mockClear();
    const element = LandingCta({
      event: 'cta_text_click',
      placement: 'text_entry',
      channel: 'sms',
      href: 'sms:+16475551234?&body=Hi',
      children: 'Continue in Messages',
    });
    // The wiring is visible in the markup, same law as data-cta itself.
    expect(element.props['data-cta-channel']).toBe('sms');
    click(element);
    expect(capture).toHaveBeenCalledWith('cta_text_click', {
      cta_placement: 'text_entry',
      channel: 'sms',
    });
  });

  it('stamps whatsapp on the other pipe', () => {
    capture.mockClear();
    click(
      LandingCta({
        event: 'cta_whatsapp_click',
        placement: 'text_entry',
        channel: 'whatsapp',
        href: 'https://wa.me/16475551234?text=Hi',
        children: 'Continue on WhatsApp',
      }),
    );
    expect(capture).toHaveBeenCalledWith('cta_whatsapp_click', {
      cta_placement: 'text_entry',
      channel: 'whatsapp',
    });
  });
});

describe('cta_message_click — a chooser navigation is not a composer open', () => {
  it('fires its own event with the placement, so cta_text_click stays "a composer opened"', async () => {
    capture.mockClear();
    // The hydration effect reads the first-touch code; give it a bare window.
    vi.stubGlobal('window', {
      location: { search: '' },
      sessionStorage: { getItem: () => null, setItem: () => {} },
    });
    const { ChooserLink } = await import('./chooser-link.js');
    const element = ChooserLink({ locale: 'en', placement: 'hero', children: 'Message Hale' });
    expect(element.props.href).toBe('/text');
    expect(element.props['data-cta']).toBe('cta_message_click');
    expect(element.props['data-cta-placement']).toBe('hero');
    click(element);
    expect(capture).toHaveBeenCalledWith('cta_message_click', { cta_placement: 'hero' });
    vi.unstubAllGlobals();
  });
});

describe('copy_number_click — the desktop path to the same act', () => {
  it('captures the intent, and never the digits it puts on the clipboard', () => {
    capture.mockClear();
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => {} } });

    click(
      CopyNumberButton({
        number: '+16475551234',
        label: 'Copy number',
        copiedLabel: 'copied',
        ariaLabel: 'Copy',
      }),
    );

    expect(capture).toHaveBeenCalledWith('copy_number_click', {});
    expect(JSON.stringify(capture.mock.calls)).not.toContain('6475551234');
    vi.unstubAllGlobals();
  });

  it('names which chip was copied from, the same way LandingCta names its door', () => {
    capture.mockClear();
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => {} } });

    click(
      CopyNumberButton({
        number: '+16475551234',
        placement: 'closing',
        label: 'Copy number',
        copiedLabel: 'copied',
        ariaLabel: 'Copy',
      }),
    );

    expect(capture).toHaveBeenCalledWith('copy_number_click', { cta_placement: 'closing' });
    vi.unstubAllGlobals();
  });
});

describe('landing_scroll — the money pages name which page was scrolled', () => {
  /** A viewport as tall as the document: fully read on render, so the mocked
   * effect reports every depth in one pass. */
  function stubFullyReadPage(): void {
    vi.stubGlobal('window', {
      scrollY: 0,
      innerHeight: 900,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    vi.stubGlobal('document', { documentElement: { scrollHeight: 900 } });
  }

  it('threads the coarse page name onto every depth it reports', () => {
    capture.mockClear();
    stubFullyReadPage();
    LandingScrollAnalytics({ page: 'toronto_swim' });
    expect(capture).toHaveBeenCalledTimes(4);
    expect(capture).toHaveBeenCalledWith('landing_scroll', { depth: 25, page: 'toronto_swim' });
    expect(capture).toHaveBeenCalledWith('landing_scroll', { depth: 100, page: 'toronto_swim' });
    vi.unstubAllGlobals();
  });

  it('sends no page from the homepage, whose historical rows have none', () => {
    capture.mockClear();
    stubFullyReadPage();
    LandingScrollAnalytics({});
    expect(capture).toHaveBeenCalledWith('landing_scroll', { depth: 100 });
    vi.unstubAllGlobals();
  });
});

describe('the privacy gate holds for the new funnel properties', () => {
  it('keeps the coarse funnel triple and drops anything identifying beside it', () => {
    expect(
      buildEvent('cta_text_click', {
        cta_placement: 'hero',
        source_code: 'earlyon-richmondhill',
        locale: 'fr',
        email: 'sam@example.com',
        phone: '+16475551234',
      }).properties,
    ).toEqual({ cta_placement: 'hero', source_code: 'earlyon-richmondhill', locale: 'fr' });
  });

  it('keeps a scroll depth, which is a number about a page and not about a person', () => {
    expect(buildEvent('landing_scroll', { depth: 75 })).toEqual({
      event: 'landing_scroll',
      properties: { depth: 75 },
    });
  });

  it('keeps the coarse page name a city guide stamps on its scrolls', () => {
    expect(buildEvent('landing_scroll', { depth: 50, page: 'toronto_swim' })).toEqual({
      event: 'landing_scroll',
      properties: { depth: 50, page: 'toronto_swim' },
    });
  });
});
