import type { AgentClient } from '@hale/agent';
import type { Database, GtaRegion, SocialCategory } from '@hale/db';
import {
  type DiscoveryMedia,
  type DiscoveryPoll,
  metaBusinessDiscoveryConfigured,
  pollBusinessDiscovery,
} from './discovery';
import { type ExtractedSocialSpot, extractSocialSpot } from './extract';
import { socialWatchlistEnabled } from './flag';
import { ARM_LEAD_MS, type SignupWatchStore, runSignupWatchTick } from './signup-watch';

/**
 * VIL-378 — hourly Business Discovery pass, plus the signup-open tick.
 *
 * The hourly cron is polite: at most SOCIAL_POLL_BATCH professional accounts,
 * and a source with no watermark only records the newest id. The signup tick
 * also runs from the every-minute drain so a registration that opens at an
 * arbitrary minute is read inside the two-minute window. Neither path writes
 * a parent-facing message.
 */

export const SOCIAL_POLL_BATCH = 25;

export interface DueSource {
  id: string;
  handle: string;
  displayName: string;
  category: SocialCategory;
  region: GtaRegion;
  geoFsa: string | null;
  lastMediaId: string | null;
}

export interface SpotInsert {
  sourceId: string;
  platformMediaId: string;
  permalink: string;
  rawCaption: string | null;
  mediaKind: 'feed' | 'reel';
  title: string;
  description: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  ageMin: number | null;
  ageMax: number | null;
  priceCents: number | null;
  capacity: number | null;
  registrationOpensAt: Date | null;
  registrationUrl: string | null;
  venueName: string | null;
  category: SocialCategory;
  region: GtaRegion;
  geoFsa: string | null;
  extractionConfidence: number;
  extractionMethod: 'llm' | 'placeholder';
  reviewStatus: 'auto' | 'needs_review';
  watchStatus: 'scheduled' | null;
  nextWakeAt: Date | null;
}

export interface SocialWatchPorts {
  now: Date;
  listDue: (limit: number) => Promise<DueSource[]>;
  poll: (username: string) => Promise<DiscoveryPoll>;
  extract: (caption: string, fallbackTitle: string) => Promise<ExtractedSocialSpot>;
  markPolled: (id: string, lastMediaId: string | null, polledAt: Date) => Promise<void>;
  insertSpot: (spot: SpotInsert) => Promise<{ id: string } | { skipped: 'duplicate' }>;
  signupStore: SignupWatchStore;
  fetchPage: (url: string) => Promise<{ ok: boolean; html: string }>;
  /** Named when the model is absent. The placeholder still runs. */
  llm: 'used' | 'not_configured';
}

export type SocialWatchSummary =
  | { skipped: 'flag_off' }
  | {
      signup: { checked: number; updated: number };
      poll:
        | { skipped: 'meta_not_configured' }
        | {
            considered: number;
            baseline: number;
            inserted: number;
            duplicates: number;
            errors: number;
            llm: 'used' | 'not_configured';
          };
    };

function mediaKind(mediaType: string): 'feed' | 'reel' {
  return mediaType.toUpperCase() === 'REEL' ? 'reel' : 'feed';
}

function toInsert(
  source: DueSource,
  media: DiscoveryMedia,
  extracted: ExtractedSocialSpot,
): SpotInsert {
  const opens = extracted.registrationOpensAt;
  const url = extracted.registrationUrl;
  const watching = Boolean(opens && url);
  return {
    sourceId: source.id,
    platformMediaId: media.id,
    permalink: media.permalink,
    rawCaption: media.caption,
    mediaKind: mediaKind(media.mediaType),
    title: extracted.title,
    description: extracted.description,
    startsAt: extracted.startsAt,
    endsAt: extracted.endsAt,
    ageMin: extracted.ageMin,
    ageMax: extracted.ageMax,
    priceCents: extracted.priceCents,
    capacity: extracted.capacity,
    registrationOpensAt: opens,
    registrationUrl: url,
    venueName: extracted.venueName,
    category: source.category,
    region: source.region,
    geoFsa: source.geoFsa,
    extractionConfidence: extracted.confidence,
    extractionMethod: extracted.method,
    reviewStatus: extracted.confidence >= 0.7 ? 'auto' : 'needs_review',
    watchStatus: watching ? 'scheduled' : null,
    nextWakeAt: watching && opens ? new Date(opens.getTime() - ARM_LEAD_MS) : null,
  };
}

