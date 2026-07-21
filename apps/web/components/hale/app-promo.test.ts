import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppPromo, AppPromoBanner, AppPromoSheet } from './app-promo';
import { appPromoPhase } from './app-promo-core';

/**
 * The §5 app hand-off. The repo renders to static markup (no jsdom), so the
 * matchMedia/sessionStorage behaviour is proven as the pure `appPromoPhase`
 * decision, and the sheet/banner markup + the flag gate are asserted by rendering
 * the components directly. Expected phases are derived from the spec (first visit →
 * sheet; "Continue in browser" → banner; banner ✕ → hidden; no flag / desktop →
 * hidden), never read back from the component's output.
 */
const URL = 'https://apps.apple.com/app/hale';

describe('appPromoPhase — the hand-off decision', () => {
  it('hides everything with no App-Store URL (the honesty gate), even on a phone first visit', () => {
    expect(appPromoPhase(undefined, true, null)).toBe('hidden');
  });

  it('hides everything at ≥768px (desktop), even with the flag set', () => {
    expect(appPromoPhase(URL, false, null)).toBe('hidden');
  });

  it('shows the sheet on a phone first visit', () => {
    expect(appPromoPhase(URL, true, null)).toBe('sheet');
  });

  it('shows the banner after "Continue in browser" (choice = web)', () => {
    expect(appPromoPhase(URL, true, 'web')).toBe('banner');
  });

  it('hides everything after the banner is dismissed (choice = dismissed)', () => {
    expect(appPromoPhase(URL, true, 'dismissed')).toBe('hidden');
  });
});

describe('AppPromo — the flag gate', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders nothing when NEXT_PUBLIC_APP_PROMO_URL is unset', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_PROMO_URL', '');
    expect(renderToStaticMarkup(createElement(AppPromo))).toBe('');
  });
});

describe('AppPromoSheet markup', () => {
  it('renders the headline, the Open-app link to the flag URL, and Continue in browser', () => {
    const html = renderToStaticMarkup(
      createElement(AppPromoSheet, { url: URL, onContinue: () => {} }),
    );
    expect(html).toContain('Hale is better in the app');
    expect(html).toContain(`href="${URL}"`);
    expect(html).toContain('Open app');
    expect(html).toContain('Continue in browser');
    expect(html).toContain('aria-modal="true"');
  });
});

describe('AppPromoBanner markup', () => {
  it('renders the Open pill to the flag URL and a labelled dismiss control', () => {
    const html = renderToStaticMarkup(
      createElement(AppPromoBanner, { url: URL, onDismiss: () => {} }),
    );
    expect(html).toContain('Hale works best in the app');
    expect(html).toContain(`href="${URL}"`);
    expect(html).toContain('aria-label="Dismiss"');
  });
});
