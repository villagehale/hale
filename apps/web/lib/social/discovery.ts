/**
 * VIL-378 — Instagram Business Discovery poll.
 *
 * Official Graph path only. Hale's own IG user id plus a user token reads
 * another professional account's public media. Personal accounts and Stories
 * are not available here. When the token or the IG user id is missing the
 * poll returns a named stub and does not call the network.
 *
 * Docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/business-discovery/
 */

export const META_GRAPH_VERSION = 'v21.0';
export const META_GRAPH_ACCESS_TOKEN_ENV = 'META_GRAPH_ACCESS_TOKEN';
export const META_IG_USER_ID_ENV = 'META_IG_USER_ID';

/** First poll records the newest id and extracts nothing. History is not a surprise alert. */
export const DISCOVERY_PAGE_LIMIT = 20;

export interface DiscoveryMedia {
  id: string;
  caption: string | null;
  timestamp: string;
  permalink: string;
  mediaType: string;
}

export type DiscoveryPoll =
  | { status: 'ok'; media: DiscoveryMedia[] }
  | { status: 'stub'; skipped: 'meta_not_configured' }
  | { status: 'error'; skipped: 'graph_error' };

export function metaBusinessDiscoveryConfigured(): boolean {
  return Boolean(process.env[META_GRAPH_ACCESS_TOKEN_ENV] && process.env[META_IG_USER_ID_ENV]);
}

export function businessDiscoveryUrl(igUserId: string, username: string): string {
  const handle = username.replace(/^@/, '');
  const fields = `business_discovery.username(${handle}){media.limit(${DISCOVERY_PAGE_LIMIT}){id,caption,timestamp,permalink,media_type}}`;
  return `https://graph.facebook.com/${META_GRAPH_VERSION}/${igUserId}?fields=${encodeURIComponent(fields)}`;
}

interface GraphMedia {
  id?: string;
  caption?: string;
  timestamp?: string;
  permalink?: string;
  media_type?: string;
}

function readMedia(body: unknown): DiscoveryMedia[] {
  if (!body || typeof body !== 'object') return [];
  const discovery = (body as { business_discovery?: { media?: { data?: GraphMedia[] } } })
    .business_discovery;
  const rows = discovery?.media?.data;
  if (!Array.isArray(rows)) return [];
  const media: DiscoveryMedia[] = [];
  for (const row of rows) {
    if (!row.id || !row.permalink || !row.timestamp) continue;
    media.push({
      id: row.id,
      caption: row.caption ?? null,
      timestamp: row.timestamp,
      permalink: row.permalink,
      mediaType: row.media_type ?? 'IMAGE',
    });
  }
  return media;
}

export async function pollBusinessDiscovery(
  username: string,
  deps: { fetch: typeof fetch } = { fetch },
): Promise<DiscoveryPoll> {
  const token = process.env[META_GRAPH_ACCESS_TOKEN_ENV];
  const igUserId = process.env[META_IG_USER_ID_ENV];
  if (!token || !igUserId) return { status: 'stub', skipped: 'meta_not_configured' };

  const url = new URL(businessDiscoveryUrl(igUserId, username));
  url.searchParams.set('access_token', token);
  try {
    const response = await deps.fetch(url, { method: 'GET' });
    if (!response.ok) return { status: 'error', skipped: 'graph_error' };
    const body: unknown = await response.json();
    return { status: 'ok', media: readMedia(body) };
  } catch {
    return { status: 'error', skipped: 'graph_error' };
  }
}

/**
 * Media Graph returns newest-first. Items strictly before the watermark are
 * new. A missing watermark establishes a baseline and extracts nothing.
 * A watermark that has scrolled off the page treats the whole page as new.
 */
export function diffNewMedia(
  media: DiscoveryMedia[],
  watermarkId: string | null,
): { fresh: DiscoveryMedia[]; nextWatermark: string | null } {
  const newest = media[0]?.id ?? watermarkId;
  if (!watermarkId) return { fresh: [], nextWatermark: newest };
  const at = media.findIndex((item) => item.id === watermarkId);
  const fresh = at === -1 ? media : media.slice(0, at);
  return { fresh, nextWatermark: newest };
}
