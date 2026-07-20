import { type Database, schema } from '@hale/db';
import type { SQL } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two /api/coach/attachments routes over the REAL attachments lib + a fake db.
 * The upload route stores via the shared Docs storage adapter, so the Supabase
 * Storage HTTP is stubbed through a fake global fetch (rule #1: never a live bucket
 * in a unit test). @hale/db's createDb is poisoned so a route that builds its own db
 * fails loudly. Load-bearing: the mime/size/count rejections prove byte-sniffing +
 * the caps, the storage path proves the chat/{familyId}/{id} prefix (no PII, no new
 * bucket), the audit row proves rule #6 without the originalName (rule #1), and the
 * read case proves family-scoped 404.
 */

const authMock = vi.fn();
const familyMock = vi.fn();
const userMock = vi.fn();
const rateLimitMock = vi.fn();

const FAMILY = '11111111-1111-4111-8111-111111111111';
const OTHER_FAMILY = '99999999-9999-4999-8999-999999999999';
const UPLOADER = '22222222-2222-4222-8222-222222222222';
const ATT = '66666666-6666-4666-8666-666666666666';
const FOREIGN = '88888888-8888-4888-8888-888888888888';

const SUPABASE_URL = 'https://proj.supabase.co';

interface AttRow {
  id: string;
  familyId: string;
  storagePath: string;
  mime: string;
}
interface Capture {
  inserts: { table: unknown; row: Record<string, unknown> }[];
  fetches: { url: string; method: string }[];
}

let attachments: AttRow[];
let capture: Capture;

function eqConstraints(sql: SQL, out: Record<string, unknown> = {}): Record<string, unknown> {
  const chunks = (sql as unknown as { queryChunks?: unknown[] }).queryChunks ?? [];
  let lastCol: string | null = null;
  for (const chunk of chunks) {
    const c = chunk as { constructor?: { name?: string }; name?: string; table?: unknown; value?: unknown };
    if (c?.constructor?.name === 'SQL') {
      eqConstraints(chunk as SQL, out);
      lastCol = null;
      continue;
    }
    if (typeof c?.name === 'string' && c.table) {
      lastCol = c.name;
      continue;
    }
    if (c?.constructor?.name === 'Param' && lastCol) {
      out[lastCol] = c.value;
      lastCol = null;
    }
  }
  return out;
}

function matching(where: SQL): AttRow[] {
  const c = eqConstraints(where);
  return attachments.filter(
    (row) =>
      (c.id === undefined || row.id === c.id) &&
      (c.family_id === undefined || row.familyId === c.family_id),
  );
}

function selectBuilder() {
  const chain = {
    from: () => chain,
    where: (where: SQL) => {
      const run = () =>
        matching(where).map((r) => ({ id: r.id, storagePath: r.storagePath, mime: r.mime }));
      return Object.assign(Promise.resolve(run()), { limit: async () => run() });
    },
  };
  return chain;
}

function insertBuilder(table: unknown) {
  return {
    values: async (row: Record<string, unknown>) => {
      capture.inserts.push({ table, row });
    },
  };
}

function fakeDb(): Database {
  const handle = {
    select: () => selectBuilder(),
    insert: (table: unknown) => insertBuilder(table),
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(handle),
  };
  return handle as unknown as Database;
}

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/auth-config', () => ({ authConfigured: () => true }));
vi.mock('~/lib/db', () => ({ db: () => fakeDb() }));
vi.mock('~/lib/family', () => ({
  resolveFamilyForUser: (...a: unknown[]) => familyMock(...a),
  resolveUserIdForUser: (...a: unknown[]) => userMock(...a),
}));
vi.mock('~/lib/rate-limit/apply', () => ({
  enforceRateLimit: (...a: unknown[]) => rateLimitMock(...a),
}));
vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('attachments route must NOT construct its own db (rule #1)');
    },
  };
});

function fakeFetch(): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    capture.fetches.push({ url, method: (init?.method as string) ?? 'GET' });
    if (url.includes('/object/sign/')) {
      return new Response(JSON.stringify({ signedURL: '/object/sign/family-docs/x?token=t' }), {
        status: 200,
      });
    }
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;
}

