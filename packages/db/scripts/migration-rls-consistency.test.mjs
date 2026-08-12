import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readJournal } from './migration-drift.mjs';

// Guards the gap found on 2026-08-11: EIGHT tables had shipped without RLS. The app
// connects as postgres (BYPASSRLS) so nothing broke, but Supabase's PostgREST Data API
// authorises through RLS — a table without it is one project-setting flip away from
// being readable by the anon role. For a product holding children's data that is rule
// #1, not a hardening nicety.
//
// A RATCHET, not a retro-fix: the eight are frozen below exactly as they are, because
// enabling RLS on someone else's table is a production change that belongs to whoever
// owns it. What this test buys is that the list can only ever get SHORTER — a NEW table
// without RLS fails, and fixing one of the eight without deleting its line fails too.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.resolve(scriptDir, '..', 'drizzle');

/** Tables created before the gap was found, still unprotected. Never add to this list. */
const KNOWN_UNPROTECTED = [
  'caregiver_invites',
  'civic_sessions',
  'civic_venues',
  'party_invites',
  'party_rsvps',
  'registration_sequences',
  'sms_intake_sessions',
  'teen_access_grants',
];

function createdTables(sql) {
  return [...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"([a-z_0-9]+)"/gi)].map((m) => m[1]);
}

function rlsEnabledTables(sql) {
  return [...sql.matchAll(/ALTER TABLE "([a-z_0-9]+)" ENABLE ROW LEVEL SECURITY/gi)].map(
    (m) => m[1],
  );
}

describe('migration ↔ RLS consistency', () => {
  it('every table a migration creates is RLS-enabled, bar the frozen legacy list', () => {
    const created = new Set();
    const protectedTables = new Set();

    for (const { tag } of readJournal(drizzleDir)) {
      const sql = fs.readFileSync(path.join(drizzleDir, `${tag}.sql`), 'utf8');
      for (const table of createdTables(sql)) created.add(table);
      for (const table of rlsEnabledTables(sql)) protectedTables.add(table);
    }

    const unprotected = [...created].filter((table) => !protectedTables.has(table)).sort();

    expect(unprotected).toEqual(KNOWN_UNPROTECTED);
  });
});
