import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The checkout route is back for the holiday promo, but it 404s unless
 * HOLIDAY_PROMO_ENABLED is exactly `true`. The smoke walk still expects that
 * 404 for a signed-in parent on the default-off deploy.
 */

const WEB = fileURLToPath(new URL('../../', import.meta.url));

describe('/api/billing/checkout', () => {
  it('has a route module again', () => {
    expect(existsSync(`${WEB}app/api/health/route.ts`)).toBe(true);
    expect(existsSync(`${WEB}app/api/billing/checkout/route.ts`)).toBe(true);
  });
});