function file(bytes: Buffer, declaredType: string, name = 'photo'): File {
  return new File([new Uint8Array(bytes)], name, { type: declaredType });
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

async function callUpload(files: File[]): Promise<Response> {
  const { POST } = await import('~/app/api/coach/attachments/route');
  const form = new FormData();
  for (const f of files) form.append('files', f);
  return POST(new Request('http://localhost/api/coach/attachments', { method: 'POST', body: form }));
}

async function callRead(id: string): Promise<Response> {
  const { GET } = await import('~/app/api/coach/attachments/[id]/route');
  return GET(new Request(`http://localhost/api/coach/attachments/${id}`), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.resetModules();
  authMock.mockReset();
  familyMock.mockReset();
  userMock.mockReset();
  rateLimitMock.mockReset();
  // Default: under the cap (proceed). The rate-limit tests override this.
  rateLimitMock.mockResolvedValue(null);
  vi.stubEnv('SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
  vi.stubGlobal('fetch', fakeFetch());
  authMock.mockResolvedValue({ user: { id: 'ext-uploader' } });
  familyMock.mockResolvedValue(FAMILY);
  userMock.mockResolvedValue(UPLOADER);
  capture = { inserts: [], fetches: [] };
  attachments = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('POST /api/coach/attachments — auth', () => {
  it('signed-out → 401, no storage, no db write', async () => {
    authMock.mockResolvedValue(null);
    const res = await callUpload([file(JPEG, 'image/jpeg')]);
    expect(res.status).toBe(401);
    expect(capture.fetches).toEqual([]);
    expect(capture.inserts).toEqual([]);
  });
});

describe('POST /api/coach/attachments — rate limit (cost/abuse guard)', () => {
  it('over the per-user cap → 429, no storage write, no db insert (enforced before storing)', async () => {
    rateLimitMock.mockResolvedValue(
      NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '30' } }),
    );
    const res = await callUpload([file(JPEG, 'image/jpeg')]);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(capture.fetches).toEqual([]);
    expect(capture.inserts).toEqual([]);
    // The cap is keyed on the resolved uploader (per-user), like /api/coach.
    expect(rateLimitMock).toHaveBeenCalledWith('coach', UPLOADER);
  });
});

describe('POST /api/coach/attachments — validation (fail closed, rule #1)', () => {
  it('rejects a file DECLARED jpeg whose BYTES are junk → 415 (proves byte-sniffing)', async () => {
    const res = await callUpload([file(Buffer.from('not an image', 'ascii'), 'image/jpeg')]);
    expect(res.status).toBe(415);
    expect(capture.fetches).toEqual([]);
    expect(capture.inserts).toEqual([]);
  });

  it('rejects a ZIP (outside the allowlist) → 415', async () => {
    const res = await callUpload([file(ZIP, 'application/zip', 'a.zip')]);
    expect(res.status).toBe(415);
  });

  it('rejects a file over MAX_ATTACHMENT_BYTES → 413', async () => {
    const { MAX_ATTACHMENT_BYTES } = await import('~/lib/coach/attachments');
    const big = Buffer.concat([JPEG, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)]);
    const res = await callUpload([file(big, 'image/jpeg')]);
    expect(res.status).toBe(413);
    expect(capture.inserts).toEqual([]);
  });

  it('rejects more than 5 files → 413, before storing any', async () => {
    const six = Array.from({ length: 6 }, () => file(JPEG, 'image/jpeg'));
    const res = await callUpload(six);
    expect(res.status).toBe(413);
    expect(capture.fetches).toEqual([]);
    expect(capture.inserts).toEqual([]);
  });

  it('rejects a batch where ONE file is bad — no partial store (all-or-nothing)', async () => {
    const res = await callUpload([file(JPEG, 'image/jpeg'), file(ZIP, 'application/zip')]);
    expect(res.status).toBe(415);
    expect(capture.fetches).toEqual([]);
    expect(capture.inserts).toEqual([]);
  });
});

describe('POST /api/coach/attachments — happy path', () => {
  it('stores a valid JPEG → 201 [{id,name,sizeBytes,mime}], chat/{family}/{id} path, ONE audit row (no originalName)', async () => {
    const res = await callUpload([file(JPEG, 'image/jpeg', 'rash.jpg')]);

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string; sizeBytes: number; mime: string }[];
    expect(body).toHaveLength(1);
    expect(body[0]?.name).toBe('rash.jpg');
    expect(body[0]?.mime).toBe('image/jpeg');
    expect(body[0]?.sizeBytes).toBe(JPEG.byteLength);
    expect(body[0]?.id).toMatch(/^[0-9a-f-]{36}$/);

    const uploads = capture.fetches.filter((f) => f.method === 'POST');
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.url).toBe(
      `${SUPABASE_URL}/storage/v1/object/family-docs/chat/${FAMILY}/${body[0]?.id}`,
    );

    const audits = capture.inserts.filter((i) => i.table === schema.auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.row).toMatchObject({
      familyId: FAMILY,
      actor: UPLOADER,
      actionTaken: 'chat_attachment_uploaded',
      targetTable: 'chat_attachments',
      targetId: body[0]?.id,
    });
    // Rule #1: the audit row never carries the client filename.
    expect(JSON.stringify(audits[0]?.row)).not.toContain('rash.jpg');
  });
});

describe('GET /api/coach/attachments/:id — family-scoped signed URL', () => {
  it('200s a signed URL for the family\'s own attachment + writes ONE view audit row', async () => {
    attachments = [{ id: ATT, familyId: FAMILY, storagePath: `chat/${FAMILY}/${ATT}`, mime: 'image/jpeg' }];
    const res = await callRead(ATT);
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url).toBe(`${SUPABASE_URL}/storage/v1/object/sign/family-docs/x?token=t`);

    const audits = capture.inserts.filter((i) => i.table === schema.auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.row).toMatchObject({
      familyId: FAMILY,
      actor: UPLOADER,
      actionTaken: 'chat_attachment_view_url',
      targetTable: 'chat_attachments',
      targetId: ATT,
    });
  });

  it("404s another family's attachment id — no URL minted, no audit (rule #1)", async () => {
    // Only the real WHERE (id AND family_id) misses it; a bare-id WHERE would match.
    attachments = [{ id: FOREIGN, familyId: OTHER_FAMILY, storagePath: `chat/${OTHER_FAMILY}/${FOREIGN}`, mime: 'image/jpeg' }];
    const res = await callRead(FOREIGN);
    expect(res.status).toBe(404);
    expect(capture.fetches.filter((f) => f.url.includes('/object/sign/'))).toEqual([]);
    expect(capture.inserts).toEqual([]);
  });
});
