import { describe, expect, it, vi } from 'vitest';
import { FLAGS, PAYMENT_ENV_ONLY } from './catalog.js';
import { syncFlags } from './sync.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('syncFlags', () => {
  it('--dry does not write and never creates payment flags', async () => {
    const fetchImpl = vi.fn();
    const result = await syncFlags({
      dry: true,
      env: { POSTHOG_PERSONAL_API_KEY: 'phx', POSTHOG_PROJECT_ID: '1' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.dry).toBe(true);
    expect(result.flags.length).toBe(FLAGS.length);
    expect(result.flags.every((row) => row.action === 'would-create')).toBe(true);
    expect(result.skippedPayments).toEqual(PAYMENT_ENV_ONLY.map((row) => row.env));
    expect(result.flags.some((row) => row.env.includes('PAYMENT'))).toBe(false);
    expect(result.flags.some((row) => row.env.includes('APP_CLIP_PAY'))).toBe(false);
  });

  it('creates missing flags at 100% and leaves matching ones unchanged', async () => {
    const existing = {
      id: 9,
      key: 'f14',
      name: 'f14 (F14_ENABLED)',
      active: true,
      filters: { groups: [{ properties: [], rollout_percentage: 100 }] },
    };
    const created: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path.includes('/groups_types/')) return jsonResponse([]);
      if (path.includes('/feature_flags') && (!init || init.method === 'GET')) {
        return jsonResponse({ results: [existing], next: null });
      }
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as {
          key: string;
          filters: { groups: Array<{ rollout_percentage: number }> };
        };
        created.push(body.key);
        expect(body.filters.groups[0]?.rollout_percentage).toBe(100);
        return jsonResponse({ id: 1, ...body }, 201);
      }
      throw new Error(`unexpected ${init?.method} ${path}`);
    });

    const result = await syncFlags({
      env: {
        POSTHOG_PERSONAL_API_KEY: 'phx',
        POSTHOG_PROJECT_ID: '1',
        POSTHOG_HOST: 'https://us.i.posthog.com',
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.flags.find((row) => row.key === 'f14')?.action).toBe('unchanged');
    expect(created.length).toBe(FLAGS.length - 1);
    expect(created).not.toContain('browser-use-signup-payment');
    expect(created).toContain('authorized-signup');
    expect(created).toContain('claim-reader-mode');
  });
});
