import { describe, expect, it } from 'vitest';
import { GET } from './route';

describe('GET /api/visitor-currency', () => {
  it('returns USD for a US visitor and CAD otherwise', async () => {
    const us = await GET(
      new Request('https://villagehale.com/api/visitor-currency', {
        headers: { 'x-vercel-ip-country': 'US' },
      }),
    );
    expect(await us.json()).toEqual({ currency: 'USD' });
    const missing = await GET(new Request('https://villagehale.com/api/visitor-currency'));
    expect(await missing.json()).toEqual({ currency: 'CAD' });
  });
});
