import { createHash, randomBytes } from 'node:crypto';
import { MARKETING_SITE_URL } from '~/lib/legal-links';

/**
 * The co-parent join tag — the thing a parent's partner carries in with them.
 *
 * WHY IT IS RANDOM RATHER THAN DERIVED, which is the opposite call from the referral
 * tag next door. A referral code is HMAC(family id) because it must be stable and it
 * grants NOTHING: the worst a forged one does is attribute an arrival to nobody. This
 * token is a CAPABILITY — whoever redeems it is seated as a co-parent with the full
 * family scope — so it must be unguessable, single-use, and expirable, and a value
 * derived from a row can be none of those.
 *
 * 128 bits of `crypto.randomBytes`, hex. Hex rather than the `base64url` the auth
 * tokens use, and that is load-bearing: this string travels the site's `?s=` funnel,
 * whose grammar is lowercase kebab (`^[a-z0-9]+(?:-[a-z0-9]+)*$`, apps/site
 * lib/text-entry.ts). A base64url token would carry `_`, `-` runs and capitals, fail
 * `parseSourceCode`, and the /text page would silently pre-write a greeting with no tag
 * in it — a link that looks fine and adds nobody.
 *
 * NOTHING IS STORED BUT {@link joinTokenHash}. See packages/db join-invites.ts: a read
 * of the invite table can never reconstruct a usable link (rule #1).
 */

/** The word in front of the digest — what the tag says about the person carrying it. */
const CODE_PREFIX = 'join';

/** 16 bytes: unguessable at any scale, and short enough that the whole link plus a
 * sentence still fits two SMS segments. */
const TOKEN_BYTES = 16;
const TOKEN_HEX_CHARS = TOKEN_BYTES * 2;

/** The grammar of a join tag, as the intake parser must recognise it. */
export const JOIN_CODE_PATTERN = new RegExp(`^${CODE_PREFIX}-[0-9a-f]{${TOKEN_HEX_CHARS}}$`);

/** A fresh, single-use join tag. Returned once, to the parent, and never stored. */
export function mintJoinCode(): string {
  return `${CODE_PREFIX}-${randomBytes(TOKEN_BYTES).toString('hex')}`;
}

/**
 * Whether a raw source tag is shaped like a join link rather than a referral or a venue.
 *
 * A SHAPE test, deliberately not a validity one — the same contract `isReferralCode`
 * keeps. Whether the token means anything is a question for the invite table; all this
 * decides is which reader gets to ask it. A tag that matches nobody costs nothing,
 * because the arrival simply falls back to the ordinary greeting.
 */
export function isJoinCode(raw: string): boolean {
  return JOIN_CODE_PATTERN.test(raw.toLowerCase());
}

/** What the database holds instead of the token. Lowercased first, because a forwarded
 * link can arrive shouted and a case-folded lookup must still find its row. */
export function joinTokenHash(code: string): string {
  return createHash('sha256').update(code.toLowerCase()).digest('hex');
}

/**
 * The link a parent forwards.
 *
 * The marketing site, not the app, for the reason `referralLink` gives: /text is the one
 * surface built for somebody who has no account and is not going to make one. It
 * pre-writes the first message and the partner taps send — and that outbound text of
 * theirs is the CASL basis for everything Hale sends them afterwards.
 */
export function joinLink(code: string): string {
  return `${MARKETING_SITE_URL}/text?s=${code}`;
}
