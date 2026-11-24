// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { denyMetaPixel, installMetaPixel } from './meta-pixel-client.js';
import { fireMetaPurchaseConversion } from './meta-purchase.js';

const OLD_ID = '1460101092968766';
const NEW_ID = '2041301346827688';

interface PixelWindow extends Window {
  fbq?: { queue?: unknown[][] };
  _fbq?: unknown;
  __haleMetaPixel?: boolean;
}

function queue(): unknown[][] {
  return ((window as PixelWindow).fbq?.queue ?? []) as unknown[][];
}

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
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
  for (const node of document.head.querySelectorAll('script')) node.remove();
  const w = window as PixelWindow;
  w.fbq = undefined;
  w._fbq = undefined;
  w.__haleMetaPixel = undefined;
});

describe('installMetaPixel', () => {
  it('inits one id and tracks PageView once', () => {
    installMetaPixel(OLD_ID);
    expect(queue()).toEqual([
      ['consent', 'grant'],
      ['init', OLD_ID],
      ['track', 'PageView'],
    ]);
    expect(document.querySelectorAll('script[src*="fbevents.js"]')).toHaveLength(1);
  });

  it('inits each id, then tracks PageView once so each pixel gets it once', () => {
    installMetaPixel(` ${OLD_ID}, nope, ${NEW_ID}, ${OLD_ID} `);
    expect(queue().filter(([method]) => method === 'init')).toEqual([
      ['init', OLD_ID],
      ['init', NEW_ID],
    ]);
    expect(queue().filter(([method, name]) => method === 'track' && name === 'PageView')).toEqual([
      ['track', 'PageView'],
    ]);
    expect(queue().some(([method]) => method === 'trackSingle')).toBe(false);
    expect(document.querySelectorAll('script[src*="fbevents.js"]')).toHaveLength(1);
  });

  it('does not init again on a second call', () => {
    installMetaPixel(OLD_ID);
    installMetaPixel(`${OLD_ID},${NEW_ID}`);
    expect(queue().filter(([method]) => method === 'init')).toEqual([['init', OLD_ID]]);
    expect(document.querySelectorAll('script[src*="fbevents.js"]')).toHaveLength(1);
  });

  it('revokes consent once, which covers every initialized pixel', () => {
    installMetaPixel(`${OLD_ID},${NEW_ID}`);
    denyMetaPixel();
    expect(queue().filter(([method, state]) => method === 'consent' && state === 'revoke')).toEqual(
      [['consent', 'revoke']],
    );
  });

  it('tracks Purchase once, with the Checkout Session id, after both pixels are inited', () => {
    installMetaPixel(`${OLD_ID},${NEW_ID}`);
    const fbq = (window as PixelWindow).fbq as ((...args: unknown[]) => void) | undefined;
    expect(
      fireMetaPurchaseConversion(
        {
          pixelId: `${OLD_ID},${NEW_ID}`,
          value: 79,
          currency: 'CAD',
          transactionId: 'cs_test_1',
        },
        fbq,
        memoryStorage(),
      ),
    ).toBe('fired');
    expect(queue().filter(([method]) => method === 'init')).toEqual([
      ['init', OLD_ID],
      ['init', NEW_ID],
    ]);
    expect(queue().filter(([method, name]) => method === 'track' && name === 'Purchase')).toEqual([
      ['track', 'Purchase', { value: 79, currency: 'CAD' }, { eventID: 'cs_test_1' }],
    ]);
    expect(queue().some(([method]) => method === 'trackSingle')).toBe(false);
  });
});
