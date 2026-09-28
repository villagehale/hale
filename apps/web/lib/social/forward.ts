import { createHash } from 'node:crypto';
import type { Database } from '@hale/db';
import { schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';

/**
 * VIL-378 — parent forward.
 *
 * Stories, Xiaohongshu notes, WeChat posts, and Facebook group flyers are not
 * polled. A parent can hand Hale a link or a screenshot URL. That queues an
 * extraction. It does not reply, and it does not scrape the network.
 */

const SOCIAL_HOST =
  /(?:instagram\.com|facebook\.com|fb\.watch|fb\.com|xhslink\.com|xiaohongshu\.com)/i;
const IMAGE_EXT = /\.(?:png|jpe?g|webp|gif)(?:\?|$)/i;
const URL_RE = /https?:\/\/[^\s)<>"]+/i;

export type ForwardKind = 'link' | 'screenshot';

export interface DetectedForward {
  url: string;
  kind: ForwardKind;
}

export function detectSocialForward(text: string): DetectedForward | null {
  const match = URL_RE.exec(text);
  if (!match) return null;
  const url = match[0];
  const image = IMAGE_EXT.test(url);
  const social = SOCIAL_HOST.test(url);
  if (!image && !social) return null;
  return { url, kind: image ? 'screenshot' : 'link' };
}

export function forwardMediaId(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 32);
}

export interface ForwardStore {
  ensureSource(input: {
    handle: string;
    displayName: string;
    profileUrl: string;
  }): Promise<{ id: string; region: 'toronto' }>;
  insertSpot(input: {
    sourceId: string;
    familyId: string;
    platformMediaId: string;
    permalink: string;
    mediaKind: 'story_forward' | 'screenshot';
    title: string;
  }): Promise<{ id: string }>;
}

export async function queueParentForward(
  store: ForwardStore,
  input: { familyId: string; url: string; kind: ForwardKind },
): Promise<{ status: 'queued'; spotId: string }> {
  const source = await store.ensureSource({
    handle: `forward-${input.familyId}`,
    displayName: 'Parent forwards',
    profileUrl: input.url,
  });
  const spot = await store.insertSpot({
    sourceId: source.id,
    familyId: input.familyId,
    platformMediaId: forwardMediaId(input.url),
    permalink: input.url,
    mediaKind: input.kind === 'screenshot' ? 'screenshot' : 'story_forward',
    title: input.kind === 'screenshot' ? 'Forwarded screenshot' : 'Forwarded link',
  });
  return { status: 'queued', spotId: spot.id };
}

export function drizzleForwardStore(database: Database): ForwardStore {
  return {
    async ensureSource(input) {
      const existing = await database
        .select({ id: schema.watchedSources.id })
        .from(schema.watchedSources)
        .where(
          and(
            eq(schema.watchedSources.platform, 'parent_forward'),
            eq(schema.watchedSources.handle, input.handle),
          ),
        )
        .limit(1);
      const found = existing[0];
      if (found) return { id: found.id, region: 'toronto' };
      const inserted = await database
        .insert(schema.watchedSources)
        .values({
          platform: 'parent_forward',
          handle: input.handle,
          displayName: input.displayName,
          profileUrl: input.profileUrl,
          accountType: 'unknown',
          category: 'T9',
          region: 'toronto',
          languages: ['en'],
          priority: 3,
          pollCadenceMinutes: 0,
          ingestMethod: 'parent_forward',
          tosRisk: 'official',
          active: false,
          notes: 'Created when a parent forwarded a link or screenshot. Not polled.',
        })
        .returning({ id: schema.watchedSources.id });
      const row = inserted[0];
      if (!row) throw new Error('parent forward source insert returned no row');
      return { id: row.id, region: 'toronto' };
    },
    async insertSpot(input) {
      const inserted = await database
        .insert(schema.socialSpots)
        .values({
          sourceId: input.sourceId,
          familyId: input.familyId,
          platformMediaId: input.platformMediaId,
          permalink: input.permalink,
          mediaKind: input.mediaKind,
          title: input.title,
          category: 'T9',
          region: 'toronto',
          extractionConfidence: 0,
          extractionMethod: 'placeholder',
          reviewStatus: 'needs_review',
        })
        .onConflictDoNothing({
          target: [schema.socialSpots.sourceId, schema.socialSpots.platformMediaId],
        })
        .returning({ id: schema.socialSpots.id });
      const created = inserted[0];
      if (created) return created;
      const again = await database
        .select({ id: schema.socialSpots.id })
        .from(schema.socialSpots)
        .where(
          and(
            eq(schema.socialSpots.sourceId, input.sourceId),
            eq(schema.socialSpots.platformMediaId, input.platformMediaId),
          ),
        )
        .limit(1);
      const existing = again[0];
      if (!existing) throw new Error('parent forward spot insert returned no row');
      return existing;
    },
  };
}

export async function resolveForwardFamily(
  database: Database,
  senderHandle: string,
): Promise<{ familyId: string; userId: string } | null> {
  const e164 = normalizePhoneE164(senderHandle);
  if (!e164) return null;
  const rows = await database
    .select({
      familyId: schema.parentChannels.familyId,
      userId: schema.parentChannels.userId,
    })
    .from(schema.parentChannels)
    .where(
      and(
        eq(schema.parentChannels.phoneE164Hash, phoneBlindIndex(e164)),
        isNull(schema.parentChannels.revokedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

const FAMILY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ParentForwardResult =
  | { status: 'queued'; spotId: string }
  | { status: 'skipped'; skipped: 'invalid_body' | 'not_a_forward' };

/**
 * Queues a parent-supplied link or screenshot for extraction. Does not fetch
 * the URL. Stories, Xiaohongshu, and WeChat stay out of the poller; a parent
 * may still hand one in.
 */
export async function acceptParentForward(
  store: ForwardStore,
  body: unknown,
): Promise<ParentForwardResult> {
  if (!body || typeof body !== 'object') return { status: 'skipped', skipped: 'invalid_body' };
  const familyId = (body as { familyId?: unknown }).familyId;
  const url = (body as { url?: unknown }).url;
  if (typeof familyId !== 'string' || !FAMILY_UUID.test(familyId) || typeof url !== 'string') {
    return { status: 'skipped', skipped: 'invalid_body' };
  }
  const detected = detectSocialForward(url);
  if (!detected) return { status: 'skipped', skipped: 'not_a_forward' };
  return queueParentForward(store, { familyId, url: detected.url, kind: detected.kind });
}

export type SocialForwardOutcome =
  | { status: 'skipped'; skipped: 'not_a_forward' | 'family_unresolved' | 'invalid_number' }
  | { status: 'queued'; spotId: string };

/**
 * Linq/iMessage side door. Called only when the watchlist flag is on. A miss
 * is named and never changes the reply the parent was already going to get.
 */
export async function considerSocialForward(
  database: Database,
  input: { text: string; senderHandle: string },
): Promise<SocialForwardOutcome> {
  const detected = detectSocialForward(input.text);
  if (!detected) return { status: 'skipped', skipped: 'not_a_forward' };
  const e164 = normalizePhoneE164(input.senderHandle);
  if (!e164) return { status: 'skipped', skipped: 'invalid_number' };
  const family = await resolveForwardFamily(database, e164);
  if (!family) return { status: 'skipped', skipped: 'family_unresolved' };
  const queued = await queueParentForward(drizzleForwardStore(database), {
    familyId: family.familyId,
    url: detected.url,
    kind: detected.kind,
  });
  return queued;
}
