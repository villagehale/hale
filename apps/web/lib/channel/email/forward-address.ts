import { randomBytes } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { and, eq, isNotNull } from 'drizzle-orm';
import { parseEmailAddress } from './address';
import type { EmailInboundConfig } from './config';

/**
 * THE FORWARDING ADDRESS — `hale+<token>@<inbound domain>` — and the one place it is
 * minted, revoked, written and read (VIL-352 rung 3a).
 *
 * WHY THE ADDRESS IS THE CREDENTIAL. On the reply door, `From` is the identity and DKIM
 * alignment is what makes it one (trust.ts). A forward inverts that: on a Gmail
 * filter-forward `From` is the school, and DKIM then proves only that the school signed
 * its own mail. So the thing that says WHICH FAMILY this document belongs to has to be
 * the recipient — which means the recipient is a secret, and a raw family id in a local
 * part would be a write handle into a household's thread for anyone who reads a forwarded
 * header. `families.ics_share_token` is the in-repo shape for a high-entropy, revocable,
 * per-family secret; nulling the column revokes the address.
 *
 * WHY HEX AND NOT base64url. `parseEmailAddress` LOWERCASES the whole address
 * (address.ts), the doc comment there promising only that a `+tag` is not stripped, and
 * mail systems fold local-part case anyway. A mixed-case secret is a secret that can never
 * match itself after parsing, so the alphabet is lowercase hex on both sides. The
 * `ics_share_token` precedent lives in a URL path, which is case-sensitive, and does not
 * transfer.
 *
 * THE TWO FORMS, and why there is no open-question row:
 *   `hale+<token>`        a forwarded DOCUMENT. Identity is the token; `From` is ignored.
 *   `hale+<token>.<ref>`  an ANSWER about the one pending sender `<ref>` names.
 * The ask is sent with the second form as its `Reply-To`, so the address the parent
 * replies to says which sender the answer is about. A bare YES can never be stolen from,
 * or by, another open question, because this door never puts one on the list.
 */

/** 120 bits. Worst-case local part: `hale+` (5) + 30 + `.` + 8 = 44, inside RFC 5321's 64. */
const TOKEN_BYTES = 15;
const REF_BYTES = 4;
const TOKEN_HEX_CHARS = TOKEN_BYTES * 2;
const REF_HEX_CHARS = REF_BYTES * 2;

/** The local part Hale receives on, shared with the reply address (reply-send.ts): one
 * door, two local parts. */
const FORWARD_LOCAL_PART = 'hale';

const TAG = new RegExp(`^${FORWARD_LOCAL_PART}\\+([0-9a-f]{${TOKEN_HEX_CHARS}})(?:\\.([0-9a-f]{${REF_HEX_CHARS}}))?$`);
const TAGGED_AT_ALL = new RegExp(`^${FORWARD_LOCAL_PART}\\+`);

/** The `for <addr>` clause an MTA stamps on a `Received` line — the last resort, and the
 * only source that survives a forward which rewrites every other recipient field. */
const RECEIVED_FOR = /\bfor\s+<([^<>\s]+)>/i;

/**
 * Which door a message is for. THREE states, never two: `malformed` exists so a `hale+`
 * tag we cannot read STOPS at the forward door with a named outcome instead of falling
 * through to the reply door, where `From` would silently become the identity again.
 */
export type ForwardRecipient =
  | { kind: 'reply' }
  | { kind: 'forward'; token: string; ref: string | null }
  | { kind: 'malformed' };

export function forwardAddress(token: string, config: EmailInboundConfig): string {
  return `${FORWARD_LOCAL_PART}+${token}@${config.inboundDomain}`;
}

export function forwardAnswerAddress(
  token: string,
  ref: string,
  config: EmailInboundConfig,
): string {
  return `${FORWARD_LOCAL_PART}+${token}.${ref}@${config.inboundDomain}`;
}

/** One candidate recipient, read as a forward tag. Null when it is not our domain at
 * all — which is an ordinary recipient, not a refusal. */
function readTag(candidate: string, config: EmailInboundConfig): ForwardRecipient | null {
  const parsed = parseEmailAddress(candidate);
  if (!parsed || parsed.domain !== config.inboundDomain) return null;

  const localPart = parsed.address.slice(0, parsed.address.lastIndexOf('@'));
  if (!TAGGED_AT_ALL.test(localPart)) return null;

  const match = TAG.exec(localPart);
  if (!match) return { kind: 'malformed' };
  return { kind: 'forward', token: match[1] as string, ref: match[2] ?? null };
}

function header(headers: Readonly<Record<string, string>>, name: string): string | null {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return found?.[1]?.trim() || null;
}

/**
 * The forward tag this message carries, from the four places it can be.
 *
 * The order is deliberate and the reason is that only the first is knowable before the
 * content fetch. Whether Resend's `data.to` carries the ENVELOPE recipient (which a Gmail
 * filter-forward sets to our address) or the header `To:` (which it preserves as the
 * parent) is not knowable from this repo — it is gate 1 of the live probe. The three
 * header fallbacks are what make the door work either way.
 */