export async function runSocialWatch(
  enabled: boolean,
  metaConfigured: boolean,
  ports: SocialWatchPorts,
): Promise<SocialWatchSummary> {
  if (!enabled) return { skipped: 'flag_off' };

  const signup = await runSignupWatchTick(ports.now, ports.signupStore, ports.fetchPage);
  if (!metaConfigured) {
    return {
      signup: { checked: signup.checked, updated: signup.results.length },
      poll: { skipped: 'meta_not_configured' },
    };
  }

  const due = await ports.listDue(SOCIAL_POLL_BATCH);
  let baseline = 0;
  let inserted = 0;
  let duplicates = 0;
  let errors = 0;
  for (const source of due) {
    const polled = await ports.poll(source.handle);
    if (polled.status !== 'ok') {
      errors += 1;
      await ports.markPolled(source.id, source.lastMediaId, ports.now);
      continue;
    }
    const newest = polled.media[0]?.id ?? source.lastMediaId;
    if (!source.lastMediaId) {
      baseline += 1;
      await ports.markPolled(source.id, newest, ports.now);
      continue;
    }
    const at = polled.media.findIndex((item) => item.id === source.lastMediaId);
    const fresh = at === -1 ? polled.media : polled.media.slice(0, at);
    for (const media of fresh) {
      const extracted = await ports.extract(media.caption ?? '', source.displayName);
      const saved = await ports.insertSpot(toInsert(source, media, extracted));
      if ('skipped' in saved) duplicates += 1;
      else inserted += 1;
    }
    await ports.markPolled(source.id, newest, ports.now);
  }

  return {
    signup: { checked: signup.checked, updated: signup.results.length },
    poll: {
      considered: due.length,
      baseline,
      inserted,
      duplicates,
      errors,
      llm: ports.llm,
    },
  };
}

export async function fetchRegistrationPage(url: string): Promise<{ ok: boolean; html: string }> {
  const response = await fetch(url, { method: 'GET', redirect: 'follow' });
  const html = (await response.text()).slice(0, 200_000);
  return { ok: response.ok, html };
}

/**
 * Cron entry. Flag off does not open a database connection for this feature.
 * A missing Meta token is a named stub; signup watches still tick.
 */
export async function runSocialWatchCron(
  database: Database,
  now: Date = new Date(),
): Promise<SocialWatchSummary> {
  if (!socialWatchlistEnabled()) return { skipped: 'flag_off' };
  const { drizzleSocialPorts } = await import('./store');
  const llmConfigured = Boolean(process.env.ANTHROPIC_API_KEY);
  let client: AgentClient | null = null;
  if (llmConfigured) client = await loadSweepClient();
  const ports = drizzleSocialPorts(database, now, {
    poll: (username) => pollBusinessDiscovery(username),
    extract: (caption, title) => extractSocialSpot(caption, title, { client }),
    fetchPage: fetchRegistrationPage,
    llm: client ? 'used' : 'not_configured',
  });
  return runSocialWatch(true, metaBusinessDiscoveryConfigured(), ports);
}

async function loadSweepClient() {
  const { CRON_SWEEP_CLIENT_OPTIONS, budgetedAnthropic } = await import('~/lib/pipeline/client');
  return budgetedAnthropic(CRON_SWEEP_CLIENT_OPTIONS);
}

/** Drain entry: signup watches only. The hourly cron owns Discovery. */
export async function runDueSignupWatches(
  database: Database,
  now: Date = new Date(),
): Promise<{ checked: number; updated: number }> {
  const { drizzleSignupStore } = await import('./store');
  const signup = await runSignupWatchTick(now, drizzleSignupStore(database), fetchRegistrationPage);
  return { checked: signup.checked, updated: signup.results.length };
}
