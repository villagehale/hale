import { type Database, schema } from '@hale/db';
import { and, eq, lte } from 'drizzle-orm';
import { z } from 'zod';
import { decryptString, encryptString } from '~/lib/crypto/string-cipher';
import { signupProviderHost } from '../consent';

/**
 * Encrypted store for a parent's logged-in provider session (T8).
 *
 * Holds cookies and local storage captured the day before a registration.
 * Never a password: a storage key or cookie named like one is refused at
 * capture. Rows live at most 48 hours, and are deleted sooner when the parent
 * confirms they are in.
 */
export const PROVIDER_SESSION_TTL_MS = 48 * 60 * 60 * 1000;

const PASSWORDISH = /pass(word|wd)?|pwd|secret/i;

const cookie = z.object({
  name: z.string().min(1).max(4096),
  value: z.string().max(16384),
  domain: z.string().min(1).max(253),
  path: z.string().max(2048).default('/'),
  expires: z.number().default(-1),
  httpOnly: z.boolean().default(false),
  secure: z.boolean().default(true),
  sameSite: z.enum(['Strict', 'Lax', 'None']).default('Lax'),
});

const storageState = z.object({
  cookies: z.array(cookie).max(500),
  origins: z
    .array(
      z.object({
        origin: z.string().url(),
        localStorage: z
          .array(z.object({ name: z.string().max(4096), value: z.string().max(65536) }))
          .max(500),
      }),
    )
    .max(50)
    .default([]),
});

export type ProviderStorageState = z.infer<typeof storageState>;

/** Playwright `storageState()` shape, minus anything that names a password. */
export function parseProviderStorageState(raw: unknown): ProviderStorageState | null {
  const parsed = storageState.safeParse(raw);
  if (!parsed.success) return null;
  const state = parsed.data;
  if (state.cookies.some((item) => PASSWORDISH.test(item.name))) return null;
  if (state.origins.some((origin) => origin.localStorage.some((e) => PASSWORDISH.test(e.name)))) {
    return null;
  }
  if (state.cookies.length === 0 && state.origins.every((o) => o.localStorage.length === 0)) {
    return null;
  }
  return state;
}

export type StoreProviderSessionResult =
  | { ok: true; id: string; expiresAt: Date }
  | { ok: false; reason: 'invalid_state' | 'invalid_host' };

export async function storeProviderSession(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    providerHost: string;
    storageState: unknown;
    capturedAt: Date;
  },
): Promise<StoreProviderSessionResult> {
  const providerHost = signupProviderHost(input.providerHost);
  if (!providerHost || providerHost.length > 253) return { ok: false, reason: 'invalid_host' };
  const state = parseProviderStorageState(input.storageState);
  if (!state) return { ok: false, reason: 'invalid_state' };
  const expiresAt = new Date(input.capturedAt.getTime() + PROVIDER_SESSION_TTL_MS);
  const ciphertext = encryptString(JSON.stringify(state));
  const [row] = await database
    .insert(schema.providerSignupSessions)
    .values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      providerHost,
      storageStateCiphertext: ciphertext,
      capturedAt: input.capturedAt,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [schema.providerSignupSessions.familyId, schema.providerSignupSessions.providerHost],
      set: {
        parentUserId: input.parentUserId,
        storageStateCiphertext: ciphertext,
        browserUseProfileId: null,
        capturedAt: input.capturedAt,
        expiresAt,
      },
    })
    .returning({ id: schema.providerSignupSessions.id });
  if (!row) throw new Error('provider session upsert returned no row');
  return { ok: true, id: row.id, expiresAt };
}

export interface LoadedProviderSession {
  id: string;
  storageState: ProviderStorageState;
  browserUseProfileId: string | null;
  expiresAt: Date;
}

