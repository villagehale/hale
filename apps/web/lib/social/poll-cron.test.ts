import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./ensure-seed', () => ({
  ensureSocialSeed: vi.fn(async () => ({ upserted: 0 })),
}));

vi.mock('./flag', () => ({
  socialWatchlistEnabled: vi.fn(() => false),
}));

import { ensureSocialSeed } from './ensure-seed';
import { socialWatchlistEnabled } from './flag';
import { runSocialWatchCron } from './poll';

describe('runSocialWatchCron', () => {
  beforeEach(() => {
    vi.mocked(ensureSocialSeed).mockReset();
    vi.mocked(ensureSocialSeed).mockResolvedValue({ upserted: 0 });
    vi.mocked(socialWatchlistEnabled).mockReset();
    vi.mocked(socialWatchlistEnabled).mockReturnValue(false);
  });

  it('upserts SOCIAL_SEED before the flag check, including when the flag is off', async () => {
    const order: string[] = [];
    vi.mocked(ensureSocialSeed).mockImplementation(async () => {
      order.push('seed');
      return { upserted: 1 };
    });
    vi.mocked(socialWatchlistEnabled).mockImplementation(() => {
      order.push('flag');
      return false;
    });

    const summary = await runSocialWatchCron({} as never);
    expect(summary).toEqual({ skipped: 'flag_off' });
    expect(order).toEqual(['seed', 'flag']);
  });
});
