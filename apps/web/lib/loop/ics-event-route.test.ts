import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GET /api/ics/event/:token (VIL-249 · M13) — the unauthenticated per-event calendar
 * file the SMS leg links to. The route is a thin shell over loadEventInvite, so what is
 * asserted here is the SHELL's contract: the calendar content type, a 404 (never a 500,
 * never a partial body) for every unresolvable token, and that no family-identifying
 * value rides the response headers.
 */

const loadEventInviteMock = vi.fn();
const dbMock = vi.fn();

vi.mock('~/lib/loop/ics-invite', () => ({
  loadEventInvite: (...args: unknown[]) => loadEventInviteMock(...args),
}));
vi.mock('~/lib/db', () => ({ db: () => dbMock() }));

const ICS = 'BEGIN:VCALENDAR\r\nMETHOD:PUBLISH\r\nEND:VCALENDAR\r\n';
const TOKEN = 'aaaaaaaa-2222-4222-8222-222222222222.signature';

async function callGet(token: string): Promise<Response> {
  const { GET } = await import('~/app/api/ics/event/[token]/route');
  return GET(new Request(`http://localhost/api/ics/event/${token}`), {
    params: Promise.resolve({ token }),
  });
}

describe('GET /api/ics/event/:token', () => {
  beforeEach(() => {
    vi.resetModules();
    loadEventInviteMock.mockReset();
    dbMock.mockReset();
    process.env.DATABASE_URL = 'postgres://test';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serves the calendar file with a text/calendar content type for a resolvable token', async () => {
    loadEventInviteMock.mockResolvedValue(ICS);

    const res = await callGet(TOKEN);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(await res.text()).toBe(ICS);
  });

  it('offers the file as a download rather than rendering it inline', async () => {
    loadEventInviteMock.mockResolvedValue(ICS);

    const res = await callGet(TOKEN);

    expect(res.headers.get('content-disposition')).toBe('attachment; filename="invite.ics"');
  });

  it('404s an unknown, forged or revoked token with an empty-of-detail body', async () => {
    loadEventInviteMock.mockResolvedValue(null);

    const res = await callGet('bogus.token');

    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Not found');
  });

  it('leaks no family-identifying value in the response headers', async () => {
    loadEventInviteMock.mockResolvedValue(ICS);

    const res = await callGet(TOKEN);

    const headers = [...res.headers.entries()].map(([name, value]) => `${name}: ${value}`).join('\n');
    expect(headers).not.toContain('aaaaaaaa-2222');
    expect(headers).not.toContain('signature');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('404s without touching the database when no DATABASE_URL is configured', async () => {
    process.env.DATABASE_URL = '';

    const res = await callGet(TOKEN);

    expect(res.status).toBe(404);
    expect(loadEventInviteMock).not.toHaveBeenCalled();
    expect(dbMock).not.toHaveBeenCalled();
  });
});
