import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the web + mobile magic-link REQUEST routes. requestMagicLink runs FOR
 * REAL (real token mint + real SHA-256) against a tiny in-memory magic_link_tokens
 * fake — the token/DB logic is never mocked. ONLY the Resend transport boundary is
 * mocked, to capture the outbound URL and prove the emailed link carries a token
 * whose hash is what got persisted. Rate-limit is stubbed to drive the 429 path.
 */

const sendMock = vi.fn();
vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: (...args: unknown[]) => sendMock(...args) },
  })),
}));

const rateLimitedMock = vi.fn();
vi.mock('~/lib/auth/rate-limit', () => ({
  authRateLimited: () => rateLimitedMock(),
}));

// A one-table fake for magic_link_tokens: requestMagicLink invalidates prior
// tokens (update…where) then inserts one. The test scenarios have no prior tokens,
// so invalidate is a no-op; the insert is recorded so we can read back the stored
// hash. (Prior-token invalidation is covered faithfully in magic-link.test.ts.)
const stored: Array<Record<string, unknown>> = [];
function thenable(result: unknown[]) {
  return {
    // biome-ignore lint/suspicious/noThenProperty: drizzle builders are thenable
    then: (resolve: (v: unknown[]) => unknown) => resolve(result),
  };
}
const fakeDb = {
  update() {
    return { set() { return { where: () => thenable([]) }; } };
  },
  insert() {
    return {
      values(v: Record<string, unknown>) {
        stored.push(v);
        return thenable([]);
      },
    };
  },
};
vi.mock('~/lib/db', () => ({ db: () => fakeDb }));

// Poison the real connection factory (rule #1): these routes never open a handle.
vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('magic-link request route must NOT open a real DB (rule #1)');
    },
  };
});

const APP_BASE = 'https://app.villagehale.com';
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');

function tokenFromUrl(url: string): string {
  const parsed = new URL(url);
  const token = parsed.searchParams.get('token');
  if (!token) throw new Error('no token in url');
  return token;
}

/** The url embedded in the last captured outbound email (from its text body). */
function capturedUrl(prefix: string): string {
  const call = sendMock.mock.calls.at(-1);
  if (!call) throw new Error('no email sent');
  const payload = call[0] as { text: string };
  const line = payload.text.split('\n').find((l) => l.startsWith(prefix));
  if (!line) throw new Error(`no ${prefix} url in email`);
  return line.trim();
}

async function callWeb(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const { POST } = await import('~/app/api/auth/magic-link/request/route');
  return POST(
    new Request('http://localhost/api/auth/magic-link/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

async function callMobile(body: unknown): Promise<Response> {
  const { POST } = await import('~/app/api/mobile/auth/magic-link/request/route');
  return POST(
    new Request('http://localhost/api/mobile/auth/magic-link/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.resetModules();
  sendMock.mockReset();
  sendMock.mockResolvedValue({ data: { id: 'msg-1' }, error: null });
  rateLimitedMock.mockReset();
  rateLimitedMock.mockResolvedValue(false);
  stored.length = 0;
  vi.stubEnv('AUTH_SECRET', 'test-secret-for-magic-link-request-routes');
  vi.stubEnv('RESEND_API_KEY', 'test-resend-key');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/auth/magic-link/request (web)', () => {
  it('mints for any valid email (no account needed) and mails a /magic-link URL whose token hashes to the stored value', async () => {
    const res = await callWeb({ email: 'never-seen@example.com' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'sent' });

    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    const url = capturedUrl(`${APP_BASE}/magic-link?token=`);
    expect(url.startsWith(`${APP_BASE}/magic-link?token=`)).toBe(true);
    // The emailed token, hashed, is exactly what was persisted — only Resend mocked.
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenHash).toBe(sha256(tokenFromUrl(url)));
  });

  it('returns the same 200 body for a malformed email but mints and sends nothing (enumeration-safe, uniform)', async () => {
    const res = await callWeb({ email: 'not-an-email' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'sent' });
    expect(stored).toHaveLength(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('returns 400 when email is missing', async () => {
    const res = await callWeb({});
    expect(res.status).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('returns 429 when the per-IP rate limit is tripped, minting and sending nothing', async () => {
    rateLimitedMock.mockResolvedValue(true);

    const res = await callWeb({ email: 'parent@example.com' });

    expect(res.status).toBe(429);
    expect(stored).toHaveLength(0);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/mobile/auth/magic-link/request (mobile)', () => {
  it('mails a /m/magic deep-link landing URL whose token hashes to the stored value', async () => {
    const res = await callMobile({ email: 'app-user@example.com' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'sent' });

    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    const url = capturedUrl(`${APP_BASE}/m/magic?token=`);
    expect(url.startsWith(`${APP_BASE}/m/magic?token=`)).toBe(true);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenHash).toBe(sha256(tokenFromUrl(url)));
  });
});