/** Null when nothing was captured for this host, or it is past 48 hours. */
export async function loadProviderSession(
  database: Database,
  input: { familyId: string; providerHost: string; now: Date },
): Promise<LoadedProviderSession | null> {
  const providerHost = signupProviderHost(input.providerHost);
  const [row] = await database
    .select()
    .from(schema.providerSignupSessions)
    .where(
      and(
        eq(schema.providerSignupSessions.familyId, input.familyId),
        eq(schema.providerSignupSessions.providerHost, providerHost),
      ),
    )
    .limit(1);
  if (!row || row.expiresAt.getTime() <= input.now.getTime()) return null;
  const state = parseProviderStorageState(JSON.parse(decryptString(row.storageStateCiphertext)));
  if (!state) return null;
  return {
    id: row.id,
    storageState: state,
    browserUseProfileId: row.browserUseProfileId,
    expiresAt: row.expiresAt,
  };
}

export async function recordBrowserUseProfile(
  database: Database,
  input: { sessionRowId: string; profileId: string },
): Promise<void> {
  await database
    .update(schema.providerSignupSessions)
    .set({ browserUseProfileId: input.profileId })
    .where(eq(schema.providerSignupSessions.id, input.sessionRowId));
}

/**
 * Deletes the remote Browser Use profile, then the row. Required, not optional:
 * a sweep that cannot reach Browser Use passes `not_configured` and the row
 * waits for the next run instead of leaving cookies on the remote profile.
 */
export type RemoteProfileDeleter =
  | { kind: 'api'; deleteProfile: (profileId: string) => Promise<void> }
  | { kind: 'not_configured' };

async function dropRow(
  database: Database,
  row: { id: string; browserUseProfileId: string | null },
  remote: RemoteProfileDeleter,
): Promise<'deleted' | 'remote_pending' | 'remote_failed'> {
  if (row.browserUseProfileId) {
    if (remote.kind === 'not_configured') return 'remote_pending';
    try {
      await remote.deleteProfile(row.browserUseProfileId);
    } catch {
      return 'remote_failed';
    }
  }
  await database
    .delete(schema.providerSignupSessions)
    .where(eq(schema.providerSignupSessions.id, row.id));
  return 'deleted';
}

/** Called once the parent says they are in (or a confirmation number was read). */
export async function deleteProviderSession(
  database: Database,
  input: { familyId: string; providerHost: string },
  remote: RemoteProfileDeleter,
): Promise<'deleted' | 'not_found' | 'remote_pending' | 'remote_failed'> {
  const providerHost = signupProviderHost(input.providerHost);
  const [row] = await database
    .select({
      id: schema.providerSignupSessions.id,
      browserUseProfileId: schema.providerSignupSessions.browserUseProfileId,
    })
    .from(schema.providerSignupSessions)
    .where(
      and(
        eq(schema.providerSignupSessions.familyId, input.familyId),
        eq(schema.providerSignupSessions.providerHost, providerHost),
      ),
    )
    .limit(1);
  if (!row) return 'not_found';
  return dropRow(database, row, remote);
}

export interface ProviderSessionSweep {
  deleted: number;
  remotePending: number;
  remoteFailed: number;
}

/** Hourly: every row past its 48-hour stamp. Counts only, never a host or family. */
export async function sweepExpiredProviderSessions(
  database: Database,
  now: Date,
  remote: RemoteProfileDeleter,
): Promise<ProviderSessionSweep> {
  const rows = await database
    .select({
      id: schema.providerSignupSessions.id,
      browserUseProfileId: schema.providerSignupSessions.browserUseProfileId,
    })
    .from(schema.providerSignupSessions)
    .where(lte(schema.providerSignupSessions.expiresAt, now));
  const sweep: ProviderSessionSweep = { deleted: 0, remotePending: 0, remoteFailed: 0 };
  for (const row of rows) {
    const result = await dropRow(database, row, remote);
    if (result === 'deleted') sweep.deleted += 1;
    else if (result === 'remote_pending') sweep.remotePending += 1;
    else sweep.remoteFailed += 1;
  }
  return sweep;
}
