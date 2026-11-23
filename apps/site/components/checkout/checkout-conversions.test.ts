// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GooglePurchaseConversion } from '~/components/google-purchase-conversion';
import { MetaPurchaseConversion } from '~/components/meta-purchase-conversion';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BASE = { value: 59, currency: 'CAD' };

afterEach(() => {
  sessionStorage.clear();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

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
    const gtag = vi.fn();
    vi.stubGlobal('gtag', gtag);
    Object.assign(window, { gtag });
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
});
