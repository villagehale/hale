import { describe, expect, it } from 'vitest';
import { FakeRateLimiter } from './fake';

const OPTS = { limit: 3, windowSec: 60 };

describe('FakeRateLimiter — fixed-window contract', () => {
  it('allows requests up to the limit, then refuses', async () => {
    const rl = new FakeRateLimiter(() => 0);

    const results = [];
    for (let i = 0; i < 4; i++) results.push(await rl.check('user-a', 'coach', OPTS));

    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
  });

  it('reports retryAfterSec as the seconds left in the window', async () => {
    // 10s into a 60s window → 50s remain until it rolls over.
    const rl = new FakeRateLimiter(() => 10_000);

    const res = await rl.check('user-a', 'coach', OPTS);

    expect(res.retryAfterSec).toBe(50);
  });

  it('resets the count when the window rolls over', async () => {
    let nowMs = 0;
    const rl = new FakeRateLimiter(() => nowMs);

    for (let i = 0; i < 3; i++) await rl.check('user-a', 'coach', OPTS);
    expect((await rl.check('user-a', 'coach', OPTS)).allowed).toBe(false);

    nowMs = 60_000; // advance past the window boundary
    expect((await rl.check('user-a', 'coach', OPTS)).allowed).toBe(true);
  });

  it('isolates counts per identifier — user A exhausting does not limit user B', async () => {
    const rl = new FakeRateLimiter(() => 0);

    for (let i = 0; i < 4; i++) await rl.check('user-a', 'coach', OPTS);

    expect((await rl.check('user-b', 'coach', OPTS)).allowed).toBe(true);
  });

  it('isolates counts per route — exhausting one route does not limit another', async () => {
    const rl = new FakeRateLimiter(() => 0);

    for (let i = 0; i < 4; i++) await rl.check('user-a', 'coach', OPTS);

    expect((await rl.check('user-a', 'ingest', OPTS)).allowed).toBe(true);
  });
});
