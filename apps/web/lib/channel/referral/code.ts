import { createHmac, hkdfSync } from 'node:crypto';
import { MARKETING_SITE_URL } from '~/lib/legal-links';

/**
 * The per-family referral tag — the thing a parent's friend carries in with them.
 *
 * A parent who wants to tell a friend about Hale gets a link they forward THEMSELVES.
 * Hale never texts the friend: the friend's own first message is what starts the
 * relationship and what makes it CASL-clean (the same rule the /text QR cards run on).
 * So the only thing this module produces is a tag on a URL — no outbound anything.
 *
 * WHY IT IS DERIVED RATHER THAN STORED. A referral code needs exactly two properties:
 * the same family always gets the same one, and reading one tells you nothing about the
 * family. HMAC over the family id gives both with no table, no migration, and no state
 * that could drift from the family row it describes.
 *
 * PRIVACY (rule #1). The family UUID never appears in the code, and the code cannot be
 * inverted back to one — it is a keyed digest, not an encoding. That matters because
 * this string is the most widely-copied identifier Hale emits: it rides in a parent's
 * forwarded text, in a stranger's first message, in an analytics property and in the
 * consent record. Anything derivable from it is derivable by everyone who sees it, so
 * the answer is that nothing is.
 *
 * KEY SEPARATION follows lib/crypto/blind-index.ts exactly: an HKDF subkey of
 * APP_ENCRYPTION_KEY under this module's own context label, so a leaked referral code
 * is not an oracle for the phone index or the encryption key, and no new secret has to
 * be provisioned for the feature to work.
 *
 * SHAPE. `friend-<12 lowercase hex>` — lowercase kebab, matching the site's own source
 * -code grammar (apps/site/lib/text-entry.ts `SOURCE_CODE_PATTERN`) so it travels the
 * existing `?s=` funnel with nothing new to parse. 48 bits: unguessable at any scale
 * this product will see, and short enough that the whole link fits an SMS twice over.
 */

const KEY_BYTES = 32;
/** This module's HKDF context label. Bumping the version rotates every family's code,
 * which orphans links already forwarded — so it is pinned. */
const REFERRAL_CODE_INFO = 'hale-referral-code-v1';

/** How much of the digest the code carries. */
const CODE_HEX_CHARS = 12;

/** The word in front of the digest. A friend reading the tag in their own outgoing
 * message should be able to tell what it says about them, and "friend" is the truth. */
const CODE_PREFIX = 'friend';

/** The grammar of a referral tag, as the intake parser must recognise it. */
export const REFERRAL_CODE_PATTERN = new RegExp(`^${CODE_PREFIX}-[0-9a-f]{${CODE_HEX_CHARS}}$`);

function loadKeyMaterial(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('APP_ENCRYPTION_KEY is not set — cannot derive a referral code');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `APP_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}) — generate one with \`openssl rand -base64 32\``,
    );
  }
  return key;
}

/** This module's HMAC key, distinct from the encryption key and from the blind index's. */
function referralKey(): Buffer {
  return Buffer.from(
    hkdfSync('sha256', loadKeyMaterial(), Buffer.alloc(0), REFERRAL_CODE_INFO, KEY_BYTES),
  );
}

/** The referral tag for a family. Deterministic, one-way, and safe to print. */
export function referralCode(familyId: string): string {
  const digest = createHmac('sha256', referralKey()).update(familyId).digest('hex');
  return `${CODE_PREFIX}-${digest.slice(0, CODE_HEX_CHARS)}`;
}

/** Whether a raw source tag is shaped like a referral rather than a QR venue.
 *
 * A SHAPE test, deliberately not a validity one. The venue registry can reject an
 * unknown code because a venue's NAME is read back to the parent in the greeting, so an
 * unrecognised one would have Hale claiming to know a place it has never heard of. A
 * referral tag is never echoed anywhere — it selects no copy and no area — so a forged
 * or stale one costs nothing beyond an attribution that resolves to no family. */
export function isReferralCode(raw: string): boolean {
  return REFERRAL_CODE_PATTERN.test(raw.toLowerCase());
}

/**
 * The link a parent forwards.
 *
 * The marketing site, not the app: /text is the one surface built for somebody who has
 * no account and is not going to make one — it pre-writes the first message and the
 * friend taps send. Sending them to app.villagehale.com would be sending a stranger to
 * a sign-in page, which is the opposite of what this product is.
 */
export function referralLink(familyId: string): string {
  return `${MARKETING_SITE_URL}/text?s=${referralCode(familyId)}`;
}
