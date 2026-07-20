/**
 * The Docs vault storage adapter — the ONLY place the private 'family-docs'
 * Supabase Storage bucket is touched. Talks to Supabase Storage over its REST API
 * with the SERVICE-ROLE key (rule #1: server-only, never shipped to the client),
 * so no @supabase/supabase-js dependency is pulled in — the project already speaks
 * to Supabase exclusively over raw HTTP/SQL.
 *
 * The bucket is PRIVATE. Bytes are never public: a viewer reads a document through
 * a short-TTL server-minted signed URL (SIGNED_URL_TTL_SECONDS). The storage path
 * is server-generated ({familyId}/{docId}) — a client filename never reaches the
 * key (no PII in the path).
 *
 * `fetch` is injected (default = global fetch) so the upload / sign / remove paths
 * are unit-testable without a live Supabase.
 */

export const DOCS_BUCKET = 'family-docs';

/** Signed-URL lifetime for viewing a document — short by construction (rule #1). */
export const SIGNED_URL_TTL_SECONDS = 600;

/** The env the adapter needs. Read once so a missing var fails loudly at the call
 * site, not as a silent undefined in a URL. */
interface StorageConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
}

function readConfig(): StorageConfig {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for the Docs vault');
  }
  return { supabaseUrl, serviceRoleKey };
}

export type FetchLike = typeof fetch;

/** The server-generated object key for a document. No client filename ever reaches
 * it (rule #1): {familyId}/{docId} only. */
export function storagePathFor(familyId: string, docId: string): string {
  return `${familyId}/${docId}`;
}

/**
 * Uploads a document's bytes to the private bucket at the given path. Uses the
 * service-role key server-side; the client never sees it. `upsert:false` (the
 * default) so a freshly-minted docId path can't silently overwrite an existing
 * object.
 */
export async function uploadDocument(
  path: string,
  body: Buffer,
  mime: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const { supabaseUrl, serviceRoleKey } = readConfig();
  const res = await fetchImpl(`${supabaseUrl}/storage/v1/object/${DOCS_BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      'content-type': mime,
      // Belt-and-suspenders: never clobber an existing object at this path.
      'x-upsert': 'false',
    },
    body: new Uint8Array(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Docs upload failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }
}

/**
 * Mints a short-TTL signed URL for viewing a document. The response's signedURL is
 * a path relative to the Storage origin, so it is joined back to supabaseUrl to
 * hand the client a full URL. Throws on any non-200 — a redacted document must
 * NEVER reach this function (the route gates first); if it somehow does, we fail
 * rather than mask (rule #1, CLAUDE.md #8).
 */
export async function signDocumentUrl(
  path: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const { supabaseUrl, serviceRoleKey } = readConfig();
  const res = await fetchImpl(`${supabaseUrl}/storage/v1/object/sign/${DOCS_BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Docs sign failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }
  const { signedURL } = (await res.json()) as { signedURL: string };
  return `${supabaseUrl}/storage/v1${signedURL}`;
}

/**
 * Reads an object's raw bytes back from the private bucket with the service-role key
 * (server-only, rule #1). Used by the Ask Hale attachments flow to fetch a stored
 * image/PDF and hand it to the model as a native content block — the bytes reach the
 * MODEL, never the client (the client reads via a signed URL). Throws on any non-200
 * rather than masking (CLAUDE.md #8).
 */
export async function downloadDocument(path: string, fetchImpl: FetchLike = fetch): Promise<Buffer> {
  const { supabaseUrl, serviceRoleKey } = readConfig();
  const res = await fetchImpl(`${supabaseUrl}/storage/v1/object/${DOCS_BUCKET}/${path}`, {
    method: 'GET',
    headers: { apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}` },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Docs download failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Removes a document's bytes from the private bucket. Called on soft-delete so a
 * removed doc's object doesn't linger (the DB row stays for the audit trail, rule
 * #6). A 404 (already gone) is not an error — the desired end state holds.
 */
export async function removeDocument(path: string, fetchImpl: FetchLike = fetch): Promise<void> {
  const { supabaseUrl, serviceRoleKey } = readConfig();
  const res = await fetchImpl(`${supabaseUrl}/storage/v1/object/${DOCS_BUCKET}/${path}`, {
    method: 'DELETE',
    headers: { apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}` },
  });
  if (!res.ok && res.status !== 404) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Docs remove failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }
}
