import { type Database, schema } from '@hale/db';
import {
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  updateGoogleCalendarEvent,
} from '@hale/worker/google-calendar-api';
import type {
  GoogleCalendarOp,
  GoogleCalendarPlacement,
  GoogleCalendarPlacementRequest,
  GoogleCalendarSkipReason,
  GoogleCalendarSyncReport,
} from '@hale/worker/google-calendar-placement';
import { and, eq } from 'drizzle-orm';
import { refreshAccessToken } from './google-oauth';
import { CALENDAR_EVENTS_SCOPE, googleWriteScopesEnabled } from './google-write-flag';
import { saveConnectionTokensById } from './store';
import { type OAuthTokens, decryptTokens } from './token-vault';

const EXPIRY_SKEW_MS = 60_000;

export interface GcalCandidate {
  id: string;
  userId: string | null;
  scopes: readonly string[];
}

export interface PlacedEventRow {
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  location: string | null;
  placedGoogleEventId: string | null;
  placedGoogleIntegrationId: string | null;
}

/**
 * Which connection may write, if any. Update and delete require the id Hale
 * stored. They never pick a different calendar, and they never touch an event
 * this column does not name.
 */
export function selectGcalConnection(input: {
  op: GoogleCalendarOp;
  actorUserId: string | null;
  placedGoogleEventId: string | null;
  placedGoogleIntegrationId: string | null;
  connections: readonly GcalCandidate[];
}): { ok: true; integrationId: string } | { ok: false; reason: GoogleCalendarSkipReason } {
  if (input.op === 'update' || input.op === 'delete') {
    if (!input.placedGoogleEventId || !input.placedGoogleIntegrationId) {
      return { ok: false, reason: 'not_ours' };
    }
    const owned = input.connections.find((row) => row.id === input.placedGoogleIntegrationId);
    if (!owned) return { ok: false, reason: 'not_connected' };
    if (!owned.scopes.includes(CALENDAR_EVENTS_SCOPE))
      return { ok: false, reason: 'scope_missing' };
    return { ok: true, integrationId: owned.id };
  }

  if (input.placedGoogleEventId) return { ok: false, reason: 'already_present' };

  const scoped = input.connections.filter((row) => row.scopes.includes(CALENDAR_EVENTS_SCOPE));
  if (input.actorUserId) {
    const mine = input.connections.filter((row) => row.userId === input.actorUserId);
    const mineScoped = mine.filter((row) => row.scopes.includes(CALENDAR_EVENTS_SCOPE));
    const chosen = mineScoped[0];
    if (!chosen) {
      return { ok: false, reason: mine.length === 0 ? 'not_connected' : 'scope_missing' };
    }
    return { ok: true, integrationId: chosen.id };
  }
  if (scoped.length === 0) {
    return {
      ok: false,
      reason: input.connections.length === 0 ? 'not_connected' : 'scope_missing',
    };
  }
  if (scoped.length > 1) return { ok: false, reason: 'ambiguous' };
  const only = scoped[0];
  if (!only) return { ok: false, reason: 'not_connected' };
  return { ok: true, integrationId: only.id };
}

export interface GooglePlacementDeps {
  flagOn: boolean;
  loadEvent: (familyId: string, familyEventId: string) => Promise<PlacedEventRow | null>;
  listGcal: (familyId: string) => Promise<readonly GcalCandidate[]>;
  accessToken: (integrationId: string) => Promise<string | null>;
  write: (args: {
    accessToken: string;
    op: GoogleCalendarOp;
    googleEventId: string | null;
    event: PlacedEventRow;
  }) => Promise<{ googleEventId: string }>;
  storePlaced: (
    familyEventId: string,
    googleEventId: string,
    integrationId: string,
  ) => Promise<void>;
  audit: (entry: {
    familyId: string;
    actor: string;
    actionTaken: string;
    targetId: string;
    after: Record<string, unknown>;
  }) => Promise<void>;
}

