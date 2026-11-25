// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The app's Meta pixel loads only on the public /founding join page that ads land on.
 * A page whose URL carries a bearer token, or that shows a family's data, must load
 * nothing from Meta (hard rule #1). Each case mounts the real component at a URL and
 * reads what reached the page: the fbq queue and the fbevents.js script tag.
 */

const { pathBox } = vi.hoisted(() => ({ pathBox: { value: '/' } }));
vi.mock('next/navigation', () => ({ usePathname: () => pathBox.value }));

const OLD_ID = '1111111111111111';
const NEW_ID = '2222222222222222';
const PIXEL_SRC = 'https://connect.facebook.net/en_US/fbevents.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface PixelWindow extends Window {
  fbq?: { queue?: unknown[][]; disablePushState?: boolean };
  _fbq?: unknown;
  __haleMetaPixel?: boolean;
  happyDOM?: {
    setURL: (url: string) => void;
    settings: { handleDisabledFileLoadingAsSuccess: boolean };
  };
}

let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  const happy = (window as PixelWindow).happyDOM;
  if (happy) happy.settings.handleDisabledFileLoadingAsSuccess = true;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  for (const node of document.head.querySelectorAll('script')) node.remove();
  const w = window as PixelWindow;
  w.fbq = undefined;
  w._fbq = undefined;
  w.__haleMetaPixel = undefined;
});

async function mountAt(url: string): Promise<{ queue: unknown[][]; scripts: string[] }> {
  const parsed = new URL(url, 'https://app.example.test');
  (window as PixelWindow).happyDOM?.setURL(parsed.href);
  pathBox.value = parsed.pathname;
  const { MetaPixel } = await import('./meta-pixel');
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(createElement(MetaPixel, { pixelId: `${OLD_ID},${NEW_ID}` })));
  return {
    queue: ((window as PixelWindow).fbq?.queue ?? []) as unknown[][],
    scripts: [...document.head.querySelectorAll('script')].map((s) => s.src),
  };
}

describe('MetaPixel on the /founding join page', () => {
  it.each(['/founding', '/founding?utm_source=meta&fbclid=abc', '/founding?checkout=cancelled'])(
    'inits both ids, tracks one PageView and loads fbevents.js on %s',
    async (url) => {
      const { queue, scripts } = await mountAt(url);
      expect(queue).toEqual([
        ['init', OLD_ID],
        ['init', NEW_ID],
        ['track', 'PageView'],
      ]);
      expect(scripts).toEqual([PIXEL_SRC]);
    },
  );

  // fbevents.js otherwise sends a PageView with the new URL on every history change, so
  // a later client-side visit to a token or family page would reach Meta from here.
  it('turns off the pixel’s own history-change PageViews before fbevents.js loads', async () => {
    await mountAt('/founding');
    expect((window as PixelWindow).fbq?.disablePushState).toBe(true);
  });
});

describe('MetaPixel everywhere else in the app', () => {
  it.each([
    ['the provider-login vault (bearer code)', '/l/AbCdEf1234'],
    ['the texted connect link (bearer token)', '/connect?t=tok123'],
    ['the texted sign-in link', '/sign-in?s=tok123'],
    ['the founding preview door (secret query)', '/founding?preview=tok123'],
    ['signed-in checkout', '/settings/founding'],
    ['settings', '/settings'],
    ['a child page', '/family/child-1'],
    ['family home', '/home'],
    ['messages', '/messages'],
    ['an rsvp link (bearer token)', '/rsvp/tok123'],
    ['an invite link (bearer token)', '/invite/tok123'],
    ['a path that only starts with the same letters', '/foundingx'],
  ])('loads nothing from Meta on %s', async (_label, url) => {
    const { queue, scripts } = await mountAt(url);
    expect(queue).toEqual([]);
    expect((window as PixelWindow).fbq).toBeUndefined();
    expect(scripts).toEqual([]);
  });
});
