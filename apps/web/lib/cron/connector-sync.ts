import type { Database } from '@hale/db';
import { schema } from '@hale/db';
import type { IngestedEventPayload } from '@hale/tools-contracts';
import type PgBoss from 'pg-boss';
import { eq } from 'drizzle-orm';
import { refreshAccessToken } from '~/lib/integrations/google-oauth';
import { decryptTokens } from '~/lib/integrations/token-vault';
import {
  type ActiveConnectorConnection,
  type SweepableConnectorConnection,
  listActiveConnectorConnections,
  markConnectionError,
  saveConnectionCursor,
  saveConnectionTokensById,
} from '~/lib/integrations/store';
import { type GoogleFetch, type SyncDeps, syncConnection } from '~/lib/integrations/sync';
import { HOT_QUEUE_EXPIRE_SECONDS } from './drain';

/**
 * The connector poll sweep: fetch every active gcal/gmail/gdrive connection and
 * sync it (see lib/integrations/sync.ts). Read-only; each item becomes a redacted
 * events.ingested job HELD for approval downstream (rule #4).
 *
 * All I/O is injected so the loop is testable without a live DB/queue/Google. The
 * route builds the real deps via `connectorSyncDeps`.
 */

/** The real Google REST fetch: a bearer GET, normalized to the injectable shape. */
export const googleGetFetch: GoogleFetch = async (url, accessToken) => {
  const res = await fetch(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  return { ok: res.ok, status: res.status, json: () => res.json() };
};

/** SyncDeps minus childNames — the per-connection redaction list is supplied by
 * the loop from the connection's family. */
type BaseSyncDeps = Omit<SyncDeps, 'childNames'>;

export interface RunConnectorSyncDeps {
  listConnections: () => Promise<SweepableConnectorConnection[]>;
  /** Decrypt one row's token blob — called INSIDE the per-connection isolation so
   * a corrupted blob errs that row only. Injectable for tests. */
  decryptTokens: (enc: string) => ActiveConnectorConnection['tokens'];
  loadChildNames: (familyId: string) => Promise<string[]>;
  buildDeps: () => BaseSyncDeps;
  syncOne: (
    connection: ActiveConnectorConnection,
    deps: BaseSyncDeps,
    childNames: readonly string[],
  ) => Promise<void>;
}

export interface ConnectorSyncSummary {
  connections: number;
}

/**
 * Sync every active connector connection. A per-connection failure is isolated —
 * it never aborts the sweep — so one revoked/broken connection can't starve the
 * rest. syncConnection already marks its own row errored on failure; the guard
 * here is a belt-and-suspenders against an unexpected throw in child-name loading.
 */
export async function runConnectorSync(
  deps: RunConnectorSyncDeps,
): Promise<ConnectorSyncSummary> {
  const connections = await deps.listConnections();
  const base = deps.buildDeps();
  const childNamesByFamily = new Map<string, string[]>();

  for (const connection of connections) {
    try {
      let tokens: ActiveConnectorConnection['tokens'];
      try {
        tokens = deps.decryptTokens(connection.enc);
      } catch {
        // A tampered / key-rotation-leftover blob: err THIS row (so it stops
        // being swept as healthy) and move on — never reject the work-list.
        await base.markError(connection.id).catch(() => {});
        continue;
      }
      let childNames = childNamesByFamily.get(connection.familyId);
      if (!childNames) {
        childNames = await deps.loadChildNames(connection.familyId);
        childNamesByFamily.set(connection.familyId, childNames);
      }
      await deps.syncOne({ ...connection, tokens }, base, childNames);
    } catch {
      // Isolate: a failure here must not stop the remaining connections.
    }
  }
  return { connections: connections.length };
}

/** Wire the real DB + queue into the sync deps. */
export function connectorSyncDeps(database: Database, queue: PgBoss): RunConnectorSyncDeps {
  const enqueue = async (event: IngestedEventPayload): Promise<void> => {
    await queue.send('events.ingested', event, { expireInSeconds: HOT_QUEUE_EXPIRE_SECONDS });
  };
  const base: BaseSyncDeps = {
    googleFetch: googleGetFetch,
    enqueue,
    saveCursor: (id, meta) => saveConnectionCursor(database, id, meta),
    markError: (id) => markConnectionError(database, id),
    refreshTokens: (refreshToken) => refreshAccessToken(refreshToken),
    saveTokens: (id, tokens) => saveConnectionTokensById(database, id, tokens),
  };
  return {
    listConnections: () => listActiveConnectorConnections(database),
    decryptTokens,
    loadChildNames: (familyId) => loadFamilyChildNames(database, familyId),
    buildDeps: () => base,
    syncOne: (connection, deps, childNames) => syncConnection(connection, { ...deps, childNames }),
  };
}

/** The family's known child names, for rule-#1 redaction. Family-scoped. */
async function loadFamilyChildNames(database: Database, familyId: string): Promise<string[]> {
  const rows = await database
    .select({ name: schema.children.name })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  return rows.map((r) => r.name);
}
