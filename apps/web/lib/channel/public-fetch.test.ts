import { describe, expect, it, vi } from 'vitest';
import { createPublicFetch, publicLookup } from './public-fetch';

type Answer = Array<{ address: string; family: number }>;

function lookupOnce(answer: Answer, hostname = 'cards.example') {
  const resolve = vi.fn(async () => answer);
  return new Promise<{ err: Error | null; address: string; resolve: typeof resolve }>((done) => {
    publicLookup(resolve)(hostname, {}, (err, address) =>
      done({ err, address: address as string, resolve }),
    );
  });
}

describe('publicLookup', () => {
  it('hands the socket the vetted public address it resolved', async () => {
    const out = await lookupOnce([{ address: '93.184.215.14', family: 4 }]);
    expect(out.err).toBeNull();
    expect(out.address).toBe('93.184.215.14');
    expect(out.resolve).toHaveBeenCalledWith('cards.example');
  });

  it('refuses a public name whose answer is private, link-local, or mixed', async () => {
    for (const answer of [
      [{ address: '10.0.0.5', family: 4 }],
      [{ address: '169.254.169.254', family: 4 }],
      [{ address: '127.0.0.1', family: 4 }],
      [{ address: '::1', family: 6 }],
      [{ address: 'fd00::1', family: 6 }],
      [
        { address: '93.184.215.14', family: 4 },
        { address: '192.168.1.10', family: 4 },
      ],
      [],
    ]) {
      const out = await lookupOnce(answer);
      expect(out.err?.name).toBe('NonPublicAddressError');
      expect(out.address).toBe('');
    }
  });
});

describe('createPublicFetch', () => {
  it('resolves through the vetted lookup and never connects to a private answer', async () => {
    const resolve = vi.fn(async () => [{ address: '10.0.0.5', family: 4 }]);
    const publicFetch = createPublicFetch({ resolve, maxBytes: 1000 });
    await expect(
      publicFetch('https://10.0.0.5.nip.example/card.vcf', {
        signal: AbortSignal.timeout(2000),
      }),
    ).rejects.toMatchObject({ name: 'NonPublicAddressError' });
    expect(resolve).toHaveBeenCalledWith('10.0.0.5.nip.example');
  });

  it('refuses a private IP literal without a lookup (the socket skips lookup for literals)', async () => {
    const resolve = vi.fn(async () => [{ address: '93.184.215.14', family: 4 }]);
    const publicFetch = createPublicFetch({ resolve, maxBytes: 1000 });
    await expect(
      publicFetch('https://169.254.169.254/latest', { signal: AbortSignal.timeout(2000) }),
    ).rejects.toMatchObject({ name: 'NonPublicAddressError' });
    await expect(
      publicFetch('http://cards.example/card.vcf', { signal: AbortSignal.timeout(2000) }),
    ).rejects.toMatchObject({ name: 'NotHttpsError' });
    expect(resolve).not.toHaveBeenCalled();
  });
});
