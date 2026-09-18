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
  type CalendarAlertCounts,
  type CalendarAlertPorts,
  alertParentForCalendarChanges,
  emptyCalendarAlertCounts,
} from '~/lib/integrations/calendar-alert';
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
  type CalendarAlertBatch,
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
  /** The same, for the calendar. Its own tally rather than a shared one: the two
   * connectors fail in different ways, and a sweep where every calendar change is
   * `outside_window` reads nothing like one where every email is `not_parenting`. */
  calendarAlerts: CalendarAlertCounts;
  /** Calendar items no sweep could key, because Google sent them with no `id`. They have
   * no alert outcome to count — they never reached the alert path — so without this line
   * a page of un-keyable items reads as a quiet week (rule #11). */
  calendarDroppedNoId: number;
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
  const calendarAlerts = emptyCalendarAlertCounts();
  let calendarDroppedNoId = 0;

  for (const connection of connections) {
    try {
      let tokens: ActiveConnectorConnection['tokens'];
      try {
        tokens = deps.decryptTokens(connection.enc);
      } catch {
        // A tampered / key-rotation-leftover blob: err THIS row (so it stops
        // being swept as healthy) and move on — never reject the work-list. It
        // carries its OWN code: no Google call was ever made, so it must not read
        // like a request Hale can retry its way out of (rule #11).
        console.error(
          { integrationId: connection.id, provider: connection.provider, code: 'decrypt_failed' },
          'connector sync: stored token blob unreadable',
        );
        await base.markError(connection.id, 'decrypt_failed').catch(() => {});
        continue;
      }
      let childNames = childNamesByFamily.get(connection.familyId);
      if (!childNames) {
        childNames = await deps.loadChildNames(connection.familyId);
        childNamesByFamily.set(connection.familyId, childNames);
      }
      const result = await deps.syncOne({ ...connection, tokens }, base, childNames);
      for (const outcome of result.emailAlerts) emailAlerts[outcome] += 1;
      for (const outcome of result.calendarAlerts) calendarAlerts[outcome] += 1;
      calendarDroppedNoId += result.calendarDroppedNoId;
    } catch {
      // Isolate: a failure here must not stop the remaining connections.
    }
  }
  return { connections: connections.length, emailAlerts, calendarAlerts, calendarDroppedNoId };
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
    markError: (id, code) => markConnectionError(database, id, code),
    refreshTokens: (refreshToken) => refreshAccessToken(refreshToken),
    saveTokens: (id, tokens) => saveConnectionTokensById(database, id, tokens),
    alertGmailEnvelopes: (batch) => alertGmailSweep(database, batch),
    alertCalendarChanges: (batch) => alertCalendarSweep(database, batch),
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

/** The sweep's half of the calendar alert: one connection's raw changes, the real
 * outbound chokepoint, no classifier (the calendar is the parent's own). */
function alertCalendarSweep(database: Database, batch: CalendarAlertBatch) {
  return alertParentForCalendarChanges(
    database,
    {
      familyId: batch.connection.familyId,
      parentUserId: batch.connection.userId,
      integrationId: batch.connection.id,
      seeding: batch.seeding,
      changes: batch.changes,
      now: new Date(),
    },
    proactiveSendPorts(database),
  );
}

/**
 * Everything a connector alert needs to ask permission and speak — the chokepoint, the
 * number, the wire, the thread and the clock.
 *
 * ONE copy, spread into the email alert's ports below. Two literals would be two places
 * a `gate:` line could drift, and the failure that drift produces is silent: an alert
 * class wired to something that is not `assertProactiveSendAllowed` still sends.
 */
function proactiveSendPorts(database: Database): CalendarAlertPorts {
  return {
    gate: (request) => assertProactiveSendAllowed(request, buildOutboundGatePorts(database)),
    resolvePhone: resolveSendablePhone,
    transport: createTwilioTransport(),
    threadMessage: threadProactiveMessage,
    // The SAME reader the gate judges quiet hours with, so the hour in the text and the
    // hour the gate refused at can never disagree.
    timeZone: (parentUserId) => buildOutboundGatePorts(database).parentTimeZone(parentUserId),
  };
}

/** The real ports. The family's children and known occasions are read ONCE per
 * connection rather than once per message: ten messages would otherwise be twenty
 * queries answering the same two questions. */
function emailAlertPorts(
  database: Database,
  familyId: string,
  accessToken: string,
): EmailAlertPorts {
  let context:
    | {
        children: FamilyChildRef[];
        candidates: Awaited<ReturnType<typeof loadCorrelationCandidates>>;
      }
    | undefined;
  // The RESULT is cached, never the promise: a cached rejection would turn one bad read
  // into `classifier_failed` for all ten of this sweep's messages. The loop below is
  // sequential, so there is no second caller to race the first.
  const loadContext = async () => {
    if (context === undefined) {
      const [children, candidates] = await Promise.all([
        loadFamilyChildRefs(database, familyId),
        loadCorrelationCandidates(database, familyId),
      ]);
      context = { children, candidates };
    }
    return context;
  };

  return {
    ...proactiveSendPorts(database),
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
