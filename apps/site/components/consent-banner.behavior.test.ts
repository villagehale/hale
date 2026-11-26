// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONSENT_STORAGE_KEY } from '~/lib/site/consent';
import type { ConsentMode } from '~/lib/site/consent-region';
import { ConsentBanner } from './consent-banner';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PIXEL = '1111111111111111';

function banner(mode: ConsentMode, gpc = false) {
  return createElement(ConsentBanner, {
    privacyHref: '/privacy',
    text: 'Nothing loads unless you say yes.',
    notice: 'This is on, and you can turn it off.',
    privacyLabel: 'Privacy policy',
    rejectLabel: 'No thanks',
    turnOffLabel: 'Turn off',
    acceptLabel: 'Accept',
    regionLabel: 'Cookies',
    mode,
    gpc,
    pixelId: PIXEL,
  });
}

function fbqQueue(): unknown[][] {
  const fbq = (window as Window & { fbq?: { queue?: unknown[][] } }).fbq;
  return fbq?.queue ?? [];
}

beforeEach(() => {
  const happy = (
    window as Window & {
      happyDOM?: { settings: { handleDisabledFileLoadingAsSuccess: boolean } };
    }
  ).happyDOM;
  if (happy) happy.settings.handleDisabledFileLoadingAsSuccess = true;
});

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-consent');
  document.documentElement.removeAttribute('data-consent-mode');
  document.documentElement.removeAttribute('data-gpc');
  document.body.replaceChildren();
  for (const node of document.head.querySelectorAll('script')) node.remove();
  const w = window as Window & {
    fbq?: unknown;
    _fbq?: unknown;
    __haleMetaPixel?: boolean;
    gtag?: unknown;
    dataLayer?: unknown;
    __haleAds?: boolean;
  };
  w.fbq = undefined;
  w._fbq = undefined;
  w.__haleMetaPixel = undefined;
  w.gtag = undefined;
  w.dataLayer = undefined;
  w.__haleAds = undefined;
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'globalPrivacyControl');
});

async function render(node: ReturnType<typeof banner>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return root;
}

describe('consent banner region behavior', () => {
  it('loads the pixel and Google Ads by default in an opt-out region, without storing Accept', async () => {
    await render(banner('opt-out'));
    expect(localStorage.getItem(CONSENT_STORAGE_KEY)).toBeNull();
    expect(fbqQueue().filter(([method]) => method === 'init')).toEqual([['init', PIXEL]]);
    expect(fbqQueue().some(([method, name]) => method === 'track' && name === 'PageView')).toBe(
      true,
    );
    expect(document.body.textContent).toContain('This is on, and you can turn it off.');
    expect(document.body.textContent).toContain('Turn off');
    const gtag = (window as Window & { gtag?: unknown }).gtag;
    expect(typeof gtag).toBe('function');
  });

  it('loads nothing in Quebec-style opt-in until Accept', async () => {
    const root = await render(banner('opt-in'));
    expect(fbqQueue()).toEqual([]);
    expect((window as Window & { gtag?: unknown }).gtag).toBeUndefined();
    expect(document.body.textContent).toContain('Nothing loads unless you say yes.');
    const accept = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent === 'Accept',
    );
    expect(accept).toBeTruthy();
    await act(async () => {
      accept?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(localStorage.getItem(CONSENT_STORAGE_KEY)).toBe('granted');
    expect(fbqQueue().some(([method]) => method === 'init')).toBe(true);
    await act(async () => root.unmount());
  });

  it('does not load when Global Privacy Control is on the request or the browser', async () => {
    await render(banner('opt-out', true));
    expect(fbqQueue()).toEqual([]);
    expect(document.body.textContent).toContain('Nothing loads unless you say yes.');

    document.body.replaceChildren();
    const w = window as Window & { __haleMetaPixel?: boolean; __haleAds?: boolean };
    w.__haleMetaPixel = undefined;
    w.__haleAds = undefined;
    Object.defineProperty(navigator, 'globalPrivacyControl', { value: true, configurable: true });
    await render(banner('opt-out', false));
    expect(fbqQueue()).toEqual([]);
    expect(document.documentElement.dataset.gpc).toBe('1');
    expect(document.body.textContent).toContain('Nothing loads unless you say yes.');
  });

  it('stores Turn off and does not load that choice on the next visit', async () => {
    vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    const root = await render(banner('opt-out'));
    expect(fbqQueue().some(([method]) => method === 'init')).toBe(true);
    const turnOff = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent === 'Turn off',
    );
    await act(async () => {
      turnOff?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(localStorage.getItem(CONSENT_STORAGE_KEY)).toBe('denied');
    await act(async () => root.unmount());

    const w = window as Window & {
      fbq?: unknown;
      _fbq?: unknown;
      __haleMetaPixel?: boolean;
      __haleAds?: boolean;
      gtag?: unknown;
      dataLayer?: unknown;
    };
    w.fbq = undefined;
    w._fbq = undefined;
    w.__haleMetaPixel = undefined;
    w.__haleAds = undefined;
    w.gtag = undefined;
    w.dataLayer = undefined;
    await render(banner('opt-out'));
    expect(fbqQueue()).toEqual([]);
    expect(w.gtag).toBeUndefined();
    expect(document.body.textContent).toContain('Nothing loads unless you say yes.');
  });
});
