import type { schema } from '@hale/db';

export type IntegrationProvider = (typeof schema.integrations.$inferSelect)['provider'];
export type IntegrationStatus = (typeof schema.integrations.$inferSelect)['status'];

/**
 * The connected-status of one catalogued source: whether the family has an
 * integration row for it, and that row's live status. A source with no row is
 * absent from the map entirely (the page treats "absent" as not-yet-connected).
 */
export type ConnectedSourceMap = Partial<Record<IntegrationProvider, IntegrationStatus>>;

/**
 * Folds a family's integration rows into a provider→status map. When two rows
 * share a provider (a family-wide leg plus a per-parent leg), an 'active' row
 * wins so the page shows the source as connected if any leg is live.
 */
export function toConnectedSourceMap(
  rows: ReadonlyArray<{ provider: IntegrationProvider; status: IntegrationStatus }>,
): ConnectedSourceMap {
  const map: ConnectedSourceMap = {};
  for (const row of rows) {
    if (map[row.provider] === 'active') continue;
    map[row.provider] = row.status;
  }
  return map;
}

/** A catalogued source is connected only when its integration row is live. */
export function isSourceConnected(
  map: ConnectedSourceMap,
  provider: IntegrationProvider | null,
): boolean {
  return provider !== null && map[provider] === 'active';
}
