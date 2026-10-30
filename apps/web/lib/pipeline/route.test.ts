import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signInboundBody } from '~/lib/pipeline/verify-secret';

/**
 * The inbound-webhook AUTHENTICATION contract: a POST to /api/events/ingest
 * without a valid HMAC of the raw body keyed by INBOUND_WEBHOOK_SECRET gets 401
 * and the pipeline does NOTHING — no DB handle resolved, no classify/draft/review,
 * no spend (rule #4: only an authenticated caller may inject a billable,
 * data-writing event). A valid signature reaches ingestEvent exactly once. The
 * pipeline itself is stubbed here (covered by ingest.test.ts); this asserts the
 * gate and the family-binding.
 */

const ingestEventMock = vi.fn();
const dbMock = vi.fn();
const pipelineClientMock = vi.fn();
const familySelectMock = vi.fn();

vi.mock('~/lib/db', () => ({ db: () => dbMock() }));
vi.mock('~/lib/pipeline/client', () => ({ pipelineClient: () => pipelineClientMock() }));
vi.mock('~/lib/pipeline/ingest', () => ({
  ingestEvent: (...a: unknown[]) => ingestEventMock(...a),
}));

const SECRET = 'inbound-secret-xyz';
const FAMILY_ID = '11111111-1111-4111-8111-111111111111';

function body(familyRef = FAMILY_ID): string {
  return JSON.stringify({ familyRef, kind: 'email', subject: 'hi', body: 'please reply' });
}

function request(raw: string, signature?: string): Request {
  return new Request('http://localhost/api/events/ingest', {
    method: 'POST',
    headers: signature ? { 'x-hale-signature': signature } : {},
    body: raw,
  });
}

async function callPost(req: Request) {
  const { POST } = await import('~/app/api/events/ingest/route');
  return POST(req);
}

describe('POST /api/events/ingest — inbound secret gate', () => {
  beforeEach(() => {
    vi.resetModules();
    ingestEventMock.mockReset().mockResolvedValue({ status: 'surfaced_only', eventId: 'e1' });
    pipelineClientMock.mockReset().mockReturnValue({});
    // A db() whose families select resolves the bound family.
    familySelectMock.mockReset().mockReturnValue({
      from: () => ({ where: () => ({ limit: async () => [{ id: FAMILY_ID }] }) }),
    });
    dbMock.mockReset().mockReturnValue({ select: familySelectMock });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 401 and does NO work when INBOUND_WEBHOOK_SECRET is unset (fail closed)', async () => {
    vi.stubEnv('INBOUND_WEBHOOK_SECRET', '');
    const raw = body();

    const res = await callPost(request(raw, signInboundBody(SECRET, raw)));

    expect(res.status).toBe(401);
    expect(dbMock).not.toHaveBeenCalled();
    expect(ingestEventMock).not.toHaveBeenCalled();
  });

  it('returns 401 and does NO work when the signature header is missing', async () => {
    vi.stubEnv('INBOUND_WEBHOOK_SECRET', SECRET);
    const raw = body();

    const res = await callPost(request(raw));

    expect(res.status).toBe(401);
    expect(ingestEventMock).not.toHaveBeenCalled();
  });

  it('returns 401 and does NO work when the signature does not match the body', async () => {
    vi.stubEnv('INBOUND_WEBHOOK_SECRET', SECRET);
    const raw = body();

    // Sign a DIFFERENT body — a forged/tampered payload.
    const res = await callPost(request(raw, signInboundBody(SECRET, body('22222222-2222-4222-8222-222222222222'))));

    expect(res.status).toBe(401);
    expect(ingestEventMock).not.toHaveBeenCalled();
  });

  it('runs the pipeline exactly once when the signature is valid', async () => {
    vi.stubEnv('INBOUND_WEBHOOK_SECRET', SECRET);
    const raw = body();

    const res = await callPost(request(raw, signInboundBody(SECRET, raw)));

    expect(res.status).toBe(200);
    expect(ingestEventMock).toHaveBeenCalledTimes(1);
    const arg = ingestEventMock.mock.calls[0]?.[0];
    expect(arg).toMatchObject({ familyId: FAMILY_ID, source: 'email', subject: 'hi' });
  });

  it('acknowledges but drops (no pipeline) when familyRef binds to no family', async () => {
    vi.stubEnv('INBOUND_WEBHOOK_SECRET', SECRET);
    familySelectMock.mockReturnValue({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    });
    const raw = body();

    const res = await callPost(request(raw, signInboundBody(SECRET, raw)));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'unbound' });
    expect(ingestEventMock).not.toHaveBeenCalled();
  });
});
