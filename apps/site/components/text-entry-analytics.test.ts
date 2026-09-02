import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildEvent } from '~/lib/analytics/events.js';

/**
 * The /text view has to reach PostHog attributed, or the scoreboard cannot tell which
 * physical spot starts conversations (VIL-240). Attribution itself is the provider's
 * job (first-touch `source_code`); what the chooser view adds is its own two coarse
 * facts — the platform ordering hint and which channels were live — and both must
 * SURVIVE the privacy gate, which is exactly the kind of silent drop buildEvent's
 * forbidden-fragment list can cause (`platform` contains 'lat'; hence `device_hint`).
 *
 * The site's test suite has no DOM (every test renders to static markup), so
 * `useEffect` is substituted with a synchronous call for this file only — that
 * is the sole reason the effect body would not otherwise run. The seam under
 * test is real: the mocked `useAnalytics` is the same module the component
 * imports, and the assertions are on what the component actually passes it.
 */

const capture = vi.fn();

vi.mock('~/lib/analytics/posthog-provider', () => ({ useAnalytics: () => capture }));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useEffect: (effect: () => void) => effect() };
});

const { TextEntryAnalytics } = await import('./text-entry-analytics.js');

beforeEach(() => {
  capture.mockClear();
});

describe('TextEntryAnalytics', () => {
  it('captures the view with the chooser’s two coarse facts, and nothing identifying', () => {
    renderToStaticMarkup(
      createElement(TextEntryAnalytics, { deviceHint: 'android', channelsLive: 'sms+whatsapp' }),
    );
    expect(capture).toHaveBeenCalledWith('text_entry_viewed', {
      device_hint: 'android',
      channels_live: 'sms+whatsapp',
    });
  });

  it('renders nothing — it is an event, not UI', () => {
    expect(
      renderToStaticMarkup(
        createElement(TextEntryAnalytics, { deviceHint: 'unknown', channelsLive: 'none' }),
      ),
    ).toBe('');
  });
});

describe('text_entry_viewed (privacy gate)', () => {
  it('keeps the venue code, which is a place and not a person', () => {
    expect(buildEvent('text_entry_viewed', { source_code: 'swim-loyalfitness' })).toEqual({
      event: 'text_entry_viewed',
      properties: { source_code: 'swim-loyalfitness' },
    });
  });

  it('passes both chooser facts through the forbidden-fragment gate', () => {
    // The load-bearing pin behind the property NAME: `platform_hint` contains the
    // fragment 'lat' and would be silently dropped — device_hint is the honest
    // key that survives. If someone "fixes" the name back, this fails.
    expect(
      buildEvent('text_entry_viewed', {
        device_hint: 'desktop-mac',
        channels_live: 'sms',
        platform_hint: 'desktop-mac',
      }).properties,
    ).toEqual({ device_hint: 'desktop-mac', channels_live: 'sms' });
  });

  it('still drops anything identifying that ever reached it', () => {
    expect(
      buildEvent('text_entry_viewed', { source_code: 'swim-loyalfitness', email: 'a@b.com' })
        .properties,
    ).toEqual({ source_code: 'swim-loyalfitness' });
  });
});
