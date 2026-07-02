import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Structural tripwire for the teen-redaction bypass (rule #1): mobile READ
// endpoints MUST go through the existing server loaders (which apply age-based
// redaction), never raw drizzle/@hale/db/schema access. This scans EVERY route.ts
// under app/api/mobile dynamically, so a route added later that imports @hale/db
// or references `schema.` fails this test without anyone remembering to update it.
// (Lives under lib/ because the vitest `include` glob only picks up lib/** and
// components/**, not app/**.)

const MOBILE_API_DIR = fileURLToPath(new URL('../../app/api/mobile', import.meta.url));

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...routeFiles(full));
    } else if (entry.name === 'route.ts') {
      out.push(full);
    }
  }
  return out;
}

describe('mobile API routes never touch the database directly (rule #1)', () => {
  const files = routeFiles(MOBILE_API_DIR);

  it('finds at least one mobile route to guard (the scan is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s imports neither @hale/db nor references schema.', (file) => {
    const source = readFileSync(file, 'utf8');
    expect(source).not.toContain('@hale/db');
    expect(source).not.toContain('schema.');
  });
});
