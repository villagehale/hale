import { parseMetaPixelIds } from './meta-pixel';
import { hasPromoPreviewQuery } from './posthog-provider';

const PIXEL_SRC = 'https://connect.facebook.net/en_US/fbevents.js';

type Fbq = ((...args: unknown[]) => void) & {
  callMethod?: (...args: unknown[]) => void;
  queue?: unknown[];
  loaded?: boolean;
  version?: string;
  push?: Fbq;
};

interface PixelWindow extends Window {
  fbq?: Fbq;
  _fbq?: Fbq;
  __haleMetaPixel?: boolean;
}

/**
 * The only app paths the browser pixel loads on: the public pre-signup join page ads
 * land on. Every other app page carries a bearer token in its URL (/l/<code>, the
 * texted connect and sign-in links) or shows a family's data, and must load nothing
 * from Meta (hard rule #1). `/founding?preview=` carries a secret, so it is out too.
 */
export const META_PIXEL_PATH_PREFIXES = ['/founding'] as const;

export function metaPixelAllowedOn(pathname: string | null, search: string): boolean {
  if (!pathname || hasPromoPreviewQuery(search)) return false;
  return META_PIXEL_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function pixelWindow(): PixelWindow | null {
  if (typeof window === 'undefined') return null;
  return window as PixelWindow;
}

/**
 * Meta Pixel base snippet. Inits every dataset id, then tracks PageView once.
 * `fbq('track')` sends that event to each initialized pixel, so one track is
 * one PageView per pixel. A second track, or `trackSingle` beside it, would
 * count the event twice. A second call does not add a second loader.
 * Purchase is not fired here — CAPI owns Purchase.
 */
export function installMetaPixel(pixelId: string | readonly string[]): void {
  const ids = parseMetaPixelIds(pixelId);
  const w = pixelWindow();
  if (!w || ids.length === 0 || w.__haleMetaPixel) return;
  w.__haleMetaPixel = true;
  const fbq = ((...args: unknown[]) => {
    if (fbq.callMethod) {
      fbq.callMethod(...args);
      return;
    }
    if (!fbq.queue) fbq.queue = [];
    fbq.queue.push(args);
  }) as Fbq;
  fbq.push = fbq;
  fbq.loaded = true;
  fbq.version = '2.0';
  fbq.queue = [];
  w.fbq = fbq;
  w._fbq = fbq;
  for (const id of ids) fbq('init', id);
  fbq('track', 'PageView');
  const script = document.createElement('script');
  script.async = true;
  script.src = PIXEL_SRC;
  document.head.appendChild(script);
}

export function metaClickCookieClears(hostname: string, name: string): string[] {
  const clears = [`${name}=; Max-Age=0; path=/`];
  if (hostname) {
    clears.push(`${name}=; Max-Age=0; path=/; domain=${hostname}`);
    const labels = hostname.split('.').filter(Boolean);
    if (labels.length >= 3) {
      const parent = labels.slice(1).join('.');
      clears.push(`${name}=; Max-Age=0; path=/; domain=${parent}`);
      clears.push(`${name}=; Max-Age=0; path=/; domain=.${parent}`);
    }
  }
  return clears;
}

export function clearMetaClickCookies(): void {
  if (typeof document === 'undefined') return;
  const host = typeof location === 'undefined' ? '' : location.hostname;
  for (const part of document.cookie.split(';')) {
    const name = part.split('=')[0]?.trim() ?? '';
    if (name !== '_fbp' && name !== '_fbc') continue;
    for (const directive of metaClickCookieClears(host, name)) {
      document.cookie = directive;
    }
  }
}
