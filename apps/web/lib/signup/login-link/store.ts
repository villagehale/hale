import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { signupProviderHost } from '../consent';
import { hashLoginCode, loginLinkExpiresAt, loginLinkUrl, newLoginCode } from './code';

export type LoginLinkLookup =
  | {
      ok: true;
      id: string;
      familyId: string;
      parentUserId: string;
      offerId: string | null;
      providerHost: string;
      purpose: Record<string, unknown> | null;
    }
  | { ok: false; reason: 'unknown' | 'expired' | 'used' };

export async function mintLoginLink(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    offerId: string | null;
    providerHost: string;
    purpose?: Record<string, unknown> | null;
    now: Date;
  },
): Promise<{ url: string; expiresAt: Date; id: string }> {
  const code = newLoginCode();
  const expiresAt = loginLinkExpiresAt(input.now);
  const [row] = await database
    .insert(schema.providerLoginLinks)
    .values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      offerId: input.offerId,
      providerHost: signupProviderHost(input.providerHost),
      tokenHash: hashLoginCode(code),
      expiresAt,
      createdAt: input.now,
      purpose: input.purpose ?? null,
    })
    .returning({ id: schema.providerLoginLinks.id });
  if (!row) throw new Error('login link not stored');
  return { url: loginLinkUrl(code), expiresAt, id: row.id };
}

export async function lookupLoginLink(
  database: Database,
  code: string,
  now: Date,
): Promise<LoginLinkLookup> {
  if (!/^[0-9A-Za-z]{8,16}$/.test(code)) return { ok: false, reason: 'unknown' };
  const [row] = await database
    .select()
    .from(schema.providerLoginLinks)
    .where(eq(schema.providerLoginLinks.tokenHash, hashLoginCode(code)))
    .limit(1);
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.consumedAt) return { ok: false, reason: 'used' };
  if (row.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'expired' };
  return {
    ok: true,
    id: row.id,
    familyId: row.familyId,
    parentUserId: row.parentUserId,
    offerId: row.offerId,
    providerHost: row.providerHost,
    purpose: row.purpose,
  };
}

export async function consumeLoginLink(
  database: Database,
  input: { id: string; now: Date },
): Promise<boolean> {
  const [row] = await database
    .update(schema.providerLoginLinks)
    .set({ consumedAt: input.now, browserHandleCiphertext: null })
    .where(
      and(eq(schema.providerLoginLinks.id, input.id), isNull(schema.providerLoginLinks.consumedAt)),
    )
    .returning({ id: schema.providerLoginLinks.id });
  return Boolean(row);
}

/** A rejected password replaces the old code: every open link for this host is spent. */
export async function invalidateOpenLoginLinks(
  database: Database,
  input: { familyId: string; providerHost: string; now: Date },
): Promise<number> {
  const rows = await database
    .update(schema.providerLoginLinks)
    .set({ consumedAt: input.now, browserHandleCiphertext: null })
    .where(
      and(
        eq(schema.providerLoginLinks.familyId, input.familyId),
        eq(schema.providerLoginLinks.providerHost, signupProviderHost(input.providerHost)),
        isNull(schema.providerLoginLinks.consumedAt),
      ),
    )
    .returning({ id: schema.providerLoginLinks.id });
  return rows.length;
}

/** Invalidate any open code for this host, then mint a fresh one. */
export async function mintFreshLoginLink(
  database: Database,
  input: Parameters<typeof mintLoginLink>[1],
): Promise<{ url: string; expiresAt: Date; id: string }> {
  await invalidateOpenLoginLinks(database, {
    familyId: input.familyId,
    providerHost: input.providerHost,
    now: input.now,
  });
  return mintLoginLink(database, input);
}
