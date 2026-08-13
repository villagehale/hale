import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeOtpSender } from '~/lib/channels/otp-sender';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';

/**
 * The claim-by-phone REQUEST route. The core runs for real against a table-keyed DB
 * fake — the point of these tests is the property the core alone cannot have: that
 * three different database states produce ONE indistinguishable HTTP response, and
 * that the only thing which varies is whether an SMS left the building.
 *
 * Only two boundaries are mocked: the SMS sender (so a code never reaches a carrier)
 * and the rate limiters (so their paths are drivable).
 */

const KEY = Buffer.alloc(32, 5).toString('base64');
const PHONE = '+15195551234';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const FAMILY_ID = '44444444-4444-4444-8444-444444444444';

let sender = new FakeOtpSender();
vi.mock('~/lib/auth/claim-code-sender', () => ({
  createClaimCodeSender: () => sender,
}));

const authRateLimitedMock = vi.fn(async () => false);
vi.mock('~/lib/auth/rate-limit', () => ({
  authRateLimited: () => authRateLimitedMock(),
}));

const enforceRateLimitMock = vi.fn(async (..._args: unknown[]) => null as Response | null);
vi.mock('~/lib/rate-limit/apply', () => ({
  enforceRateLimit: (...args: unknown[]) => enforceRateLimitMock(...args),
}));

vi.mock('~/lib/auth-config', () => ({ authConfigured: () => true }));

let rows: { channels?: unknown[]; members?: unknown[]; verifications?: unknown[] } = {};

function thenable(result: unknown[]) {
  const c: Record<string, unknown> = {};
  for (const m of ['where', 'orderBy', 'from', 'onConflictDoNothing']) c[m] = vi.fn(() => c);
  c.limit = vi.fn(() => Promise.resolve(result));
  c.returning = vi.fn(() => Promise.resolve(result));
  c.set = vi.fn(() => c);
  c.values = vi.fn(() => c);
  // biome-ignore lint/suspicious/noThenProperty: test double of a thenable query builder
  c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return c;
}

function rowsFor(table: unknown): unknown[] {
  if (table === schema.parentChannels) return rows.channels ?? [];
  if (table === schema.familyMembers) return rows.members ?? [];
  if (table === schema.phoneVerifications) return rows.verifications ?? [];
  return [];
}

const fakeDb = {
  select: () => ({ from: (table: unknown) => thenable(rowsFor(table)) }),
  update: (table: unknown) => thenable(rowsFor(table)),
  insert: (table: unknown) => thenable(rowsFor(table)),
  transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(fakeDb),
};
vi.mock('~/lib/db', () => ({ db: () => fakeDb }));

// Rule #1: this route must never open a real connection.
vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('claim-phone request route must NOT open a real DB');
    },
  };
});

function activeChannel(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER_ID,
    familyId: FAMILY_ID,
    id: '55555555-5555-4555-8555-555555555555',
    phoneE164Hash: phoneBlindIndex(PHONE),
    verifiedAt: new Date('2026-08-01T00:00:00.000Z'),
    revokedAt: null,
    ...overrides,
  };
}

