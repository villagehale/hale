import { type Database, schema } from '@hale/db';
import type { SQL } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The 4 mobile Docs vault routes over the REAL docs lib + a fake tx db that
 * EVALUATES the lib's Drizzle WHERE (via eqConstraints, walking queryChunks) so
 * family scoping and the teen gate are actually exercised — not stipulated. The
 * routes call the storage lib without an injected fetch, so the Supabase Storage
 * HTTP is stubbed through a fake global fetch (rule #1: never a live bucket in a
 * unit test). @hale/db's createDb is poisoned so a route that builds its own db
 * fails loudly (rule #1). Load-bearing: the mime/size rejections prove byte-sniffing
 * + the size cap, and the teen-gate cases MUST fail if listDocuments /
 * documentVisibleToRequester drop their redaction.
 */

const authMock = vi.fn();
const currentFamilyIdMock = vi.fn();
const resolveUserIdMock = vi.fn();

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_FAMILY_ID = '99999999-9999-4999-8999-999999999999';
const UPLOADER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_PARENT_ID = '33333333-3333-4333-8333-333333333333';
const TEEN_CHILD_ID = '44444444-4444-4444-8444-444444444444';
const TODDLER_CHILD_ID = '55555555-5555-4555-8555-555555555555';
const TEEN_DOC_ID = '66666666-6666-4666-8666-666666666666';
const TODDLER_DOC_ID = '77777777-7777-4777-8777-777777777777';
const FOREIGN_DOC_ID = '88888888-8888-4888-8888-888888888888';
const NOW = new Date('2026-07-08T12:00:00.000Z');

const SUPABASE_URL = 'https://proj.supabase.co';

// Born 2013-01-08 → 162 completed months on NOW → teenager (>= 156mo boundary).
// Born 2025-01-08 → 18 completed months on NOW → toddler.
interface ChildRow {
  id: string;
  familyId: string;
  dateOfBirth: string;
}
interface DocRow {
  id: string;
  familyId: string;
  childId: string | null;
  uploadedBy: string;
  kind: string;
  title: string;
  storagePath: string;
  mime: string;
  sizeBytes: number;
  createdAt: Date;
  deletedAt: Date | null;
}

interface Capture {
  inserts: { table: unknown; row: Record<string, unknown> }[];
  updateValues: Record<string, unknown>[];
  fetches: { url: string; method: string }[];
}

let children: ChildRow[];
let docs: DocRow[];
let capture: Capture;

function eqConstraints(sql: SQL, out: Record<string, unknown> = {}): Record<string, unknown> {
  const chunks = (sql as unknown as { queryChunks?: unknown[] }).queryChunks ?? [];
  let lastCol: string | null = null;
  for (const chunk of chunks) {
    const c = chunk as {
      constructor?: { name?: string };
      name?: string;
      table?: unknown;
      value?: unknown;
    };
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

function matchingDocs(where: SQL): DocRow[] {
  const c = eqConstraints(where);
  return docs.filter(
    (row) =>
      (c.id === undefined || row.id === c.id) &&
      (c.family_id === undefined || row.familyId === c.family_id) &&
      // isNull(deleted_at) — the live-only guard the routes rely on.
      row.deletedAt === null,
  );
}

function matchingChildren(where: SQL): ChildRow[] {
  const c = eqConstraints(where);
  return children.filter(
    (row) =>
      (c.id === undefined || row.id === c.id) &&
      (c.family_id === undefined || row.familyId === c.family_id),
  );
}

// A minimal query builder: routes to children vs child_documents by the `.from`
// table, evaluates the real WHERE, and supports orderBy/limit terminals.
function selectBuilder() {
  let table: unknown;
  const chain = {
    from(t: unknown) {
      table = t;
      return chain;
    },
    where(where: SQL) {
      const run = () => {
        if (table === schema.children) {
          return matchingChildren(where).map((r) => ({ id: r.id, dateOfBirth: r.dateOfBirth }));
        }
        return matchingDocs(where).map((r) => ({
          id: r.id,
          childId: r.childId,
          authoredBy: r.uploadedBy,
          storagePath: r.storagePath,
          kind: r.kind,
          title: r.title,
          mime: r.mime,
          sizeBytes: r.sizeBytes,
          createdAt: r.createdAt,
        }));
      };
      // Awaitable directly (familyChildren) OR via a terminal (.orderBy for the
      // list, .limit for loadOwnedDocument). A real Promise is thenable without a
      // hand-rolled `then` property (which biome's noThenProperty forbids).
      return Object.assign(Promise.resolve(run()), {
        orderBy: async () => run(),
        limit: async () => run(),
      });
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

function updateBuilder() {
  return {
    set: (patch: Record<string, unknown>) => ({
      where: (where: SQL) => {
        const rows = matchingDocs(where);
        if (rows.length > 0) capture.updateValues.push(patch);
        return Promise.resolve(rows.map((r) => ({ id: r.id })));
      },
    }),
  };
}

function fakeDb(): Database {
  const handle = {
    select: () => selectBuilder(),
    insert: (table: unknown) => insertBuilder(table),
    update: () => updateBuilder(),
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(handle),
  };
  return handle as unknown as Database;
}

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => fakeDb() }));
vi.mock('~/lib/family', () => ({
  currentFamilyId: () => currentFamilyIdMock(),
  resolveUserIdForUser: (...a: unknown[]) => resolveUserIdMock(...a),
}));

vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('docs route must NOT construct its own db (rule #1)');
    },
  };
});