export async function applyPlacedGoogleCalendar(
  request: GoogleCalendarPlacementRequest,
  deps: GooglePlacementDeps,
): Promise<GoogleCalendarSyncReport> {
  if (!deps.flagOn) return { status: 'skipped', reason: 'flag_off' };

  const event = await deps.loadEvent(request.familyId, request.familyEventId);
  if (!event) return { status: 'skipped', reason: 'event_missing' };

  const connections = await deps.listGcal(request.familyId);
  const selected = selectGcalConnection({
    op: request.op,
    actorUserId: request.actorUserId,
    placedGoogleEventId: event.placedGoogleEventId,
    placedGoogleIntegrationId: event.placedGoogleIntegrationId,
    connections,
  });
  if (!selected.ok) return { status: 'skipped', reason: selected.reason };

  const accessToken = await deps.accessToken(selected.integrationId);
  if (!accessToken) return { status: 'skipped', reason: 'token_unavailable' };

  const actor = request.actorUserId ?? 'system';
  try {
    const written = await deps.write({
      accessToken,
      op: request.op,
      googleEventId: event.placedGoogleEventId,
      event,
    });
    if (request.op === 'create') {
      await deps.storePlaced(event.id, written.googleEventId, selected.integrationId);
    }
    await deps.audit({
      familyId: request.familyId,
      actor,
      actionTaken: 'integration.google_calendar_written',
      targetId: event.id,
      after: { op: request.op, status: 'written' },
    });
    return { status: 'written', googleEventId: written.googleEventId };
  } catch (err) {
    console.error(
      { op: request.op, status: err instanceof Error ? err.name : 'unknown' },
      'google calendar placement failed',
    );
    await deps.audit({
      familyId: request.familyId,
      actor,
      actionTaken: 'integration.google_calendar_failed',
      targetId: event.id,
      after: { op: request.op, status: 'failed' },
    });
    return { status: 'failed', reason: 'google_error' };
  }
}

async function freshAccessToken(
  database: Database,
  integrationId: string,
  tokens: OAuthTokens,
): Promise<string | null> {
  const expiring =
    tokens.expiresAt !== undefined && tokens.expiresAt - EXPIRY_SKEW_MS <= Date.now();
  if (!expiring) return tokens.accessToken;
  if (!tokens.refreshToken) return null;
  try {
    const refreshed = await refreshAccessToken(tokens.refreshToken);
    const merged: OAuthTokens = {
      ...refreshed,
      refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
    };
    await saveConnectionTokensById(database, integrationId, merged);
    return merged.accessToken;
  } catch {
    return null;
  }
}

export function createGoogleCalendarPlacement(database: Database): GoogleCalendarPlacement {
  return {
    sync: (request) =>
      applyPlacedGoogleCalendar(request, {
        flagOn: googleWriteScopesEnabled(),
        loadEvent: async (familyId, familyEventId) => {
          const rows = await database
            .select({
              id: schema.familyEvents.id,
              title: schema.familyEvents.title,
              startsAt: schema.familyEvents.startsAt,
              endsAt: schema.familyEvents.endsAt,
              location: schema.familyEvents.location,
              placedGoogleEventId: schema.familyEvents.placedGoogleEventId,
              placedGoogleIntegrationId: schema.familyEvents.placedGoogleIntegrationId,
            })
            .from(schema.familyEvents)
            .where(
              and(
                eq(schema.familyEvents.id, familyEventId),
                eq(schema.familyEvents.familyId, familyId),
              ),
            )
            .limit(1);
          return rows[0] ?? null;
        },
        listGcal: async (familyId) => {
          const rows = await database
            .select({
              id: schema.integrations.id,
              userId: schema.integrations.userId,
              scopes: schema.integrations.scopes,
            })
            .from(schema.integrations)
            .where(
              and(
                eq(schema.integrations.familyId, familyId),
                eq(schema.integrations.provider, 'gcal'),
                eq(schema.integrations.status, 'active'),
              ),
            );
          return rows.map((row) => ({ id: row.id, userId: row.userId, scopes: row.scopes }));
        },
        accessToken: async (integrationId) => {
          const rows = await database
            .select({ enc: schema.integrations.oauthTokensEncrypted })
            .from(schema.integrations)
            .where(eq(schema.integrations.id, integrationId))
            .limit(1);
          const enc = rows[0]?.enc;
          if (!enc) return null;
          try {
            return await freshAccessToken(database, integrationId, decryptTokens(enc));
          } catch {
            return null;
          }
        },
        write: async ({ accessToken, op, googleEventId, event }) => {
          const body = {
            summary: event.title,
            location: event.location,
            startsAt: event.startsAt,
            endsAt: event.endsAt,
          };
          if (op === 'create') return createGoogleCalendarEvent(accessToken, body);
          if (!googleEventId) throw new Error('google calendar update without an id Hale created');
          if (op === 'update') return updateGoogleCalendarEvent(accessToken, googleEventId, body);
          const deleted = await deleteGoogleCalendarEvent(accessToken, googleEventId);
          return { googleEventId: deleted.googleEventId };
        },
        storePlaced: async (familyEventId, googleEventId, integrationId) => {
          await database
            .update(schema.familyEvents)
            .set({
              placedGoogleEventId: googleEventId,
              placedGoogleIntegrationId: integrationId,
            })
            .where(eq(schema.familyEvents.id, familyEventId));
        },
        audit: async (entry) => {
          await database.insert(schema.auditLog).values({
            familyId: entry.familyId,
            actor: entry.actor,
            actionTaken: entry.actionTaken,
            targetTable: 'family_events',
            targetId: entry.targetId,
            after: entry.after,
          });
        },
      }),
  };
}
