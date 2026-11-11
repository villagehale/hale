import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { signupProviderHost } from '../consent';
import { decryptWithDek, encryptWithDek } from './envelope';
import { providerCredentialsEnabled } from './flag';
import { type CredentialKms, envCredentialKms, newFamilyDek } from './kms';
import { parseTotpSeed, totpCode } from './totp';

export const CREDENTIAL_RETENTION_MS = 45 * 24 * 60 * 60_000;

export interface SavedProviderCredentials {
  username: string;
  password: string;
  totp: string | null;
}

async function liveDek(
  database: Database,
  familyId: string,
  kms: CredentialKms,
): Promise<{ dek: Buffer; version: number; masterKeyVersion: number }> {
  const keys = schema.familyProviderDataKeys;
  const [row] = await database
    .select()
    .from(keys)
    .where(eq(keys.familyId, familyId))
    .orderBy(sql`${keys.keyVersion} desc`)
    .limit(1);
  if (row) {
    return {
      dek: kms.unwrap(row.wrappedDek, row.masterKeyVersion),
      version: row.keyVersion,
      masterKeyVersion: row.masterKeyVersion,
    };
  }
  const dek = newFamilyDek();
  const version = 1;
  await database.insert(keys).values({
    familyId,
    keyVersion: version,
    wrappedDek: kms.wrap(dek),
    masterKeyVersion: kms.masterKeyVersion,
  });
  return { dek, version, masterKeyVersion: kms.masterKeyVersion };
}

/** Encrypt and store. A successful save clears stale. Off unless the credentials flag is on. */
export async function saveProviderCredentials(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    providerHost: string;
    username: string;
    password: string;
    totpSeed?: string | null;
    now: Date;
  },
  kms: CredentialKms = envCredentialKms(),
): Promise<{ ok: true } | { ok: false; reason: 'flag_off' | 'totp' }> {
  if (!providerCredentialsEnabled()) return { ok: false, reason: 'flag_off' };
  const host = signupProviderHost(input.providerHost);
  const totpSeed = input.totpSeed?.trim() ? parseTotpSeed(input.totpSeed) : null;
  if (input.totpSeed?.trim() && !totpSeed) return { ok: false, reason: 'totp' };
  const { dek, version, masterKeyVersion } = await liveDek(database, input.familyId, kms);
  const usernameCiphertext = encryptWithDek(dek, input.username);
  const passwordCiphertext = encryptWithDek(dek, input.password);
  const totpSeedCiphertext = totpSeed ? encryptWithDek(dek, totpSeed) : null;
  const creds = schema.providerSignupCredentials;
  await database
    .insert(creds)
    .values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      providerHost: host,
      usernameCiphertext,
      passwordCiphertext,
      totpSeedCiphertext,
      dekVersion: version,
      masterKeyVersion,
      staleAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: [creds.familyId, creds.providerHost],
      set: {
        parentUserId: input.parentUserId,
        usernameCiphertext,
        passwordCiphertext,
        totpSeedCiphertext,
        dekVersion: version,
        masterKeyVersion,
        staleAt: null,
        updatedAt: input.now,
      },
    });
  return { ok: true };
}

/**
 * Decrypt only for a Browser Use run. Stale rows and a flag that is off return null.
 * The TOTP seed is turned into a current code here, never passed as a seed.
 */
export async function loadCredentialsForRun(
  database: Database,
  input: { familyId: string; providerHost: string; now: Date },
  kms: CredentialKms = envCredentialKms(),
): Promise<SavedProviderCredentials | null> {
  if (!providerCredentialsEnabled()) return null;
  const host = signupProviderHost(input.providerHost);
  const creds = schema.providerSignupCredentials;
  const [row] = await database
    .select()
    .from(creds)
    .where(
      and(eq(creds.familyId, input.familyId), eq(creds.providerHost, host), isNull(creds.staleAt)),
    )
    .limit(1);
  if (!row) return null;
  const keys = schema.familyProviderDataKeys;
  const [key] = await database
    .select()
    .from(keys)
    .where(and(eq(keys.familyId, input.familyId), eq(keys.keyVersion, row.dekVersion)))
    .limit(1);
  if (!key) return null;
  const dek = kms.unwrap(key.wrappedDek, key.masterKeyVersion);
  const totpSeed = row.totpSeedCiphertext ? decryptWithDek(dek, row.totpSeedCiphertext) : null;
  return {
    username: decryptWithDek(dek, row.usernameCiphertext),
    password: decryptWithDek(dek, row.passwordCiphertext),
    totp: totpSeed ? totpCode(totpSeed, input.now) : null,
  };
}

export async function markCredentialsStale(
  database: Database,
  input: { familyId: string; providerHost: string; now: Date },
): Promise<boolean> {
  const host = signupProviderHost(input.providerHost);
  const creds = schema.providerSignupCredentials;
  const [row] = await database
    .update(creds)
    .set({ staleAt: input.now, updatedAt: input.now })
    .where(
      and(eq(creds.familyId, input.familyId), eq(creds.providerHost, host), isNull(creds.staleAt)),
    )
    .returning({ id: creds.id });
  return Boolean(row);
}

export async function deleteProviderCredentials(
  database: Database,
  input: { familyId: string; providerHost?: string },
): Promise<number> {
  const creds = schema.providerSignupCredentials;
  const rows = await database
    .delete(creds)
    .where(
      and(
        eq(creds.familyId, input.familyId),
        input.providerHost
          ? eq(creds.providerHost, signupProviderHost(input.providerHost))
          : undefined,
      ),
    )
    .returning({ id: creds.id });
  return rows.length;
}

/**
 * Drop credentials whose last save is older than 45 days and that host has no
 * live plan. Family erasure already cascades the row.
 */
export async function sweepStaleProviderCredentials(
  database: Database,
  now: Date,
): Promise<{ deleted: number }> {
  const creds = schema.providerSignupCredentials;
  const offers = schema.authorizedSignupOffers;
  const cutoff = new Date(now.getTime() - CREDENTIAL_RETENTION_MS);
  const aged = await database
    .select({
      id: creds.id,
      familyId: creds.familyId,
      providerHost: creds.providerHost,
    })
    .from(creds)
    .where(lt(creds.updatedAt, cutoff));
  const drop: string[] = [];
  for (const row of aged) {
    const [live] = await database
      .select({ id: offers.id })
      .from(offers)
      .where(
        and(
          eq(offers.familyId, row.familyId),
          eq(offers.providerHost, row.providerHost),
          inArray(offers.status, ['pending', 'planned', 'submitting']),
        ),
      )
      .limit(1);
    if (!live) drop.push(row.id);
  }
  if (drop.length === 0) return { deleted: 0 };
  const removed = await database
    .delete(creds)
    .where(inArray(creds.id, drop))
    .returning({ id: creds.id });
  return { deleted: removed.length };
}
