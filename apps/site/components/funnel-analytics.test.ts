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
  return { ...actual, useState: (initial: unknown) => [initial, () => {}] };
});

const { LandingCta } = await import('./landing-cta.js');
const { CopyNumberButton } = await import('./copy-number.js');

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

    expect(capture).toHaveBeenCalledWith('copy_number_click');
    expect(JSON.stringify(capture.mock.calls)).not.toContain('6475551234');
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
});
