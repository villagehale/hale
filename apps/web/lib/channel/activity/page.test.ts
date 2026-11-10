import { describe, expect, it, vi } from 'vitest';
import type { RegistrationPageFetch } from '~/lib/registration/page';
import { createActivityPageFetch } from './page';

function fetchOf(
  impl:
    | RegistrationPageFetch
    | ((url: string) => Promise<RegistrationPageFetch> | RegistrationPageFetch),
) {
  return vi.fn(async (url: string) => (typeof impl === 'function' ? impl(url) : impl));
}

describe('activity source redirects', () => {
  it('reads a moved official page and retains the final source URL', async () => {
    const old = 'https://venue.example/old';
    const current = 'https://venue.example/programs';
    const fetch = fetchOf(async (url) =>
      url === old
        ? { outcome: 'redirected', location: current }
        : { outcome: 'fetched', body: Buffer.from('Current official page') },
    );
    expect(await createActivityPageFetch(fetch)(old)).toEqual({
      url: current,
      text: 'Current official page',
    });
    expect(fetch.mock.calls).toEqual([[old], [current]]);
  });

  it.each([
    'http://venue.example/a',
    'https://127.0.0.1/a',
    'https://venue.example/a?token=private',
  ])('refuses unsafe redirect %s before another request', async (target) => {
    const fetch = fetchOf({ outcome: 'redirected', location: target });
    await expect(createActivityPageFetch(fetch)('https://venue.example/old')).rejects.toThrow(
      'unsafe URL',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('bounds redirect loops without retrying ordinary fetch failures', async () => {
    const loop = fetchOf({
      outcome: 'redirected',
      location: 'https://venue.example/loop',
    });
    await expect(createActivityPageFetch(loop)('https://venue.example/old')).rejects.toThrow();
    expect(loop).toHaveBeenCalledTimes(4);
    const failed = fetchOf({ outcome: 'failed', reason: 'timeout' });
    await expect(createActivityPageFetch(failed)('https://venue.example/old')).rejects.toThrow(
      'timeout',
    );
    expect(failed).toHaveBeenCalledTimes(1);
  });
});
