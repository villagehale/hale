import type { Database } from '@hale/db';
import { canaryFamilyIds } from '~/lib/channel/canary/config';
import { db } from '~/lib/db';

/**
 * Is this family the inbound canary?
 *
 * The answer is the configured probe number's blind index on parent_channels
 * (canaryFamilyIds). Callers never pass message text. A missing database — the
 * vitest placeholder included — is a named skip, not a guess that the family
 * is real: unit tests must not open a pool, and a capture must not throw.
 */

/** vitest.setup.ts installs this so imports don't throw. It is not a database. */
const VITEST_DATABASE_URL = 'postgres://test:test@localhost:5432/test';

const CACHE_MS = 60_000;

type Lookup = (familyId: string) => boolean | Promise<boolean>;

let lookupOverride: Lookup | null = null;
let cache: { ids: ReadonlySet<string>; at: number } | null = null;
let absentLogged = false;
let failureLogged = false;

export function setCanaryFamilyLookupForTests(lookup: Lookup | null): void {
  lookupOverride = lookup;
  cache = null;
}

export function resetCanaryFamilyCacheForTests(): void {
  cache = null;
  absentLogged = false;
  failureLogged = false;
  lookupOverride = null;
}

function configuredDatabase(): Database | null {
  const url = process.env.DATABASE_URL;
  if (!url || url === VITEST_DATABASE_URL) {
    if (!url && !absentLogged) {
      absentLogged = true;
      console.warn('analytics: DATABASE_URL is not set — canary events will not be tagged', {
        skipped: 'not_configured',
      });
    }
    return null;
  }
  return db();
}

function noteLookupFailed(err: unknown): void {
  if (failureLogged) return;
  failureLogged = true;
  console.warn('analytics: canary identity lookup failed — events will not be tagged', {
    err: err instanceof Error ? err.name : 'unknown',
  });
}

async function probeIds(database: Database, useCache: boolean): Promise<ReadonlySet<string>> {
  if (useCache && cache && Date.now() - cache.at < CACHE_MS) return cache.ids;
  const ids = new Set(await canaryFamilyIds(database));
  if (useCache) cache = { ids, at: Date.now() };
  return ids;
}

/**
 * True when `familyId` holds the configured probe number. Pass `database` from
 * a test or a caller that already has one. The no-argument form uses the
 * process database and a short cache, so a parent turn does not look the
 * household up on every event.
 */
export async function familyIsCanary(familyId: string, database?: Database): Promise<boolean> {
  if (!familyId) return false;
  if (lookupOverride) return lookupOverride(familyId);
  const source = database ?? configuredDatabase();
  if (!source) return false;
  try {
    const ids = await probeIds(source, database === undefined);
    return ids.has(familyId);
  } catch (err) {
    noteLookupFailed(err);
    return false;
  }
}
