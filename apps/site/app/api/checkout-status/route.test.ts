import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

const URL_WITH_ID = 'https://villagehale.com/api/checkout-status?session_id=cs_test_poll';

function stubApp(view: unknown, status = 200) {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          transactionId: 'cs_test_poll',
          value: 59,
          currency: 'CAD',
          paid: true,
          tier: 'plus',
          ...(view === undefined ? {} : { view }),
        }),
        { status },
      ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('GET /api/checkout-status', () => {
  it('is a 404 with the flag off and never asks the app', async () => {
    vi.stubEnv('CHECKOUT_SUCCESS_STATES_ENABLED', undefined);
    const fetchMock = stubApp({ state: 'plan_active' });
    const res = await GET(new Request(URL_WITH_ID));
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('with the flag on', () => {
    beforeEach(() => {
      vi.stubEnv('CHECKOUT_SUCCESS_STATES_ENABLED', 'true');
    });

    it('is a 400 on a malformed id, without asking the app', async () => {
      const fetchMock = stubApp({ state: 'pending' });
      const res = await GET(
        new Request('https://villagehale.com/api/checkout-status?session_id=nope'),
      );
      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('is unsettled while the state is pending', async () => {
      stubApp({ state: 'pending' });
      const res = await GET(new Request(URL_WITH_ID));
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({ settled: false });
    });

    it('says only that it settled, never who or which state', async () => {
      stubApp({ state: 'plan_active', firstName: 'Riley', checkInDue: true });
      const res = await GET(new Request(URL_WITH_ID));
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.text()).toBe('{"settled":true}');
    });

    it.each(['receipt', 'under_review', 'not_paid', 'unknown', 'new_visitor'])(
      'ends the wait on %s',
      async (state) => {
        stubApp({ state });
        const res = await GET(new Request(URL_WITH_ID));
        expect(await res.json()).toEqual({ settled: true });
      },
    );

    it('stays unsettled when the app fails or sends no view', async () => {
      stubApp({ state: 'plan_active' }, 502);
      expect(await (await GET(new Request(URL_WITH_ID))).json()).toEqual({ settled: false });
      stubApp(undefined);
      expect(await (await GET(new Request(URL_WITH_ID))).json()).toEqual({ settled: false });
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
      expect(await (await GET(new Request(URL_WITH_ID))).json()).toEqual({ settled: false });
    });
  });
});
