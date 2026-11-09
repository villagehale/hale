import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * VIL-581 · the claim-read warm/probe door: nothing — no reader, no model call — for a
 * caller without the cron secret, and `?mode=probe` is the probe.
 */

const runClaimReadWarm = vi.fn();
const runClaimReadProbe = vi.fn();
const defaultClaimReader = vi.fn((_thinking?: string) => ({ read: vi.fn() }));

vi.mock('~/lib/channel/reconcile/claim-read-probe', () => ({
  runClaimReadWarm: (...a: unknown[]) => runClaimReadWarm(...a),
  runClaimReadProbe: (...a: unknown[]) => runClaimReadProbe(...a),
}));
vi.mock('~/lib/channel/reconcile/claim-reader', () => ({
  defaultClaimReader: (thinking?: string) => defaultClaimReader(thinking),
}));
vi.mock('~/lib/cron/heartbeat', () => ({ stampCronHeartbeat: async () => {} }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));

const SECRET = 'test-cron-secret';
const ROUTE_SOURCE = new URL('./route.ts', import.meta.url);

function request(
  query = '',
  headers: Record<string, string> = { authorization: `Bearer ${SECRET}` },
) {
  return new Request(`https://app.example.com/api/cron/claim-read-warm${query}`, { headers });
}

/** The door check, run on any route source: cronRoute with this slug, never the bare gate. */
function walksTheDoor(source: string): boolean {
  return source.includes("cronRoute('claim-read-warm'") && !source.includes('requireCronSecret');
}

describe('GET /api/cron/claim-read-warm', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    runClaimReadWarm.mockReset().mockResolvedValue({ mode: 'warm', skipped: 'reader_off' });
    runClaimReadProbe.mockReset().mockResolvedValue({ mode: 'probe', ok: true, cases: [] });
    defaultClaimReader.mockClear();
  });
  afterEach(() => {
    Reflect.deleteProperty(process.env, 'CRON_SECRET');
    Reflect.deleteProperty(process.env, 'CLAIM_READER_MODE');
  });

  it('answers 401 without the secret and never builds a reader', async () => {
    const { GET } = await import('./route');
    const response = await GET(request('', {}));
    expect(response.status).toBe(401);
    expect(defaultClaimReader).not.toHaveBeenCalled();
    expect(runClaimReadWarm).not.toHaveBeenCalled();
    expect(runClaimReadProbe).not.toHaveBeenCalled();
  });

  it('?mode=probe runs the probe and answers its result', async () => {
    const { GET } = await import('./route');
    const response = await GET(request('?mode=probe'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mode: 'probe', ok: true, cases: [] });
    expect(runClaimReadProbe).toHaveBeenCalledTimes(1);
    expect(runClaimReadWarm).not.toHaveBeenCalled();
  });

  it('anything else warms, with the mode read from CLAIM_READER_MODE and both lanes', async () => {
    process.env.CLAIM_READER_MODE = 'shadow';
    const { GET } = await import('./route');
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(runClaimReadWarm).toHaveBeenCalledTimes(1);
    expect(runClaimReadWarm.mock.calls[0]?.[0]).toMatchObject({ mode: 'shadow' });
    expect(defaultClaimReader.mock.calls.map(([t]) => t)).toEqual(['adaptive', 'off']);
    expect(runClaimReadProbe).not.toHaveBeenCalled();
  });

  it('the route walks the cron door (source check, with a planted control)', () => {
    expect(walksTheDoor(readFileSync(ROUTE_SOURCE, 'utf8'))).toBe(true);
    expect(walksTheDoor('export const GET = handler;')).toBe(false);
  });
});
