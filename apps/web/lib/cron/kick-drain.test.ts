import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INBOUND_TURN_QUEUES } from './drain';
import { kickDrain } from './kick-drain';

/**
 * The kick is the whole reason a parent's text is answered in seconds rather than on the
 * next cron tick, so the two things that make it real are pinned here: it is AWAITED (a
 * serverless instance may be frozen the moment the after() callback returns, and a
 * fire-and-forget fetch freezes with it), and it never fails silently.
 */

const ORIGIN = 'https://app.example.com';

describe('kickDrain', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let errors: unknown[][];

  beforeEach(() => {
    process.env.CRON_SECRET = 'test-secret';
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Reflect.deleteProperty(process.env, 'CRON_SECRET');
  });

  /**
   * THE PICKUP BUG, as a test. `void fetch(...)` inside after() hands the platform a
   * callback that is already finished, so the instance can be suspended before the
   * request leaves the box — which is why a kicked drain was arriving 12-19s after the
   * text that kicked it. The promise this returns is the only thing that keeps the
   * instance awake long enough for the request to happen.
   */
  it('does not resolve until the drain request settles', async () => {
    let release: (value: Response) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );

    let settled = false;
    const kick = kickDrain(ORIGIN).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    release(new Response(null, { status: 200 }));
    await kick;
    expect(settled).toBe(true);
  });

  /** The slice is what keeps a parent's text off the back of the outbound/LLM queues. */
  it('asks for only the requested queues', async () => {
    await kickDrain(ORIGIN, INBOUND_TURN_QUEUES);

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/api/cron/drain');
    expect(url.searchParams.get('queues')).toBe('channel.message.received');
  });

  it('asks for every queue when no slice is named', async () => {
    await kickDrain(ORIGIN);

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.has('queues')).toBe(false);
  });

  /** Rule #11: an absent kick is an OUTCOME, never a silent no-op. */
  it('logs a reason when the drain answers non-2xx', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

    await kickDrain(ORIGIN);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.[0]).toMatchObject({ reason: 'http_401' });
  });

  /**
   * THE COLD-START TIMEOUT, as a test. Measured in production 2026-08-15 22:21: the
   * kick aborted on its 60s timeout, the drain never effectively ran, and the parent's
   * text waited 81s for the NEXT inbound's kick. A single bounded retry is safe by
   * construction — pg-boss job locking plus the turn ledger make a double drain a
   * no-op — and it converts "cron will reap" into a served turn.
   */
  it('retries once when the request fails, and succeeds quietly on the retry', async () => {
    fetchMock.mockRejectedValueOnce(new Error('The operation was aborted due to timeout'));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    await kickDrain(ORIGIN);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The first failure is still visible (named, logged), marked as retried.
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[0]).toMatchObject({ reason: 'request_failed', retrying: true });
  });

  it('retries a 5xx once, but never a 4xx — config errors do not heal on retry', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await kickDrain(ORIGIN);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    await kickDrain(ORIGIN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after one retry, and the final failure still says the cron will reap', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await kickDrain(ORIGIN);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(2);
    expect(errors[1]?.[0]).toMatchObject({ reason: 'request_failed' });
    expect(errors[1]?.[1]).toContain('cron will reap');
  });

  it('logs a reason when the drain request throws', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await kickDrain(ORIGIN);

    expect(errors[errors.length - 1]?.[0]).toMatchObject({ reason: 'request_failed' });
  });

  it('logs a reason when no cron secret is configured', async () => {
    Reflect.deleteProperty(process.env, 'CRON_SECRET');

    await kickDrain(ORIGIN);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(errors[0]?.[0]).toMatchObject({ reason: 'no_cron_secret' });
  });
});
