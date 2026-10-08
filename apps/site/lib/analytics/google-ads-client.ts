import {
  GOOGLE_ADS_ID,
  GOOGLE_ADS_GTAG_SRC,
} from './google-ads';

const DENIED = {
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
  analytics_storage: 'denied',
} as const;

const GRANTED = {
  ad_storage: 'granted',
  ad_user_data: 'granted',
  ad_personalization: 'granted',
  analytics_storage: 'granted',
} as const;

type Gtag = (...args: unknown[]) => void;

interface AdsWindow extends Window {
  dataLayer?: unknown[];
  gtag?: Gtag;
  __haleAds?: boolean;
}

function adsWindow(): AdsWindow | null {
  if (typeof window === 'undefined') return null;
  return window as AdsWindow;
}

/**
 * Injects gtag.js only after Accept. Consent Mode v2 starts denied, then
 * flips to granted, before js and config. A second call does not add a
 * second loader.
 */
export function installGoogleAds(): void {
  const w = adsWindow();
  if (!w || w.__haleAds) return;
  // A nested function loses the narrowing on `w`, so the closure uses `win`.
  const win = w;
  win.__haleAds = true;
  win.dataLayer = win.dataLayer || [];
  // Google's loader reads Arguments objects, not arrays. A rest-param push
  // would drop Consent Mode.
  function gtag() {
    // biome-ignore lint/style/noArguments: gtag.js reads an Arguments object, not an array.
    win.dataLayer?.push(arguments);
  }
  win.gtag = gtag as Gtag;
  win.gtag('consent', 'default', DENIED);
  win.gtag('consent', 'update', GRANTED);
  win.gtag('js', new Date());
  win.gtag('config', GOOGLE_ADS_ID);
  const script = document.createElement('script');
  script.async = true;
  script.src = GOOGLE_ADS_GTAG_SRC;
  document.head.appendChild(script);
}

/** Updates Consent Mode when a visitor who had accepted changes to No thanks. */
export function denyGoogleAds(): void {
  const w = adsWindow();
  if (!w?.gtag) return;
  w.gtag('consent', 'update', DENIED);
}

/**
 * Expire one `_gcl_*` cookie on the host that set it and on the parent domain.
 * `_gcl_au` is often written as `Domain=.villagehale.com`, which a host-only
 * clear leaves in place.
 */
export function googleClickCookieClears(hostname: string, name: string): string[] {
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

/** Drops Google's first-party click cookies when consent is withdrawn. */
export function clearGoogleClickCookies(): void {
  if (typeof document === 'undefined') return;
  const host = typeof location === 'undefined' ? '' : location.hostname;
  for (const part of document.cookie.split(';')) {
    const name = part.split('=')[0]?.trim() ?? '';
    if (!name.startsWith('_gcl_')) continue;
    for (const directive of googleClickCookieClears(host, name)) {
      document.cookie = directive;
    }
  }
}
