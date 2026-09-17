import type { Database } from '@hale/db';
import { schema } from '@hale/db';
import type { IngestedEventPayload } from '@hale/tools-contracts';
import { ageInMonths } from '@hale/types';
import type PgBoss from 'pg-boss';
import { eq } from 'drizzle-orm';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { assertProactiveSendAllowed, buildOutboundGatePorts } from '~/lib/channel/outbound-gate';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { createTwilioTransport } from '~/lib/channel/twilio/transport';
import { refreshAccessToken } from '~/lib/integrations/google-oauth';
import {
  type EmailAlertCounts,
  type EmailAlertPorts,
  alertParentForGmailSweep,
  emptyEmailAlertCounts,
} from '~/lib/integrations/email-alert';
import { decryptTokens } from '~/lib/integrations/token-vault';
import {
  type ActiveConnectorConnection,
  type SweepableConnectorConnection,
  listActiveConnectorConnections,
  markConnectionError,
  saveConnectionCursor,
  saveConnectionTokensById,
} from '~/lib/integrations/store';
import { pipelineClient } from '~/lib/pipeline/client';
import {
  type FamilyChildRef,
  classifyChildEventEmail,
  fetchGmailMessageBody,
  loadCorrelationCandidates,
} from '~/lib/sentinel';
import {
  type GmailAlertBatch,
  type GoogleFetch,
  type SyncConnectionResult,
  type SyncDeps,
  syncConnection,
} from '~/lib/integrations/sync';
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
  ) => Promise<SyncConnectionResult>;
}

export interface ConnectorSyncSummary {
  connections: number;
  /** One count per named email-alert outcome (rule #11). Every envelope the sweep looked
   * at lands in exactly one bucket, including the ones it declined to look at — a sweep
   * that alerted nobody has to be able to say WHY, and "dark" reads very differently from
   * "not_parenting". */
  emailAlerts: EmailAlertCounts;
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
  const emailAlerts = emptyEmailAlertCounts();

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
      const result = await deps.syncOne({ ...connection, tokens }, base, childNames);
      for (const outcome of result.emailAlerts) emailAlerts[outcome] += 1;
    } catch {
      // Isolate: a failure here must not stop the remaining connections.
    }
  }
  return { connections: connections.length, emailAlerts };
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
    alertGmailEnvelopes: (batch) => alertGmailSweep(database, batch),
  };
  return {
    listConnections: () => listActiveConnectorConnections(database),
    decryptTokens,
    loadChildNames: (familyId) => loadFamilyChildNames(database, familyId),
    buildDeps: () => base,
    syncOne: (connection, deps, childNames) => syncConnection(connection, { ...deps, childNames }),
  };
}

/** The sweep's half of the email alert: one connection's Gmail envelopes, the real
 * sentinel, and the real outbound chokepoint. Everything below this line is
 * production-only I/O, which is why the alert module itself takes ports. */
function alertGmailSweep(database: Database, batch: GmailAlertBatch) {
  return alertParentForGmailSweep(
    database,
    {
      familyId: batch.connection.familyId,
      parentUserId: batch.connection.userId,
      integrationId: batch.connection.id,
      seeding: batch.seeding,
      envelopes: batch.envelopes,
      now: new Date(),
    },
    emailAlertPorts(database, batch.connection.familyId, batch.accessToken),
  );
}

/** The real ports. The family's children and known occasions are read ONCE per
 * connection rather than once per message: ten messages would otherwise be twenty
 * queries answering the same two questions. */
function emailAlertPorts(
  database: Database,
  familyId: string,
  accessToken: string,
): EmailAlertPorts {
  let context: Promise<{
    children: FamilyChildRef[];
    candidates: Awaited<ReturnType<typeof loadCorrelationCandidates>>;
  }>;
  const loadContext = () => {
    context ??= Promise.all([
      loadFamilyChildRefs(database, familyId),
      loadCorrelationCandidates(database, familyId),
    ]).then(([children, candidates]) => ({ children, candidates }));
    return context;
  };

  return {
    classify: async (envelope, familyTimezone) => {
      const { children, candidates } = await loadContext();
      return classifyChildEventEmail(envelope, {
        client: pipelineClient(),
        children,
        fetchBody: (messageId) => fetchGmailMessageBody(messageId, accessToken, googleGetFetch),
        familyTimezone,
        correlationCandidates: candidates,
      });
    },
    gate: (request) => assertProactiveSendAllowed(request, buildOutboundGatePorts(database)),
    resolvePhone: resolveSendablePhone,
    transport: createTwilioTransport(),
    threadMessage: threadProactiveMessage,
    // The SAME reader the gate judges quiet hours with, so the hour in the text and the
    // hour the gate refused at can never disagree.
    timeZone: (parentUserId) => buildOutboundGatePorts(database).parentTimeZone(parentUserId),
  };
}

/** This family's children with their ages — the sentinel's matching context (rule #1:
 * one family's children only). */
async function loadFamilyChildRefs(
  database: Database,
  familyId: string,
): Promise<FamilyChildRef[]> {
  const rows = await database
    .select({
      id: schema.children.id,
      name: schema.children.name,
      dateOfBirth: schema.children.dateOfBirth,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    ageInMonths: ageInMonths(row.dateOfBirth),
  }));
}

/** The family's known child names, for rule-#1 redaction. Family-scoped. */
async function loadFamilyChildNames(database: Database, familyId: string): Promise<string[]> {
  const rows = await database
    .select({ name: schema.children.name })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  return rows.map((r) => r.name);
}
