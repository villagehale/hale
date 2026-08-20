import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INBOUND_TURN_QUEUES } from './drain';

/**
 * The kick is the whole reason a parent's text is answered in seconds rather than on the
 * next cron tick, so the two things that make it real are pinned here: it is AWAITED (a
 * serverless instance may be frozen the moment the after() callback returns, and a
 * fire-and-forget fetch freezes with it), and it never fails silently.
 *
 * The module carries per-instance state (in-flight count, back-off deadline), so every
 * test gets a FRESH copy of it — a leaked back-off window would silently shed the kicks
 * a later test is asserting.
 */

const ORIGIN = 'https://app.example.com';

describe('kickDrain', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let errors: unknown[][];
  let kickDrain: typeof import('./kick-drain').kickDrain;
  let MAX_IN_FLIGHT_KICKS: number;
  let KICK_BACKOFF_MS: number;

  beforeEach(async () => {
    process.env.CRON_SECRET = 'test-secret';
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    vi.resetModules();
    ({ kickDrain, MAX_IN_FLIGHT_KICKS, KICK_BACKOFF_MS } = await import('./kick-drain'));
  });

  afterEach(() => {
    vi.useRealTimers();
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

  // 502, not 503: a 503 is the drain saying it has no database connection, and that one
  // is a back-off rather than a retry (see the exhaustion test below).
  it('retries a 5xx once, but never a 4xx — config errors do not heal on retry', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 502 }));
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

  /**
   * THE FAN-OUT, as a test. One kick per inbound text and nothing bounding them: a
   * burst of concurrent turns on one instance became a burst of drain invocations, each
   * holding its own pg-boss connection on the direct 5432 port plus the drain's pools,
   * on a database with tens of usable connections. The cap is what makes the burst cost
   * a fixed number of connections instead of one per text.
   */
  it('sheds a kick once this instance is at its in-flight cap, and says so', async () => {
    const release: Array<(response: Response) => void> = [];
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release.push(resolve);
        }),
    );

    const held = Array.from({ length: MAX_IN_FLIGHT_KICKS }, () => kickDrain(ORIGIN));
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(MAX_IN_FLIGHT_KICKS);

    await kickDrain(ORIGIN);

    expect(fetchMock).toHaveBeenCalledTimes(MAX_IN_FLIGHT_KICKS);
    expect(errors.at(-1)?.[0]).toMatchObject({ reason: 'at_capacity' });

    // The positive control: the cap is a cap, not a latch — once the held kicks
    // settle the next one goes out.
    for (const resolve of release) resolve(new Response(null, { status: 200 }));
    await Promise.all(held);
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    await kickDrain(ORIGIN);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_IN_FLIGHT_KICKS + 1);
  });

  /**
   * THE AMPLIFIER, as a test. When the drain cannot get a database connection, the one
   * thing that must not happen is a second invocation asking for a connection that is
   * not there — but "retry once on a 5xx" did exactly that, so every kick during
   * exhaustion became two. A 503 is the drain saying so; the answer is to stop kicking
   * for a while, and to say that out loud (rule #11).
   */
  it('treats a drain with no database connection as back-off, never as a retry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T14:00:00Z'));
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

    await kickDrain(ORIGIN);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(errors.at(-1)?.[0]).toMatchObject({ reason: 'http_503' });

    fetchMock.mockClear();
    await kickDrain(ORIGIN);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errors.at(-1)?.[0]).toMatchObject({ reason: 'backing_off' });

    // The positive control: the window closes on its own — this is a pause, not a kill
    // switch, and a recovered database must get kicks again without a redeploy.
    vi.setSystemTime(new Date(Date.now() + KICK_BACKOFF_MS + 1));
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    await kickDrain(ORIGIN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('logs a reason when no cron secret is configured', async () => {
    Reflect.deleteProperty(process.env, 'CRON_SECRET');

    await kickDrain(ORIGIN);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(errors[0]?.[0]).toMatchObject({ reason: 'no_cron_secret' });
  });
});
