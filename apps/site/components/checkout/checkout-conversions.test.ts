// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GooglePurchaseConversion } from '~/components/google-purchase-conversion';
import { MetaPurchaseConversion } from '~/components/meta-purchase-conversion';
import { resetConsentDocumentState, writeConsent } from '~/lib/site/consent';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BASE = { value: 59, currency: 'CAD' };

beforeEach(() => {
  const happy = (
    window as Window & {
      happyDOM?: { settings: { handleDisabledFileLoadingAsSuccess: boolean } };
    }
  ).happyDOM;
  if (happy) happy.settings.handleDisabledFileLoadingAsSuccess = true;
});

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  for (const node of document.head.querySelectorAll('script')) node.remove();
  document.body.replaceChildren();
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
  document.documentElement.removeAttribute('data-consent');
  document.documentElement.removeAttribute('data-consent-mode');
  document.documentElement.removeAttribute('data-gpc');
  resetConsentDocumentState();
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
});

/** The gtag tag already on the page, as the consent banner leaves it after Accept. */
function installedGtag() {
  const gtag = vi.fn();
  vi.stubGlobal('gtag', gtag);
  Object.assign(window, { gtag, __haleAds: true });
  return gtag;
}

function googleConversions(): unknown[][] {
  const layer = (window as Window & { dataLayer?: ArrayLike<unknown>[] }).dataLayer ?? [];
  return layer
    .map((entry) => Array.from(entry))
    .filter(([kind, name]) => kind === 'event' && name === 'conversion');
}

async function mountAcrossPolling(render: (transactionId: string) => React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(render('cs_test_once')));
  // A router.refresh() re-renders with equal props; a remount is the worst case.
  await act(async () => root.render(render('cs_test_once')));
  await act(async () => root.unmount());
  const again = createRoot(container);
  await act(async () => again.render(render('cs_test_once')));
  await act(async () => again.render(render('cs_test_other')));
  await act(async () => again.unmount());
}