function fakeFetch(): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    capture.fetches.push({ url, method: (init?.method as string) ?? 'GET' });
    // Sign endpoint returns a signedURL; upload/remove just need ok.
    if (url.includes('/object/sign/')) {
      return new Response(JSON.stringify({ signedURL: '/object/sign/family-docs/x?token=t' }), {
        status: 200,
      });
    }
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;
}

function liveDoc(over: Partial<DocRow>): DocRow {
  return {
    id: TODDLER_DOC_ID,
    familyId: FAMILY_ID,
    childId: TODDLER_CHILD_ID,
    uploadedBy: UPLOADER_ID,
    kind: 'health',
    title: 'record',
    storagePath: `${FAMILY_ID}/${TODDLER_DOC_ID}`,
    mime: 'application/pdf',
    sizeBytes: 100,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    deletedAt: null,
    ...over,
  };
}

async function callGet(): Promise<Response> {
  const { GET } = await import('~/app/api/mobile/docs/route');
  return GET();
}

async function callPost(form: FormData): Promise<Response> {
  const { POST } = await import('~/app/api/mobile/docs/route');
  return POST(new Request('http://localhost/api/mobile/docs', { method: 'POST', body: form }));
}

async function callUrl(id: string): Promise<Response> {
  const { GET } = await import('~/app/api/mobile/docs/[id]/url/route');
  return GET(new Request(`http://localhost/api/mobile/docs/${id}/url`), {
    params: Promise.resolve({ id }),
  });
}

async function callDelete(id: string): Promise<Response> {
  const { DELETE } = await import('~/app/api/mobile/docs/[id]/route');
  return DELETE(new Request(`http://localhost/api/mobile/docs/${id}`, { method: 'DELETE' }), {
    params: Promise.resolve({ id }),
  });
}

function pdfFile(bytes: Buffer, declaredType: string, name = 'x'): File {
  return new File([new Uint8Array(bytes)], name, { type: declaredType });
}