async function post(body: unknown): Promise<Response> {
  const { POST } = await import('~/app/api/auth/claim-phone/request/route');
  return POST(
    new Request('http://localhost/api/auth/claim-phone/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

/** Body + status together — the thing that must not vary between callers. */
async function shapeOf(res: Response): Promise<string> {
  return `${res.status}:${await res.text()}`;
}

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  process.env.F14_RECEIPTS_IA = 'true';
  sender = new FakeOtpSender();
  rows = {};
  authRateLimitedMock.mockResolvedValue(false);
  enforceRateLimitMock.mockResolvedValue(null);
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  process.env.APP_ENCRYPTION_KEY = '';
  process.env.F14_RECEIPTS_IA = '';
  vi.restoreAllMocks();
});

describe('POST /api/auth/claim-phone/request', () => {
  it('answers a parent, an unknown number and an opted-out number IDENTICALLY', async () => {
    rows = { channels: [activeChannel()], members: [{ familyId: FAMILY_ID, userId: USER_ID, role: 'primary_parent' }] };
    const parent = await shapeOf(await post({ phone: PHONE }));
    expect(sender.sent).toHaveLength(1); // the code went to the number, not the browser

    sender = new FakeOtpSender();
    rows = { channels: [] };
    const unknown = await shapeOf(await post({ phone: PHONE }));
    expect(sender.sent).toEqual([]);

    sender = new FakeOtpSender();
    rows = {
      channels: [activeChannel({ revokedAt: new Date('2026-08-05T00:00:00.000Z') })],
      members: [{ familyId: FAMILY_ID, userId: USER_ID, role: 'primary_parent' }],
    };
    const optedOut = await shapeOf(await post({ phone: PHONE }));
    expect(sender.sent).toEqual([]); // STOP means STOP, even for a code they asked for

    expect(unknown).toBe(parent);
    expect(optedOut).toBe(parent);
    expect(parent).toBe('200:{"status":"accepted"}');
  });

  it('answers a caregiver number with that same response and no SMS', async () => {
    rows = {
      channels: [activeChannel()],
      members: [{ familyId: FAMILY_ID, userId: USER_ID, role: 'nanny' }],
    };

    const res = await post({ phone: PHONE });

    expect(await shapeOf(res)).toBe('200:{"status":"accepted"}');
    expect(sender.sent).toEqual([]);
  });

  it('never puts the number or the code in the log line', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    rows = {
      channels: [activeChannel()],
      members: [{ familyId: FAMILY_ID, userId: USER_ID, role: 'primary_parent' }],
    };

    await post({ phone: PHONE });

    const logged = JSON.stringify(info.mock.calls);
    expect(logged).toContain('sent');
    expect(logged).not.toContain('5195551234');
    expect(logged).not.toContain(sender.sent[0]?.code ?? 'no-code');
  });

  it('does not exist while the flag is dark', async () => {
    process.env.F14_RECEIPTS_IA = '';
    rows = {
      channels: [activeChannel()],
      members: [{ familyId: FAMILY_ID, userId: USER_ID, role: 'primary_parent' }],
    };

    const res = await post({ phone: PHONE });

    expect(res.status).toBe(404);
    expect(sender.sent).toEqual([]);
  });

  it('is dark for a flag value that merely looks true', async () => {
    // `vercel env add` fed from a piped echo stores a trailing newline.
    process.env.F14_RECEIPTS_IA = 'true\n';
    const res = await post({ phone: PHONE });
    expect(res.status).toBe(404);
  });

  it('caps the sends per NUMBER, keyed on the blind index and never the number', async () => {
    rows = {
      channels: [activeChannel()],
      members: [{ familyId: FAMILY_ID, userId: USER_ID, role: 'primary_parent' }],
    };
    await post({ phone: '(519) 555-1234' });

    expect(enforceRateLimitMock).toHaveBeenCalledWith(
      'claim-phone-send',
      phoneBlindIndex(PHONE),
      true, // fail-closed: an unauthenticated send limit must not lift on an outage
    );
  });

  it('refuses when the per-number cap is spent, without sending', async () => {
    enforceRateLimitMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 }),
    );
    rows = {
      channels: [activeChannel()],
      members: [{ familyId: FAMILY_ID, userId: USER_ID, role: 'primary_parent' }],
    };

    const res = await post({ phone: PHONE });

    expect(res.status).toBe(429);
    expect(sender.sent).toEqual([]);
  });

  it('refuses when the per-IP auth window is spent, before any number lookup', async () => {
    authRateLimitedMock.mockResolvedValue(true);
    rows = {
      channels: [activeChannel()],
      members: [{ familyId: FAMILY_ID, userId: USER_ID, role: 'primary_parent' }],
    };

    const res = await post({ phone: PHONE });

    expect(res.status).toBe(429);
    expect(enforceRateLimitMock).not.toHaveBeenCalled();
    expect(sender.sent).toEqual([]);
  });

  it('rejects a request with no number at all', async () => {
    expect((await post({})).status).toBe(400);
  });

  it('accepts a malformed number with the same body, sending nothing', async () => {
    const res = await post({ phone: '555' });

    expect(await shapeOf(res)).toBe('200:{"status":"accepted"}');
    expect(sender.sent).toEqual([]);
  });
});
