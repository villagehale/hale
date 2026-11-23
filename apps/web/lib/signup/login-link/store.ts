import { type Database, schema } from '@hale/db';
import { and, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { SealedBlobRejected, decryptString, encryptString } from '~/lib/crypto/string-cipher';
import { liveViewUrl } from '../browser-use/live-view';
import { signupProviderHost } from '../consent';
import { TAKEOVER_PURPOSES } from '../takeover/purpose';
import { hashLoginCode, loginLinkExpiresAt, loginLinkUrl, newLoginCode } from './code';

/**
 * `takeover` (VIL-718) is the one link for a step only the parent can do while a run is
 * stopped: it opens Hale's own browser on the provider's page instead of a login form.
 */
const LOGIN_LINK_KINDS = ['login_ask', 'account_prep', 'password_rejected', 'takeover'] as const;

/**
 * The words on the card's preview in the thread, written by the notice writer in the
 * parent's language. Null when the writer wrote none it could keep: the preview is then
 * the bare provider host, never a fixed sentence.
 */
const loginCardTextSchema = z.object({ title: z.string(), description: z.string().nullable() });

export type LoginCardText = z.infer<typeof loginCardTextSchema>;

/**
 * What the card and its page say the login is for: the session and the open in the
 * parent's own zone, or no open once it will have passed while the card is live. Never a
 * credential and never a child's name — the link preview is fetched by whoever renders it.
 */
const loginLinkPurposeSchema = z.object({
  kind: z.enum(LOGIN_LINK_KINDS),
  sessionLabel: z.string().nullable(),
  opensAt: z.object({ local: z.string(), timeZone: z.string() }).nullable(),
  card: loginCardTextSchema.nullable(),
  /** VIL-718 · on a `takeover` card: the step the parent takes in Hale's browser. */
  takeover: z.enum(TAKEOVER_PURPOSES).optional(),
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
  /** VIL-718 · a takeover closes before its browser does. Absent: the card's own 30 minutes. */
  expiresAt?: Date;
  /** VIL-718 · the browser a takeover opens. Its live view is sealed on the row. */
  browser?: { browserId: string | null; liveViewUrl: string } | null;
};

type MintedLoginLink = { url: string; expiresAt: Date; id: string };

/**
 * Not exported: every mint goes through {@link mintFreshLoginLink} or
 * {@link loginLinkForNotice}, inside {@link withHostLock}, after the host's open rows are spent.
 */
async function mintLoginLink(
  database: Database,
  input: MintLoginLinkInput,
): Promise<MintedLoginLink> {
  const code = newLoginCode();
  const expiresAt = input.expiresAt ?? loginLinkExpiresAt(input.now);
  const browser = input.browser ?? null;
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
      ...(browser
        ? {
            browserId: browser.browserId,
            browserHandleCiphertext: sealLiveView(browser.liveViewUrl),
          }
        : {}),
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
    .set({ consumedAt: input.now, browserHandleCiphertext: null, browserId: null })
    .where(
      and(eq(schema.providerLoginLinks.id, input.id), isNull(schema.providerLoginLinks.consumedAt)),
    )
    .returning({ id: schema.providerLoginLinks.id });
  return Boolean(row);
}

/** Whether the parent holds a live card for the host: sent to them, unspent and not expired. */
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
        isNotNull(links.sentAt),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** The door stamps a card once it reached the parent's thread, so a retry can reuse it. */
export async function markLoginLinkSent(
  database: Database,
  input: { id: string; familyId: string; now: Date },
): Promise<void> {
  const links = schema.providerLoginLinks;
  await database
    .update(links)
    .set({ sentAt: input.now })
    .where(and(eq(links.id, input.id), eq(links.familyId, input.familyId), isNull(links.sentAt)));
}

/** A rejected password replaces the old code: every open link for this host is spent. */
export async function invalidateOpenLoginLinks(
  database: Database,
  input: { familyId: string; providerHost: string; now: Date },
): Promise<number> {
  const rows = await database
    .update(schema.providerLoginLinks)
    .set({ consumedAt: input.now, browserHandleCiphertext: null, browserId: null })
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

/**
 * One transaction per family and host, serialised on an advisory lock: spending the open
 * rows and inserting the new card cannot interleave with another mint, and the partial
 * unique index (one unspent row per host) holds by construction.
 */
function withHostLock<T>(
  database: Database,
  input: { familyId: string; providerHost: string },
  work: (tx: Database) => Promise<T>,
): Promise<T> {
  const key = `provider_login_links:${input.familyId}:${signupProviderHost(input.providerHost)}`;
  return database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    return work(tx);
  });
}

async function replaceOpenLoginLinks(
  tx: Database,
  input: MintLoginLinkInput,
): Promise<MintedLoginLink> {
  await invalidateOpenLoginLinks(tx, {
    familyId: input.familyId,
    providerHost: input.providerHost,
    now: input.now,
  });
  return mintLoginLink(tx, input);
}

/** Invalidate any open code for this host, then mint a fresh one, in one transaction. */
export async function mintFreshLoginLink(
  database: Database,
  input: MintLoginLinkInput,
): Promise<MintedLoginLink> {
  return withHostLock(database, input, (tx) => replaceOpenLoginLinks(tx, input));
}

/**
 * The card for one notice the sweep retries until it goes. When this notice's card already
 * reached the parent and is still live, a retry reuses it (`reused`, no new link to send)
 * instead of minting a second card. A card that never went, or any other notice's card, is
 * spent and a fresh one minted.
 */
export async function loginLinkForNotice(
  database: Database,
  input: MintLoginLinkInput & { offerId: string },
): Promise<({ status: 'minted' } & MintedLoginLink) | { status: 'reused'; id: string }> {
  return withHostLock(database, input, async (tx) => {
    const links = schema.providerLoginLinks;
    const [open] = await tx
      .select({ id: links.id, purpose: links.purpose })
      .from(links)
      .where(
        and(
          eq(links.familyId, input.familyId),
          eq(links.providerHost, signupProviderHost(input.providerHost)),
          eq(links.offerId, input.offerId),
          isNull(links.consumedAt),
          gt(links.expiresAt, input.now),
          isNotNull(links.sentAt),
        ),
      )
      .limit(1);
    if (open && loginLinkPurposeSchema.safeParse(open.purpose).data?.kind === input.purpose.kind) {
      return { status: 'reused', id: open.id };
    }
    return { status: 'minted', ...(await replaceOpenLoginLinks(tx, input)) };
  });
}

/**
 * VIL-718 · a takeover's live view, sealed for the row. The link alone never leaves the
 * server: the page asks for it with a POST, so whoever fetches the card's preview never
 * sees it. Only a live view on Browser Use's own host is ever sealed.
 */
function sealLiveView(url: string): string {
  const pinned = liveViewUrl(url);
  if (!pinned) throw new Error('takeover link refused a live view off its host');
  return encryptString(JSON.stringify({ liveViewUrl: pinned }));
}

const sealedLiveViewSchema = z.object({ liveViewUrl: z.string() });

/** The sealed live view, re-pinned on the way out. Null when it is gone or will not open. */
function openLiveView(blob: string | null): string | null {
  if (!blob) return null;
  try {
    const parsed = sealedLiveViewSchema.safeParse(JSON.parse(decryptString(blob)));
    return parsed.success ? liveViewUrl(parsed.data.liveViewUrl) : null;
  } catch (err) {
    if (err instanceof SealedBlobRejected || err instanceof SyntaxError) return null;
    throw err;
  }
}

/**
 * Mints the takeover card for one stopped run, inside the host lock: every other open card
 * for the host is spent first, so one live card per host holds (the partial unique index).
 */
export async function mintTakeoverLink(
  database: Database,
  input: MintLoginLinkInput & {
    offerId: string;
    expiresAt: Date;
    browser: { browserId: string | null; liveViewUrl: string };
  },
): Promise<MintedLoginLink> {
  if (input.purpose.kind !== 'takeover' || !input.purpose.takeover) {
    throw new Error('a takeover link carries a takeover purpose');
  }
  return withHostLock(database, input, (tx) => replaceOpenLoginLinks(tx, input));
}

export type TakeoverLinkLookup =
  | {
      ok: true;
      id: string;
      familyId: string;
      parentUserId: string;
      offerId: string;
      providerHost: string;
      purpose: LoginLinkPurpose & { kind: 'takeover' };
    }
  | { ok: false; reason: 'unknown' | 'expired' | 'used' };

/** An open takeover card by its code. Any other card, or one with no plan, is `unknown`. */
export async function lookupTakeoverLink(
  database: Database,
  code: string,
  now: Date,
): Promise<TakeoverLinkLookup> {
  const looked = await lookupLoginLink(database, code, now);
  if (!looked.ok) return looked;
  const purpose = looked.purpose;
  if (purpose?.kind !== 'takeover' || !purpose.takeover || !looked.offerId) {
    return { ok: false, reason: 'unknown' };
  }
  return {
    ok: true,
    id: looked.id,
    familyId: looked.familyId,
    parentUserId: looked.parentUserId,
    offerId: looked.offerId,
    providerHost: looked.providerHost,
    purpose: { ...purpose, kind: 'takeover' },
  };
}

/** The live view sealed on an unspent card, or null when its browser handle is gone. */
export async function cardLiveView(database: Database, linkId: string): Promise<string | null> {
  const links = schema.providerLoginLinks;
  const [row] = await database
    .select({ handle: links.browserHandleCiphertext })
    .from(links)
    .where(and(eq(links.id, linkId), isNull(links.consumedAt)))
    .limit(1);
  return openLiveView(row?.handle ?? null);
}
