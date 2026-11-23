import { createHmac, hkdfSync } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { db } from '../db.js';

/**
 * Is this family the inbound canary?
 *
 * The worker cannot import apps/web. The decision is still the configured
 * probe number's blind index — the same HMAC apps/web/lib/crypto/blind-index.ts
 * computes for `+14375550100` under info `hale-phone-blind-index-v1`. Message
 * text is not an argument. The vitest placeholder URL is not a database.
 */

const CANARY_PHONE_E164 = '+14375550100';
const BLIND_INDEX_INFO = 'hale-phone-blind-index-v1';
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

/** Same derivation as `phoneBlindIndex` in apps/web. Exported so the fixture test can pin it. */
export function canaryPhoneBlindIndex(e164: string = CANARY_PHONE_E164): string {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('APP_ENCRYPTION_KEY is not set — cannot identify the canary household');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('APP_ENCRYPTION_KEY must decode to 32 bytes');
  }
  const derived = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), BLIND_INDEX_INFO, 32));
  return createHmac('sha256', derived).update(e164).digest('hex');
}

export async function canaryFamilyIds(database: Database): Promise<string[]> {
  const rows = await database
    .select({ familyId: schema.parentChannels.familyId })
    .from(schema.parentChannels)
    .where(eq(schema.parentChannels.phoneE164Hash, canaryPhoneBlindIndex()));
  return [...new Set(rows.map((row) => row.familyId))];
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

export async function familyIsCanary(familyId: string, database?: Database): Promise<boolean> {
  if (!familyId) return false;
  if (lookupOverride) return lookupOverride(familyId);
  const source = database ?? configuredDatabase();
  if (!source) return false;
  try {
    const useCache = database === undefined;
    if (useCache && cache && Date.now() - cache.at < CACHE_MS) return cache.ids.has(familyId);
    const ids = new Set(await canaryFamilyIds(source));
    if (useCache) cache = { ids, at: Date.now() };
    return ids.has(familyId);
  } catch (err) {
    noteLookupFailed(err);
    return false;
  }
}
