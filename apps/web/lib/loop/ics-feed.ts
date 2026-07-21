import { randomBytes } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, asc, eq, gte, isNotNull, isNull, lte } from 'drizzle-orm';
import { generateFamilyIcs } from './ics.js';

/**
 * The tokenized, read-only ICS calendar-subscription feed (VIL-219). The token is the
 * ONLY handle to a family's feed and is revocable by construction: `families.ics_share_token`
 * is nullable and unique, every read resolves `WHERE ics_share_token = :token`, so nulling
 * it makes the token resolve nothing and the feed goes dead. Same share-token pattern as
 * village/share.ts. Family-scoped throughout (rule #1); mint and revoke each write one
 * immutable audit row (rule #6).
 */

/** The generic title a teenager's (13+) event renders as — never a name or raw content
 * (rule #1). A teen event's location is dropped for the same reason. */
const TEEN_REDACTED_TITLE = 'A private calendar item';

/** The feed's forward window: yesterday through 90 days out. A subscription is a live
 * near-term view, not the family's entire event history. */
const WINDOW_PAST_DAYS = 1;
const WINDOW_FORWARD_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Ensures the family carries an ICS feed token, minting one on first call. Idempotent:
 * a family that already has a token returns it unchanged — no write, no new audit row —
 * so the subscription URL is stable. Family-scoped UPDATE; the first mint writes one
 * immutable audit row (rule #6). The opaque token (randomBytes(18) → base64url) names
 * no child or parent.
 */
export async function mintIcsToken(db: Database, familyId: string): Promise<{ token: string }> {
  const rows = await db
    .select({ token: schema.families.icsShareToken })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);

  const family = rows[0];
  if (family?.token) {
    return { token: family.token };
  }

  const token = randomBytes(18).toString('base64url');

  await db
    .update(schema.families)
    .set({ icsShareToken: token })
    .where(eq(schema.families.id, familyId));

  await db.insert(schema.auditLog).values({
    familyId,
    actor: 'system',
    actionTaken: 'ics_feed_shared',
    targetTable: 'families',
    targetId: familyId,
  });

  return { token };
}

/**
 * Revokes the family's ICS feed: nulls the token, family-scoped, and writes one
 * immutable audit row (rule #6) only when a live token was actually cleared. The
 * `isNotNull` guard makes a revoke on an already-tokenless family a no-op — no write,
 * no audit row. Returns whether a live feed was revoked.
 */
export async function revokeIcsToken(db: Database, familyId: string): Promise<boolean> {
  const revoked = await db
    .update(schema.families)
    .set({ icsShareToken: null })
    .where(and(eq(schema.families.id, familyId), isNotNull(schema.families.icsShareToken)))
    .returning({ id: schema.families.id });

  if (revoked.length === 0) {
    return false;
  }

  await db.insert(schema.auditLog).values({
    familyId,
    actor: 'system',
    actionTaken: 'ics_feed_revoked',
    targetTable: 'families',
    targetId: familyId,
    after: { icsShareToken: null },
  });

  return true;
}

/**
 * Resolves an ICS token to its family's rendered calendar feed, or null for an unknown
 * (or revoked) token. Reads only that family's NON-DELETED events (`deleted_at IS NULL`)
 * whose start falls in the forward window, joins children solely for the DOB the teen
 * gate needs, then applies the gate (rule #1): a 13+ child's event renders a generic
 * title and no location — no name, no raw content. Non-teen events keep their stored,
 * first-name-only title. Family-scoped by the token resolution.
 */
export async function loadIcsFeed(
  db: Database,
  token: string,
  now: Date,
): Promise<string | null> {
  const familyRows = await db
    .select({ id: schema.families.id })
    .from(schema.families)
    .where(eq(schema.families.icsShareToken, token))
    .limit(1);

  const family = familyRows[0];
  if (!family) {
    return null;
  }

  const windowStart = new Date(now.getTime() - WINDOW_PAST_DAYS * MS_PER_DAY);
  const windowEnd = new Date(now.getTime() + WINDOW_FORWARD_DAYS * MS_PER_DAY);

  const rows = await db
    .select({
      id: schema.familyEvents.id,
      title: schema.familyEvents.title,
      startsAt: schema.familyEvents.startsAt,
      endsAt: schema.familyEvents.endsAt,
      location: schema.familyEvents.location,
      childDob: schema.children.dateOfBirth,
    })
    .from(schema.familyEvents)
    .leftJoin(schema.children, eq(schema.familyEvents.childId, schema.children.id))
    .where(
      and(
        eq(schema.familyEvents.familyId, family.id),
        isNull(schema.familyEvents.deletedAt),
        gte(schema.familyEvents.startsAt, windowStart),
        lte(schema.familyEvents.startsAt, windowEnd),
      ),
    )
    .orderBy(asc(schema.familyEvents.startsAt));

  const events = rows.map((row) => {
    const isTeen = row.childDob !== null && deriveStage(row.childDob, now) === 'teenager';
    return {
      id: row.id,
      title: isTeen ? TEEN_REDACTED_TITLE : row.title,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      location: isTeen ? null : row.location,
    };
  });

  return generateFamilyIcs(events, { now });
}