const VALID_PDF = Buffer.from('%PDF-1.7\nhello world', 'ascii');

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  authMock.mockReset();
  currentFamilyIdMock.mockReset();
  resolveUserIdMock.mockReset();
  vi.stubEnv('DATABASE_URL', 'postgres://test');
  vi.stubEnv('SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
  vi.stubGlobal('fetch', fakeFetch());
  authMock.mockResolvedValue({ user: { id: 'ext-uploader' } });
  currentFamilyIdMock.mockResolvedValue(FAMILY_ID);
  resolveUserIdMock.mockResolvedValue(UPLOADER_ID);
  capture = { inserts: [], updateValues: [], fetches: [] };
  children = [
    { id: TEEN_CHILD_ID, familyId: FAMILY_ID, dateOfBirth: '2013-01-08' },
    { id: TODDLER_CHILD_ID, familyId: FAMILY_ID, dateOfBirth: '2025-01-08' },
  ];
  docs = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('auth guard — signed-out is 401 with no side effects', () => {
  beforeEach(() => authMock.mockResolvedValue(null));

  it('GET /docs → 401, no storage call, no audit write', async () => {
    const res = await callGet();
    expect(res.status).toBe(401);
    expect(capture.fetches).toEqual([]);
    expect(capture.inserts).toEqual([]);
  });

  it('POST /docs → 401, no upload, no db write', async () => {
    const form = new FormData();
    form.append('file', pdfFile(VALID_PDF, 'application/pdf'));
    form.append('kind', 'health');
    form.append('title', 'x');
    const res = await callPost(form);
    expect(res.status).toBe(401);
    expect(capture.fetches).toEqual([]);
    expect(capture.inserts).toEqual([]);
  });

  it('GET /docs/:id/url → 401, no URL minted, no audit write', async () => {
    const res = await callUrl(TODDLER_DOC_ID);
    expect(res.status).toBe(401);
    expect(capture.fetches).toEqual([]);
    expect(capture.inserts).toEqual([]);
  });

  it('DELETE /docs/:id → 401, no removal, no audit write', async () => {
    const res = await callDelete(TODDLER_DOC_ID);
    expect(res.status).toBe(401);
    expect(capture.fetches).toEqual([]);
    expect(capture.inserts).toEqual([]);
  });
});

describe('POST /docs — server-side validation (fail closed, rule #1)', () => {
  it('rejects a file DECLARED pdf whose BYTES are junk → 415 (proves byte-sniffing, not the Content-Type)', async () => {
    const form = new FormData();
    form.append('file', pdfFile(Buffer.from('not a real pdf at all', 'ascii'), 'application/pdf'));
    form.append('kind', 'health');
    form.append('title', 'spoofed');
    const res = await callPost(form);
    expect(res.status).toBe(415);
    expect(capture.fetches).toEqual([]);
    expect(capture.inserts).toEqual([]);
  });

  it('rejects a file whose decoded bytes exceed MAX_DOC_BYTES → 413', async () => {
    const { MAX_DOC_BYTES } = await import('~/lib/docs/documents');
    const big = Buffer.concat([VALID_PDF, Buffer.alloc(MAX_DOC_BYTES + 1)]);
    const form = new FormData();
    form.append('file', pdfFile(big, 'application/pdf'));
    form.append('kind', 'health');
    form.append('title', 'huge');
    const res = await callPost(form);
    expect(res.status).toBe(413);
    expect(capture.fetches).toEqual([]);
    expect(capture.inserts).toEqual([]);
  });

  it('accepts valid PDF bytes → 201, uploads, and writes ONE audit row (kind only, no title)', async () => {
    const form = new FormData();
    form.append('file', pdfFile(VALID_PDF, 'application/pdf'));
    form.append('kind', 'health');
    form.append('title', 'Immunization record');
    const res = await callPost(form);

    expect(res.status).toBe(201);
    const body = (await res.json()) as { status: string; id: string };
    expect(body.status).toBe('uploaded');
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);

    const uploads = capture.fetches.filter((f) => f.method === 'POST');
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.url).toBe(
      `${SUPABASE_URL}/storage/v1/object/family-docs/${FAMILY_ID}/${body.id}`,
    );

    const auditRows = capture.inserts.filter((i) => i.table === schema.auditLog);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.row).toMatchObject({
      familyId: FAMILY_ID,
      actor: UPLOADER_ID,
      actionTaken: 'document_uploaded_health',
      targetTable: 'child_documents',
      targetId: body.id,
    });
    // Rule #1/#6: the audit row never carries the (possibly-PII) title.
    expect(JSON.stringify(auditRows[0]?.row)).not.toContain('Immunization record');
  });
});

describe('GET /docs — family scope + teen gate (rule #1)', () => {
  beforeEach(() => {
    docs = [
      liveDoc({ id: TEEN_DOC_ID, childId: TEEN_CHILD_ID, uploadedBy: UPLOADER_ID }),
      liveDoc({ id: TODDLER_DOC_ID, childId: TODDLER_CHILD_ID, uploadedBy: UPLOADER_ID }),
      // A doc in ANOTHER family — must never appear regardless of the teen gate.
      liveDoc({ id: FOREIGN_DOC_ID, familyId: OTHER_FAMILY_ID, childId: null }),
    ];
  });

  it("drops the teen child's doc for a NON-uploader parent, keeps the toddler's + hides foreign", async () => {
    resolveUserIdMock.mockResolvedValue(OTHER_PARENT_ID);
    const res = await callGet();
    expect(res.status).toBe(200);
    const { documents } = (await res.json()) as { documents: { id: string }[] };
    expect(documents.map((d) => d.id)).toEqual([TODDLER_DOC_ID]);
  });

  it('keeps the teen doc for its uploader', async () => {
    resolveUserIdMock.mockResolvedValue(UPLOADER_ID);
    const res = await callGet();
    const { documents } = (await res.json()) as { documents: { id: string }[] };
    expect(documents.map((d) => d.id).sort()).toEqual([TEEN_DOC_ID, TODDLER_DOC_ID].sort());
  });
});

