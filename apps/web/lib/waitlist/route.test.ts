import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the db edge so the test exercises the route's contract — validation,
// honeypot, CORS, membership non-disclosure — not real infra. The insert chain
// records what would be written.
const inserted: unknown[] = [];
vi.mock('~/lib/db', () => ({
  db: () => ({
    insert: () => ({
      values: (v: unknown) => ({
        onConflictDoNothing: async () => {
          inserted.push(v);
        },
      }),
    }),
  }),
}));

const SITE_ORIGIN = 'https://villagehale.com';

async function callPost(body: unknown, origin: string | null = SITE_ORIGIN) {
  const { POST } = await import('~/app/api/waitlist/route');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (origin) headers.origin = origin;
  return POST(
    new Request('http://localhost/api/waitlist', {
      method: 'POST',
      body: JSON.stringify(body),
      headers,
    }),
  );
}

describe('POST /api/waitlist', () => {
  beforeEach(() => {
    vi.resetModules();
    inserted.length = 0;
  });

  it('accepts a valid signup, normalizes the email, and stamps the source', async () => {
    const res = await callPost({
      email: '  Parent@Example.COM ',
      neighbourhood: 'Georgetown',
      tier: 'plus',
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(inserted).toEqual([
      {
        email: 'parent@example.com',
        neighbourhood: 'Georgetown',
        tier: 'plus',
        source: 'landing_pricing',
      },
    ]);
  });

  it('rejects a malformed email with 400 and writes nothing', async () => {
    const res = await callPost({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(inserted).toEqual([]);
  });

  it('rejects an out-of-set tier with 400', async () => {
    const res = await callPost({ email: 'a@b.com', tier: 'enterprise' });
    expect(res.status).toBe(400);
    expect(inserted).toEqual([]);
  });

  it('swallows honeypot hits: 202 ok, nothing written', async () => {
    const res = await callPost({ email: 'bot@spam.com', website: 'https://spam.example' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(inserted).toEqual([]);
  });

  it('echoes CORS for the marketing-site origin', async () => {
    const res = await callPost({ email: 'a@b.com' }, SITE_ORIGIN);
    expect(res.headers.get('access-control-allow-origin')).toBe(SITE_ORIGIN);
  });

  it('grants no CORS to an unknown origin', async () => {
    const res = await callPost({ email: 'a@b.com' }, 'https://evil.example');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('OPTIONS /api/waitlist (preflight)', () => {
  it('returns 204 with CORS for the site origin', async () => {
    const { OPTIONS } = await import('~/app/api/waitlist/route');
    const res = OPTIONS(
      new Request('http://localhost/api/waitlist', {
        method: 'OPTIONS',
        headers: { origin: SITE_ORIGIN },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(SITE_ORIGIN);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });
});
