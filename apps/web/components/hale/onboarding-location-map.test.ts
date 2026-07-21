import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The component pulls in the Maps loader (window-guarded); it never runs on a static
// first paint (no effects), but stub it so the import graph stays free of a real
// script inject — nothing here is the map itself.
vi.mock('~/lib/onboarding/load-places', () => ({ loadMapsLibrary: vi.fn() }));

import { OnboardingLocationMap } from '~/components/hale/onboarding-location-map';

const render = (props: {
  apiKey: string | null;
  center: { lat: number; lng: number } | null;
}): string => renderToStaticMarkup(createElement(OnboardingLocationMap, props));

/**
 * The map's honest degradation (brief issue 3): with no Maps key — previews, forks,
 * any env where NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is unset — the step-4 slot must show
 * the original village illustration, never a broken grey box or an empty map region.
 * With a key, the labelled map region mounts for the Maps JS to attach to, and the
 * illustration still covers it on first paint (before the load effect runs).
 */
describe('OnboardingLocationMap — honest fallback', () => {
  it('renders the illustration and NO map region when no Maps key is present', () => {
    const html = render({ apiKey: null, center: null });
    expect(html).toContain('village-illustration');
    expect(html).not.toContain('aria-label="Map of your selected area"');
  });

  it('mounts the labelled map region (and illustration until ready) when a key is present', () => {
    const html = render({ apiKey: 'test-key', center: null });
    expect(html).toContain('aria-label="Map of your selected area"');
    expect(html).toContain('village-illustration');
  });
});
