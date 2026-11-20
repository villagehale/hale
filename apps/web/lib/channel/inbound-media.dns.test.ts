import { describe, expect, it, vi } from 'vitest';

/**
 * Devin SEC_0001 (#985), production wiring: with no fetcher injected, a `.vcf` on a
 * public-looking name is fetched through the vetted lookup, so a name that resolves to a
 * private address is never connected to.
 */
const lookup = vi.fn(async () => [{ address: '10.0.0.5', family: 4 }]);
vi.mock('node:dns/promises', () => ({ lookup, default: { lookup } }));

const { readInboundMedia } = await import('./inbound-media');

describe('readInboundMedia default contact fetch', () => {
  it('resolves the card host through the vetted lookup and refuses a private answer', async () => {
    const read = await readInboundMedia([
      { kind: 'contact', url: 'https://10.0.0.5.nip.example/card.vcf', mime: 'text/vcard' },
    ]);
    expect(lookup).toHaveBeenCalledWith('10.0.0.5.nip.example', { all: true });
    expect(read.contacts).toEqual([]);
    expect(read.unwatched).toEqual([{ kind: 'contact' }]);
  });
});
