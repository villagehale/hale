/**
 * Extra opt-out on top of the cookie banner and DNT. Same cookie/query as the
 * portal so a choice on one Hale origin can be mirrored by the visitor; the
 * marketing site still also requires an explicit Accept before PostHog loads.
 *
 * No privacy-page UI here (VIL-428).
 */

export const ANALYTICS_OPT_OUT_COOKIE = 'hale_analytics_opt_out';
export const ANALYTICS_OPT_OUT_STORAGE_KEY = 'hale_analytics_opt_out';
export const ANALYTICS_OPT_OUT_QUERY = 'analytics';
export const ANALYTICS_OPT_OUT_QUERY_VALUE = 'off';

function cookieHasOptOut(): boolean {
  if (typeof document === 'undefined') return false;
  return document.cookie.split(';').some((part) => {
    const [name, value] = part.trim().split('=');
    return name === ANALYTICS_OPT_OUT_COOKIE && value === '1';
  });
}

function storageHasOptOut(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(ANALYTICS_OPT_OUT_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function persistAnalyticsOptOut(): void {
  if (typeof document !== 'undefined') {
    document.cookie = `${ANALYTICS_OPT_OUT_COOKIE}=1; path=/; max-age=31536000; SameSite=Lax`;
  }
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ANALYTICS_OPT_OUT_STORAGE_KEY, '1');
  } catch {
    // Private mode: the cookie (if it wrote) is the remaining latch.
  }
}

export function hasAnalyticsOptOut(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get(ANALYTICS_OPT_OUT_QUERY) === ANALYTICS_OPT_OUT_QUERY_VALUE) {
      persistAnalyticsOptOut();
      return true;
    }
  } catch {
    // A weird location.search is not an opt-out.
  }
  return cookieHasOptOut() || storageHasOptOut();
}
