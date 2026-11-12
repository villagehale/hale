import { type Database, schema } from '@hale/db';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { signupProviderHost } from '../consent';
import { hashLoginCode, loginLinkExpiresAt, loginLinkUrl, newLoginCode } from './code';

const LOGIN_LINK_KINDS = ['login_ask', 'account_prep', 'password_rejected'] as const;

/**
 * What the card and its page say the login is for: the session and the open in the
 * parent's own zone, or no open once it will have passed while the card is live. Never a
 * credential and never a child's name — the link preview is fetched by whoever renders it.
 */
const loginLinkPurposeSchema = z.object({
  kind: z.enum(LOGIN_LINK_KINDS),
  sessionLabel: z.string().nullable(),
  opensAt: z.object({ local: z.string(), timeZone: z.string() }).nullable(),
});

export type LoginLinkPurpose = z.infer<typeof loginLinkPurposeSchema>;

export type LoginLinkLookup =
  | {
      ok: true;
      id: string;
      familyId: string;
      parentUserId: string;
      offerId: string | null;
      providerHost: string;
      purpose: LoginLinkPurpose | null;
    }
  | { ok: false; reason: 'unknown' | 'expired' | 'used' };

type MintLoginLinkInput = {
  familyId: string;
  parentUserId: string;
  offerId: string | null;
  providerHost: string;
  purpose: LoginLinkPurpose;
  now: Date;
};

/** Not exported: every mint goes through {@link mintFreshLoginLink}, so a host has one live card. */
async function mintLoginLink(
  database: Database,
  input: MintLoginLinkInput,
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
      purpose: input.purpose,
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
    purpose: loginLinkPurposeSchema.safeParse(row.purpose).data ?? null,
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

/** Whether the host already has a live card: unspent and not expired. */
export async function hasOpenLoginLink(
  database: Database,
  input: { familyId: string; providerHost: string; now: Date },
): Promise<boolean> {
  const links = schema.providerLoginLinks;
  const [row] = await database
    .select({ id: links.id })
    .from(links)
    .where(
      and(
        eq(links.familyId, input.familyId),
        eq(links.providerHost, signupProviderHost(input.providerHost)),
        isNull(links.consumedAt),
        gt(links.expiresAt, input.now),
      ),
    )
    .limit(1);
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
  input: MintLoginLinkInput,
): Promise<{ url: string; expiresAt: Date; id: string }> {
  await invalidateOpenLoginLinks(database, {
    familyId: input.familyId,
    providerHost: input.providerHost,
    now: input.now,
  });
  return mintLoginLink(database, input);
}