export function forwardRecipient(
  message: { to: readonly string[]; headers: Readonly<Record<string, string>> },
  config: EmailInboundConfig,
): ForwardRecipient {
  const candidates = [
    ...message.to,
    header(message.headers, 'delivered-to'),
    header(message.headers, 'x-forwarded-to'),
    RECEIVED_FOR.exec(header(message.headers, 'received') ?? '')?.[1] ?? null,
  ];

  let malformed = false;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const tag = readTag(candidate, config);
    if (tag?.kind === 'forward') return tag;
    if (tag?.kind === 'malformed') malformed = true;
  }
  // A readable tag anywhere wins over an unreadable one; an unreadable one still stops.
  return malformed ? { kind: 'malformed' } : { kind: 'reply' };
}

/**
 * Ensures the family carries a forwarding token, minting one on first call. Idempotent —
 * a family that already has one gets it back unchanged, with no write and no second audit
 * row — so the address a parent has saved in a filter stays stable. Family-scoped UPDATE;
 * the first mint writes one immutable audit row (rule #6). The token names nobody.
 */
export async function mintForwardToken(
  database: Database,
  familyId: string,
): Promise<{ token: string }> {
  const rows = await database
    .select({ token: schema.families.inboundForwardToken })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);

  const existing = rows[0]?.token;
  if (existing) return { token: existing };

  const token = randomBytes(TOKEN_BYTES).toString('hex');
  await database
    .update(schema.families)
    .set({ inboundForwardToken: token })
    .where(eq(schema.families.id, familyId));

  await database.insert(schema.auditLog).values({
    familyId,
    actor: 'system',
    actionTaken: 'email_forward_address_minted',
    targetTable: 'families',
    targetId: familyId,
  });

  return { token };
}

/**
 * Is there a live address to turn off?
 *
 * Read BEFORE the confirm question is asked (handlers.ts), and the read is what keeps the
 * question honest in both directions: a family with nothing to revoke gets the
 * `not_configured` sentence straight away instead of being asked to confirm destroying
 * something they do not have — and, more than manners, no open question is minted, so a
 * bare affirmative in that household stays unambiguous.
 *
 * It answers only whether the column is set. Nothing here returns the token: a caller
 * that needs the address mints it.
 */
export async function hasForwardToken(database: Database, familyId: string): Promise<boolean> {
  const rows = await database
    .select({ token: schema.families.inboundForwardToken })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);
  return Boolean(rows[0]?.token);
}

/**
 * Revokes the family's forwarding address by nulling the token, so every copy of it a
 * school's filter holds resolves nothing. One audit row (rule #6), and only when a live
 * token was actually cleared — the `revokeIcsToken` shape. Returns whether one was.
 */
export async function revokeForwardToken(database: Database, familyId: string): Promise<boolean> {
  const revoked = await database
    .update(schema.families)
    .set({ inboundForwardToken: null })
    .where(
      and(eq(schema.families.id, familyId), isNotNull(schema.families.inboundForwardToken)),
    )
    .returning({ id: schema.families.id });
  if (revoked.length === 0) return false;

  await database.insert(schema.auditLog).values({
    familyId,
    actor: 'system',
    actionTaken: 'email_forward_address_revoked',
    targetTable: 'families',
    targetId: familyId,
    after: { inboundForwardToken: null },
  });
  return true;
}

/**
 * WHAT MAKES A FORWARD THE SAME FORWARD — and why this door cannot borrow the reply
 * door's answer.
 *
 * On the reply door a Message-ID is the parent's own envelope handle: one household
 * wrote it, so `provider_message_id` alone is a sound identity and the global partial
 * unique index on `channel_messages` is the claim. Here the Message-ID belongs to a
 * THIRD PARTY. A school sends one newsletter with one id and every family it reaches can
 * forward that same id, so the global rule reads two households' documents as one
 * delivery and drops the second in silence — no row, no ask, no refusal (rule #11).
 *
 * The identity on this door is therefore (FAMILY, Message-ID), and this is that key. It
 * is spent on `channel_messages.dedupe_key` — the column that already means "natural
 * identity of a message, e.g. family+week+template", under its own global unique index —
 * rather than on `provider_message_id`, which stays NULL on a forward row. Two reasons,
 * and they are the same reason twice:
 *   - the reply door's global rule is left exactly as it is, for every other door that
 *     leans on it (the SMS door, the voice recording, the email reply itself). Narrowing
 *     a live index would have made three unrelated inbound legs' `ON CONFLICT` stop
 *     inferring it.
 *   - a forward row carrying a third party's id in the column that means "the provider's
 *     id for THIS message" is the category error the drop grew out of. The id is still
 *     on the row, inside the key, and the held document carries it too.
 */
export function forwardClaimKey(familyId: string, providerMessageId: string): string {
  return `email_forward:${familyId}:${providerMessageId}`;
}

/**
 * The family behind a token, or null for one that was never minted or has been revoked.
 *
 * The token is re-checked over the returned row rather than trusted to the predicate —
 * the defense in depth identity.ts documents, because the cost of the wrong row here is a
 * third party's document filed in somebody else's household.
 */
export async function familyForForwardToken(
  database: Database,
  token: string,
): Promise<string | null> {
  const wanted = token.toLowerCase();
  const rows = await database
    .select({ id: schema.families.id, token: schema.families.inboundForwardToken })
    .from(schema.families)
    .where(eq(schema.families.inboundForwardToken, wanted))
    .limit(2);

  const matches = rows.filter((row) => row.token === wanted);
  return matches.length === 1 ? (matches[0] as (typeof matches)[number]).id : null;
}

/** A fresh per-sender sub-tag. Unique per family by the index, retried by the caller. */
export function mintForwardRef(): string {
  return randomBytes(REF_BYTES).toString('hex');
}
