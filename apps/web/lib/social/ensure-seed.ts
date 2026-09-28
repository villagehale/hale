import type { Database } from '@hale/db';
import { schema } from '@hale/db';
import { sql } from 'drizzle-orm';
import { SOCIAL_SEED, SOCIAL_SEED_TOS_RISK, profileUrlFor, type SocialSeedSource } from './seed';

/**
 * VIL-378 — load SOCIAL_SEED into watched_sources.
 *
 * Migration 0135 creates the tables and leaves them empty. This upsert is the
 * deliberate insert: keyed on (platform, handle), refreshing display and
 * metadata, and leaving last_polled_at / last_media_id alone so a deploy
 * cannot wipe a poll watermark.
 */

const SEED_LANGUAGES = ['en'] as const;
const SEED_PRIORITY = 2;
const SEED_POLL_CADENCE_MINUTES = 720;

function accountTypeFor(source: SocialSeedSource): 'page' | 'business' {
  if (source.platform === 'facebook_page') return 'page';
  return 'business';
}

function ingestMethodFor(
  source: SocialSeedSource,
): 'graph_business_discovery' | 'fb_ppca' | 'manual' {
  if (source.platform === 'instagram') return 'graph_business_discovery';
  if (source.platform === 'facebook_page') return 'fb_ppca';
  return 'manual';
}

function seedRow(source: SocialSeedSource, updatedAt: Date) {
  return {
    platform: source.platform,
    handle: source.handle,
    displayName: source.displayName,
    profileUrl: profileUrlFor(source),
    accountType: accountTypeFor(source),
    category: source.category,
    region: source.region,
    geoCity: source.city,
    geoFsa: source.fsa,
    languages: [...SEED_LANGUAGES],
    priority: SEED_PRIORITY,
    pollCadenceMinutes: SEED_POLL_CADENCE_MINUTES,
    ingestMethod: ingestMethodFor(source),
    tosRisk: SOCIAL_SEED_TOS_RISK,
    active: source.active,
    notes: source.note,
    updatedAt,
  };
}

export async function ensureSocialSeed(database: Database): Promise<{ upserted: number }> {
  if (SOCIAL_SEED.length === 0) return { upserted: 0 };
  const updatedAt = new Date();
  const written = await database
    .insert(schema.watchedSources)
    .values(SOCIAL_SEED.map((source) => seedRow(source, updatedAt)))
    .onConflictDoUpdate({
      target: [schema.watchedSources.platform, schema.watchedSources.handle],
      set: {
        displayName: sql`excluded.display_name`,
        profileUrl: sql`excluded.profile_url`,
        accountType: sql`excluded.account_type`,
        category: sql`excluded.category`,
        region: sql`excluded.region`,
        geoCity: sql`excluded.geo_city`,
        geoFsa: sql`excluded.geo_fsa`,
        languages: sql`excluded.languages`,
        priority: sql`excluded.priority`,
        pollCadenceMinutes: sql`excluded.poll_cadence_minutes`,
        ingestMethod: sql`excluded.ingest_method`,
        tosRisk: sql`excluded.tos_risk`,
        active: sql`excluded.active`,
        notes: sql`excluded.notes`,
        updatedAt,
      },
    })
    .returning({ id: schema.watchedSources.id });
  return { upserted: written.length };
}
