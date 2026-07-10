import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Structural tripwire for the teen-redaction bypass (rule #1): mobile endpoints
// MUST go through the existing server loaders (which apply age-based redaction),
// never raw drizzle/@hale/db/schema access. This scans EVERY .ts file under
// app/api/mobile recursively — not just route.ts, and not just imports — so a
// helper file added tomorrow that reaches for the DB fails this test without
// anyone remembering to update it.
//
// A handful of routes are audited to legitimately hold a db handle (they reuse the
// exact web loaders/writers that own the query building): the password sign-in, the
// email sign-up (delegates to registerCredential + the signup side-effect
// dispatcher), the companion quick-log, the companion "mark done" (reuses the same
// writeEpisode path), the companion logs read (reuses the shared, teen-redacted
// readLogsPage), the three docs-vault routes (reuse the shared, teen-redacted
// documents lib for list / signed-url / soft-delete), and the connector connect-url
// route (resolves the family/user ids via the shared ~/lib/family helpers to sign
// the OAuth state — it reads NO child data, so there is nothing to redact). They may
// import ~/lib/db ONLY, and must contain NO query-building tokens themselves — the
// query building lives behind the shared lib, never inline in the route.
//
// (Lives under lib/ because the vitest `include` glob only picks up lib/** and
// components/**, not app/**.)

const MOBILE_API_DIR = fileURLToPath(new URL('../../app/api/mobile', import.meta.url));
// Trailing slash on a directory URL is inconsistent across platforms; strip it so
// the slice below yields a clean apps/web-relative path.
const WEB_ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

// The audited db-handle users, relative to apps/web. Each may import ~/lib/db
// (nothing else DB-related) and must build no queries of its own.
const DB_HANDLE_ALLOWLIST = new Set([
  'app/api/mobile/auth/password/route.ts',
  'app/api/mobile/auth/signup/route.ts',
  'app/api/mobile/companion/log/route.ts',
  'app/api/mobile/companion/done/route.ts',
  'app/api/mobile/companion/logs/route.ts',
  'app/api/mobile/docs/route.ts',
  'app/api/mobile/docs/[id]/route.ts',
  'app/api/mobile/docs/[id]/url/route.ts',
  'app/api/mobile/integrations/connect-url/route.ts',
  'app/api/mobile/rights/export/route.ts',
  'app/api/mobile/rights/delete/route.ts',
  'app/api/mobile/village/shares/route.ts',
  'app/api/mobile/village/shares/revoke/route.ts',
]);

// Direct DB-access tokens forbidden in every mobile file (the allowlist relaxes
// only '~/lib/db' for the two audited routes).
const FORBIDDEN_DB_TOKENS = ['@hale/db', 'drizzle-orm', '~/lib/db', 'schema.'];

// Query-building tokens forbidden even in the allowlisted routes: proof the query
// building stays behind the shared lib, never inline in the route.
const QUERY_TOKENS = [
  '.select(',
  '.insert(',
  '.update(',
  '.delete(',
  '.execute(',
  '.transaction(',
  'sql`',
];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...tsFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

function relToWeb(file: string): string {
  return file.slice(WEB_ROOT.length + 1);
}

describe('mobile API files never touch the database directly (rule #1)', () => {
  const files = tsFiles(MOBILE_API_DIR);

  it('finds at least one mobile file to guard (the scan is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s does not reach for the database directly', (file) => {
    const rel = relToWeb(file);
    const source = readFileSync(file, 'utf8');
    const allowed = DB_HANDLE_ALLOWLIST.has(rel);

    for (const token of FORBIDDEN_DB_TOKENS) {
      if (allowed && token === '~/lib/db') {
        continue;
      }
      expect(source, `${rel} must not contain ${token}`).not.toContain(token);
    }

    if (allowed) {
      for (const token of QUERY_TOKENS) {
        expect(source, `${rel} (audited db-handle route) must not build queries: ${token}`).not.toContain(
          token,
        );
      }
    }
  });
});