describe('purchase conversions across the pending state', () => {
  it('fires Google once per session, and again only for a different session', async () => {
    localStorage.setItem('hale-site-consent', 'granted');
    const gtag = installedGtag();
    await mountAcrossPolling((transactionId) =>
      createElement(GooglePurchaseConversion, { ...BASE, sendTo: 'AW-1/test', transactionId }),
    );
    const sent = gtag.mock.calls.filter(
      ([kind, name]) => kind === 'event' && name === 'conversion',
    );
    expect(sent.map(([, , params]) => params.transaction_id)).toEqual([
      'cs_test_once',
      'cs_test_other',
    ]);
  });

  it('fires Meta once per session, and again only for a different session', async () => {
    const fbq = vi.fn();
    vi.stubGlobal('fbq', fbq);
    Object.assign(window, { fbq });
    await mountAcrossPolling((transactionId) =>
      createElement(MetaPurchaseConversion, { ...BASE, pixelId: '1000', transactionId }),
    );
    const sent = fbq.mock.calls.filter(([kind, name]) => kind === 'track' && name === 'Purchase');
    expect(sent.map(([, , , options]) => options.eventID)).toEqual([
      'cs_test_once',
      'cs_test_other',
    ]);
  });

  it('inits every pixel id and tracks Purchase once when consent was granted', async () => {
    localStorage.setItem('hale-site-consent', 'granted');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(MetaPurchaseConversion, {
          ...BASE,
          pixelId: '1111111111111111, 2222222222222222',
          transactionId: 'cs_test_two',
        }),
      );
    });
    const fbq = (window as Window & { fbq?: { queue?: unknown[][] } }).fbq;
    const queued = fbq?.queue ?? [];
    expect(queued.filter(([method]) => method === 'init')).toEqual([
      ['init', '1111111111111111'],
      ['init', '2222222222222222'],
    ]);
    expect(
      queued.filter(([method, name]) => method === 'track' && name === 'PageView'),
    ).toHaveLength(1);
    expect(queued.filter(([method, name]) => method === 'track' && name === 'Purchase')).toEqual([
      ['track', 'Purchase', { value: 59, currency: 'CAD' }, { eventID: 'cs_test_two' }],
    ]);
    expect(queued.some(([method]) => method === 'trackSingle')).toBe(false);
    await act(async () => root.unmount());
  });

  it('does not init a pixel when consent is denied', async () => {
    localStorage.setItem('hale-site-consent', 'denied');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(MetaPurchaseConversion, {
          ...BASE,
          pixelId: '1111111111111111,2222222222222222',
          transactionId: 'cs_test_denied',
        }),
      );
    });
    expect((window as Window & { fbq?: unknown }).fbq).toBeUndefined();
    expect(sessionStorage.getItem('hale.meta_purchase.cs_test_denied')).toBeNull();
    await act(async () => root.unmount());
  });

  it('fires Purchase for every pixel when Accept happens after the receipt mounts', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(MetaPurchaseConversion, {
          ...BASE,
          pixelId: '1111111111111111,2222222222222222',
          transactionId: 'cs_test_late',
        }),
      );
    });
    expect(sessionStorage.getItem('hale.meta_purchase.cs_test_late')).toBeNull();
    await act(async () => {
      writeConsent('granted');
    });
    const fbq = (window as Window & { fbq?: { queue?: unknown[][] } }).fbq;
    const queued = fbq?.queue ?? [];
    expect(queued.filter(([method]) => method === 'init')).toEqual([
      ['init', '1111111111111111'],
      ['init', '2222222222222222'],
    ]);
    expect(queued.filter(([method, name]) => method === 'track' && name === 'Purchase')).toEqual([
      ['track', 'Purchase', { value: 59, currency: 'CAD' }, { eventID: 'cs_test_late' }],
    ]);
    await act(async () => {
      writeConsent('granted');
    });
    expect(
      queued.filter(([method, name]) => method === 'track' && name === 'Purchase'),
    ).toHaveLength(1);
    await act(async () => root.unmount());
  });

  it('fires Google once when Accept happens after the receipt mounts', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(GooglePurchaseConversion, {
          ...BASE,
          sendTo: 'AW-1/test',
          transactionId: 'cs_test_google_late',
        }),
      );
    });
    expect(googleConversions()).toEqual([]);
    await act(async () => {
      writeConsent('granted');
    });
    expect(googleConversions()).toEqual([
      [
        'event',
        'conversion',
        { send_to: 'AW-1/test', value: 59, currency: 'CAD', transaction_id: 'cs_test_google_late' },
      ],
    ]);
    await act(async () => {
      writeConsent('granted');
    });
    expect(googleConversions()).toHaveLength(1);
    await act(async () => root.unmount());
  });

  it('fires Purchase in a default-on region with no stored choice', async () => {
    document.documentElement.dataset.consentMode = 'opt-out';
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(MetaPurchaseConversion, {
          ...BASE,
          pixelId: '1111111111111111',
          transactionId: 'cs_test_default_on',
        }),
      );
    });
    const fbq = (window as Window & { fbq?: { queue?: unknown[][] } }).fbq;
    const queued = fbq?.queue ?? [];
    expect(queued.filter(([method, name]) => method === 'track' && name === 'Purchase')).toEqual([
      ['track', 'Purchase', { value: 59, currency: 'CAD' }, { eventID: 'cs_test_default_on' }],
    ]);
    expect(localStorage.getItem('hale-site-consent')).toBeNull();
    await act(async () => root.unmount());
  });

  it('does not fire Purchase when Global Privacy Control is set', async () => {
    document.documentElement.dataset.consentMode = 'opt-out';
    document.documentElement.dataset.gpc = '1';
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(MetaPurchaseConversion, {
          ...BASE,
          pixelId: '1111111111111111',
          transactionId: 'cs_test_gpc',
        }),
      );
    });
    expect((window as Window & { fbq?: unknown }).fbq).toBeUndefined();
    expect(sessionStorage.getItem('hale.meta_purchase.cs_test_gpc')).toBeNull();
    await act(async () => root.unmount());
  });

  it('does not fire Purchase after an opt-out, even in a default-on region', async () => {
    localStorage.setItem('hale-site-consent', 'denied');
    document.documentElement.dataset.consentMode = 'opt-out';
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(MetaPurchaseConversion, {
          ...BASE,
          pixelId: '1111111111111111',
          transactionId: 'cs_test_opt_out',
        }),
      );
    });
    expect((window as Window & { fbq?: unknown }).fbq).toBeUndefined();
    await act(async () => root.unmount());
  });

  it('does not fire Purchase on a receipt whose address carries the session id', async () => {
    document.documentElement.dataset.consentMode = 'opt-out';
    window.history.replaceState(null, '', '/checkout/success?session_id=cs_test_secret');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(MetaPurchaseConversion, {
          ...BASE,
          pixelId: '1111111111111111',
          transactionId: 'cs_test_secret',
        }),
      );
    });
    expect((window as Window & { fbq?: unknown }).fbq).toBeUndefined();
    expect(sessionStorage.getItem('hale.meta_purchase.cs_test_secret')).toBeNull();
    await act(async () => root.unmount());
  });

  it('fires Google in a default-on region with no stored choice', async () => {
    document.documentElement.dataset.consentMode = 'opt-out';
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(GooglePurchaseConversion, {
          ...BASE,
          sendTo: 'AW-1/test',
          transactionId: 'cs_test_google_default',
        }),
      );
    });
    expect(googleConversions()).toEqual([
      [
        'event',
        'conversion',
        {
          send_to: 'AW-1/test',
          value: 59,
          currency: 'CAD',
          transaction_id: 'cs_test_google_default',
        },
      ],
    ]);
    await act(async () => root.unmount());
  });

  it('does not fire Google without consent, even when a tag is already on the page', async () => {
    localStorage.setItem('hale-site-consent', 'denied');
    const gtag = installedGtag();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(GooglePurchaseConversion, {
          ...BASE,
          sendTo: 'AW-1/test',
          transactionId: 'cs_test_google_denied',
        }),
      );
    });
    expect(gtag.mock.calls.filter(([kind]) => kind === 'event')).toEqual([]);
    expect(sessionStorage.getItem('hale.google_ads_purchase.cs_test_google_denied')).toBeNull();
    await act(async () => root.unmount());
  });
});
