import type { Attribution } from '@hale/types';
import { routing } from '~/i18n/routing';
import type { AnalyticsEvent } from './events';
import { posthogWebEnabled } from './flags';

/**
 * The site's step of the web funnel: one `pricing_viewed` per arrival on /pricing, in
 * any locale. Pure, so the once-per-arrival rule is tested without a browser; the
 * component in funnel-page-views.tsx is only the wiring.
 */

export type FunnelView = Extract<AnalyticsEvent, 'pricing_viewed'>;

const LOCALE_PREFIX = `(?:/(?:${routing.locales.join('|')}))?`;
const PRICING_PATH = new RegExp(`^${LOCALE_PREFIX}/pricing/?$`);

export function funnelViewForPath(pathname: string): FunnelView | null {
  return PRICING_PATH.test(pathname) ? 'pricing_viewed' : null;
}

/**
 * Remembers the last path it reported on. A path is marked only once capture can send
 * (`ready`), so a view that arrives before the client loads is not lost, and a
 * re-render or a query change on the same path never fires it again.
 */
export function createFunnelViewTracker(): {
  observe(pathname: string, ready: boolean): FunnelView | null;
} {
  let handled: string | null = null;
  return {
    observe(pathname, ready) {
      if (!ready || pathname === handled) return null;
      handled = pathname;
      return funnelViewForPath(pathname);
    },
  };
}

/**
 * The attribution the hale_attr cookie carries to checkout. With web analytics on, the
 * first-touch card code (read and validated by source-code.ts) rides along so a paid
 * checkout can be credited to the card. Off, the code is not even read, so the cookie
 * and the tab's storage stay what they were.
 */
export function funnelAttributionForCookie(
  attribution: Attribution,
  readSourceCode: () => string | null,
  env?: Record<string, string | undefined>,
): Attribution {
  if (!posthogWebEnabled(env)) return attribution;
  const sourceCode = readSourceCode();
  return sourceCode ? { ...attribution, source_code: sourceCode } : attribution;
}
