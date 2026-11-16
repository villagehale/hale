import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTION_COOKIE,
  attributionFromRequest,
  attributionFromStripeMetadata,
  attributionToStripeMetadata,
} from './attribution.js';

describe('attributionFromRequest', () => {
  it('reads the cookie, then fills gaps from the query and body (first touch wins)', () => {
    const attribution = attributionFromRequest({
      cookieHeader: `${ATTRIBUTION_COOKIE}=${encodeURIComponent('utm_source=poster&utm_medium=qr')}`,
      search: 'utm_source=google&gclid=Click1',
      body: { fbclid: 'Face1', utm_campaign: 'holiday' },
    });
    expect(attribution).toEqual({
      utm_source: 'poster',
      utm_medium: 'qr',
      gclid: 'Click1',
      fbclid: 'Face1',
      utm_campaign: 'holiday',
    });
  });

  it('survives a round-trip through Stripe metadata', () => {
    const attribution = attributionFromRequest({
      search: 'utm_source=google&utm_content=hero&gclid=Gw',
    });
    const metadata = attributionToStripeMetadata(attribution);
    expect(metadata).toEqual({
      utm_source: 'google',
      utm_content: 'hero',
      gclid: 'Gw',
    });
    expect(attributionFromStripeMetadata(metadata)).toEqual(attribution);
  });
});
