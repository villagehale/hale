import { describe, expect, it, vi } from 'vitest';
import { RegistrationPageRedirect } from '~/lib/registration/page';
import { createActivityPageFetch } from './page';

describe('activity source redirects', () => {
  it('reads a moved official page and retains the final source URL', async () => {
    const old = 'https://venue.example/old';
    const current = 'https://venue.example/programs';
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new RegistrationPageRedirect(current))
      .mockResolvedValueOnce('Current official page');
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
    const fetch = vi.fn().mockRejectedValue(new RegistrationPageRedirect(target));
    await expect(createActivityPageFetch(fetch)('https://venue.example/old')).rejects.toThrow(
      'unsafe URL',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('bounds redirect loops without retrying ordinary fetch failures', async () => {
    const loop = vi
      .fn()
      .mockRejectedValue(new RegistrationPageRedirect('https://venue.example/loop'));
    await expect(createActivityPageFetch(loop)('https://venue.example/old')).rejects.toThrow();
    expect(loop).toHaveBeenCalledTimes(4);
    const failed = vi.fn().mockRejectedValue(new Error('timeout'));
    await expect(createActivityPageFetch(failed)('https://venue.example/old')).rejects.toThrow(
      'timeout',
    );
    expect(failed).toHaveBeenCalledTimes(1);
  });
});
