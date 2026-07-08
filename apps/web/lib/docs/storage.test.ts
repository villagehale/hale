import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DOCS_BUCKET,
  removeDocument,
  SIGNED_URL_TTL_SECONDS,
  signDocumentUrl,
  storagePathFor,
  uploadDocument,
} from './storage.js';

/**
 * The Docs vault storage adapter — pure over an injected fetch (no live Supabase,
 * no db). Every path asserts the EXACT Storage REST call the private bucket needs
 * and that a non-ok response THROWS rather than masking (rule #8). The service-role
 * key value is never printed — only the Bearer-prefix shape is asserted.
 */

const SUPABASE_URL = 'https://proj.supabase.co';
const SERVICE_KEY = 'service-role-secret-key';
const PATH = '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222';

interface Captured {
  url: string;
  init: RequestInit;
}

function okFetch(body: unknown, capture?: Captured[]): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    capture?.push({ url, init });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

function statusFetch(status: number): typeof fetch {
  return (async () => new Response('boom', { status })) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('storagePathFor', () => {
  it('is exactly {familyId}/{docId} — no client filename in the key', () => {
    expect(storagePathFor('fam-1', 'doc-9')).toBe('fam-1/doc-9');
  });
});

describe('uploadDocument', () => {
  it('POSTs the bytes to the bucket object path with Bearer auth + x-upsert:false', async () => {
    const calls: Captured[] = [];
    const body = Buffer.from('%PDF-1.4 hello');

    await uploadDocument(PATH, body, 'application/pdf', okFetch({}, calls));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${SUPABASE_URL}/storage/v1/object/${DOCS_BUCKET}/${PATH}`);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${SERVICE_KEY}`);
    expect(headers['content-type']).toBe('application/pdf');
    expect(headers['x-upsert']).toBe('false');
    expect(calls[0]?.init.method).toBe('POST');
    expect(Buffer.from(calls[0]?.init.body as Uint8Array)).toEqual(body);
  });

  it('THROWS on a non-ok response — never masks a failed upload (rule #8)', async () => {
    await expect(
      uploadDocument(PATH, Buffer.from('x'), 'application/pdf', statusFetch(500)),
    ).rejects.toThrow(/Docs upload failed \(500\)/);
  });
});

describe('signDocumentUrl', () => {
  it('POSTs to the sign endpoint with expiresIn=600 and returns the joined full URL', async () => {
    const calls: Captured[] = [];
    const signedURL = '/object/sign/family-docs/path?token=abc';

    const url = await signDocumentUrl(PATH, okFetch({ signedURL }, calls));

    expect(calls[0]?.url).toBe(`${SUPABASE_URL}/storage/v1/object/sign/${DOCS_BUCKET}/${PATH}`);
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ expiresIn: SIGNED_URL_TTL_SECONDS });
    expect(SIGNED_URL_TTL_SECONDS).toBe(600);
    expect(url).toBe(`${SUPABASE_URL}/storage/v1${signedURL}`);
  });

  it('THROWS on a non-ok response — a redacted doc must never get a URL (rule #8)', async () => {
    await expect(signDocumentUrl(PATH, statusFetch(403))).rejects.toThrow(/Docs sign failed \(403\)/);
  });
});

describe('removeDocument', () => {
  it('DELETEs the object path with Bearer auth', async () => {
    const calls: Captured[] = [];

    await removeDocument(PATH, okFetch({}, calls));

    expect(calls[0]?.url).toBe(`${SUPABASE_URL}/storage/v1/object/${DOCS_BUCKET}/${PATH}`);
    expect(calls[0]?.init.method).toBe('DELETE');
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${SERVICE_KEY}`,
    );
  });

  it('treats 404 (already gone) as success — no throw', async () => {
    await expect(removeDocument(PATH, statusFetch(404))).resolves.toBeUndefined();
  });

  it('THROWS on a 500', async () => {
    await expect(removeDocument(PATH, statusFetch(500))).rejects.toThrow(/Docs remove failed \(500\)/);
  });
});
