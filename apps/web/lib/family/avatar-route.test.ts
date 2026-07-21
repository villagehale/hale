import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The child-avatar upload/delete route. We keep the REAL sniffer + size cap (so the
// byte-sniff rejection is exercised for real) and stub the auth, DB, ownership,
// rate-limit, and storage-backed mutation edges.
const authMock = vi.fn();
const authConfiguredMock = vi.fn();
const resolveFamilyMock = vi.fn();
const resolveUserMock = vi.fn();
const childBelongsMock = vi.fn();
const enforceRateLimitMock = vi.fn();
const setChildAvatarMock = vi.fn();
const removeChildAvatarMock = vi.fn();

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/auth-config', () => ({ authConfigured: () => authConfiguredMock() }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/family', () => ({
  resolveFamilyForUser: (...a: unknown[]) => resolveFamilyMock(...a),
  resolveUserIdForUser: (...a: unknown[]) => resolveUserMock(...a),
}));
vi.mock('~/lib/companion/log-write', () => ({
  childBelongsToFamily: (...a: unknown[]) => childBelongsMock(...a),
}));
vi.mock('~/lib/rate-limit/apply', () => ({
  enforceRateLimit: (...a: unknown[]) => enforceRateLimitMock(...a),
}));
vi.mock('~/lib/family/child-avatar', async (importActual) => {
  const actual = await importActual<typeof import('./child-avatar.js')>();
  return {
    ...actual,
    setChildAvatar: (...a: unknown[]) => setChildAvatarMock(...a),
    removeChildAvatar: (...a: unknown[]) => removeChildAvatarMock(...a),
  };
});

const CHILD_ID = '55555555-5555-4555-8555-555555555555';

function jpeg(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
}
function heic(): Buffer {
  const b = Buffer.alloc(16);
  b.write('ftyp', 4, 'ascii');
  b.write('heic', 8, 'ascii');
  return b;
}

function ctx(childId = CHILD_ID) {
  return { params: Promise.resolve({ childId }) };
}
function uploadReq(bytes: Buffer, type = 'image/jpeg'): Request {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(bytes)], 'photo', { type }));
  return new Request('http://t/api/family/children/x/avatar', { method: 'POST', body: form });
}

async function post(req: Request, context = ctx()): Promise<Response> {
  const { POST } = await import('~/app/api/family/children/[childId]/avatar/route');
  return POST(req, context);
}
async function del(context = ctx()): Promise<Response> {
  const { DELETE } = await import('~/app/api/family/children/[childId]/avatar/route');
  return DELETE(new Request('http://t', { method: 'DELETE' }), context);
}

beforeEach(() => {
  vi.clearAllMocks();
  authConfiguredMock.mockReturnValue(true);
  authMock.mockResolvedValue({ user: { id: 'ext-1' } });
  resolveFamilyMock.mockResolvedValue('fam-1');
  resolveUserMock.mockResolvedValue('user-1');
  childBelongsMock.mockResolvedValue(true);
  enforceRateLimitMock.mockResolvedValue(null);
  setChildAvatarMock.mockResolvedValue('https://signed/avatar');
  removeChildAvatarMock.mockResolvedValue('removed');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/family/children/:childId/avatar', () => {
  it('401s a signed-out caller and never uploads', async () => {
    authMock.mockResolvedValue(null);
    const res = await post(uploadReq(jpeg()));
    expect(res.status).toBe(401);
    expect(setChildAvatarMock).not.toHaveBeenCalled();
  });

  it('404s (never reveals) a child that is not the caller family and never uploads (rule #1)', async () => {
    childBelongsMock.mockResolvedValue(false);
    const res = await post(uploadReq(jpeg()));
    expect(res.status).toBe(404);
    expect(setChildAvatarMock).not.toHaveBeenCalled();
  });

  it('415s a HEIC upload by byte-sniff even though its extension/type could claim otherwise (no browser renders it)', async () => {
    // The client labels it image/jpeg; the raw bytes are HEIC. The sniff must win.
    const res = await post(uploadReq(heic(), 'image/jpeg'));
    expect(res.status).toBe(415);
    expect(setChildAvatarMock).not.toHaveBeenCalled();
  });

  it('413s an upload over the size cap before touching storage', async () => {
    const tooBig = Buffer.alloc(5 * 1024 * 1024 + 1);
    const res = await post(uploadReq(tooBig));
    expect(res.status).toBe(413);
    expect(setChildAvatarMock).not.toHaveBeenCalled();
  });

  it('checks the rate limit before storing, returning the limiter Response when over cap', async () => {
    enforceRateLimitMock.mockResolvedValue(new Response('slow down', { status: 429 }));
    const res = await post(uploadReq(jpeg()));
    expect(res.status).toBe(429);
    expect(setChildAvatarMock).not.toHaveBeenCalled();
  });

  it('stores a valid JPEG for the caller child and returns the signed avatar URL', async () => {
    const res = await post(uploadReq(jpeg()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ avatarUrl: 'https://signed/avatar' });
    expect(setChildAvatarMock).toHaveBeenCalledWith(
      expect.anything(),
      { familyId: 'fam-1', childId: CHILD_ID, actorUserId: 'user-1' },
      expect.any(Buffer),
      'image/jpeg',
    );
  });

  it('404s when the child vanished between the ownership check and the write (setChildAvatar → null)', async () => {
    setChildAvatarMock.mockResolvedValue(null);
    const res = await post(uploadReq(jpeg()));
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/family/children/:childId/avatar', () => {
  it('removes the photo for the caller child', async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'removed' });
    expect(removeChildAvatarMock).toHaveBeenCalledWith(expect.anything(), {
      familyId: 'fam-1',
      childId: CHILD_ID,
      actorUserId: 'user-1',
    });
  });

  it('404s a foreign child and never removes (rule #1)', async () => {
    childBelongsMock.mockResolvedValue(false);
    const res = await del();
    expect(res.status).toBe(404);
    expect(removeChildAvatarMock).not.toHaveBeenCalled();
  });
});