describe('GET /docs/:id/url — teen gate (rule #1)', () => {
  beforeEach(() => {
    docs = [liveDoc({ id: TEEN_DOC_ID, childId: TEEN_CHILD_ID, uploadedBy: UPLOADER_ID })];
  });

  it('404s a teen doc for a non-uploader — never mints a URL, never writes a view audit row', async () => {
    resolveUserIdMock.mockResolvedValue(OTHER_PARENT_ID);
    const res = await callUrl(TEEN_DOC_ID);
    expect(res.status).toBe(404);
    expect(capture.fetches.filter((f) => f.url.includes('/object/sign/'))).toEqual([]);
    expect(capture.inserts.filter((i) => i.table === schema.auditLog)).toEqual([]);
  });

  it('200s a visible doc for its uploader → { url } + ONE view-url audit row', async () => {
    resolveUserIdMock.mockResolvedValue(UPLOADER_ID);
    const res = await callUrl(TEEN_DOC_ID);
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url).toBe(`${SUPABASE_URL}/storage/v1/object/sign/family-docs/x?token=t`);

    const auditRows = capture.inserts.filter((i) => i.table === schema.auditLog);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.row).toMatchObject({
      familyId: FAMILY_ID,
      actor: UPLOADER_ID,
      actionTaken: 'document_view_url_health',
      targetTable: 'child_documents',
      targetId: TEEN_DOC_ID,
    });
  });
});

describe('DELETE /docs/:id — family-scoped soft-delete (rules #1, #6, #9)', () => {
  it('soft-deletes a matched live doc → 200, stamps deletedAt (not hard delete), removes bytes, ONE audit row', async () => {
    docs = [liveDoc({ id: TODDLER_DOC_ID, kind: 'insurance' })];
    const res = await callDelete(TODDLER_DOC_ID);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'deleted' });

    expect(capture.updateValues).toHaveLength(1);
    expect(capture.updateValues[0]?.deletedAt).toEqual(NOW);

    const auditRows = capture.inserts.filter((i) => i.table === schema.auditLog);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.row).toMatchObject({
      actor: UPLOADER_ID,
      actionTaken: 'document_deleted_insurance',
      targetTable: 'child_documents',
      targetId: TODDLER_DOC_ID,
    });

    const removes = capture.fetches.filter((f) => f.method === 'DELETE');
    expect(removes).toHaveLength(1);
    expect(removes[0]?.url).toBe(
      `${SUPABASE_URL}/storage/v1/object/family-docs/${FAMILY_ID}/${TODDLER_DOC_ID}`,
    );
  });

  it("404s another family's doc id — no update, no audit, no removal", async () => {
    // Only the real WHERE (id AND family_id) misses it; a bare-id WHERE would match.
    docs = [liveDoc({ id: TODDLER_DOC_ID, familyId: OTHER_FAMILY_ID })];
    const res = await callDelete(TODDLER_DOC_ID);

    expect(res.status).toBe(404);
    expect(capture.updateValues).toEqual([]);
    expect(capture.inserts).toEqual([]);
    expect(capture.fetches).toEqual([]);
  });

  it('404s a teen doc for a non-uploader — no update, no audit, no removal (rule #1)', async () => {
    // The teen set derives LIVE from DOB: an id listed to both parents while the
    // child was 12 must not remain a deletable (existence-confirming) handle at 13.
    docs = [liveDoc({ id: TEEN_DOC_ID, childId: TEEN_CHILD_ID, uploadedBy: UPLOADER_ID })];
    resolveUserIdMock.mockResolvedValue(OTHER_PARENT_ID);
    const res = await callDelete(TEEN_DOC_ID);

    expect(res.status).toBe(404);
    expect(capture.updateValues).toEqual([]);
    expect(capture.inserts).toEqual([]);
    expect(capture.fetches).toEqual([]);
  });

  it('lets the uploader delete their own teen-child doc (uploader exemption)', async () => {
    docs = [liveDoc({ id: TEEN_DOC_ID, childId: TEEN_CHILD_ID, uploadedBy: UPLOADER_ID })];
    resolveUserIdMock.mockResolvedValue(UPLOADER_ID);
    const res = await callDelete(TEEN_DOC_ID);

    expect(res.status).toBe(200);
    expect(capture.updateValues).toHaveLength(1);
    expect(capture.updateValues[0]?.deletedAt).toEqual(NOW);
  });
});
