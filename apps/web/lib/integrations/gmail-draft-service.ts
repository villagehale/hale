import { type Database, schema } from '@hale/db';
import {
  type GmailDraftMessage,
  createGmailDraft,
  deleteGmailDraft,
  updateGmailDraft,
} from '@hale/worker/gmail-drafts';
import { and, desc, eq } from 'drizzle-orm';
import { refreshAccessToken } from './google-oauth';
import { GMAIL_COMPOSE_SCOPE, googleWriteScopesEnabledFor } from './google-write-flag';
import { saveConnectionTokensById } from './store';
import { type OAuthTokens, decryptTokens } from './token-vault';

const EXPIRY_SKEW_MS = 60_000;
const DRAFT_IDS_KEY = 'haleGmailDraftIds';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export type GmailDraftOperation = 'create' | 'update' | 'delete';

export interface GmailDraftRequest {
  familyId: string;
  actorUserId: string;
  operation: GmailDraftOperation;
  body?: string;
  about?: string;
  draftId?: string;
  threadId?: string;
}

export type GmailDraftSkipReason =
  | 'flag_off'
  | 'scope_missing'
  | 'not_connected'
  | 'thread_unresolved'
  | 'not_ours'
  | 'token_unavailable'
  | 'missing_body'
  | 'missing_draft';

export type GmailDraftGate =
  | { status: 'proceed' }
  | { status: 'skipped'; reason: GmailDraftSkipReason };

export type GmailDraftCommit =
  | { status: 'drafted'; draftId: string; operation: GmailDraftOperation }
  | { status: 'skipped'; reason: GmailDraftSkipReason }
  | { status: 'failed'; reason: 'google_error' };

export interface GmailCandidate {
  id: string;
  userId: string | null;
  scopes: readonly string[];
  draftIds: readonly string[];
}

export interface GmailReplyContext {
  threadId: string;
  to: string;
  subject: string;
  inReplyTo?: string;
  references?: string;
}

export function replyToAddress(from: string): string {
  const angled = from.match(/<([^<>]+)>/);
  return (angled?.[1] ?? from).replace(/[\r\n]+/g, ' ').trim();
}

export function replySubject(subject: string): string {
  const clean = subject.replace(/[\r\n]+/g, ' ').trim();
  return /^re:/i.test(clean) ? clean : `Re: ${clean}`;
}

export function selectGmailConnection(input: {
  actorUserId: string;
  connections: readonly GmailCandidate[];
}): { ok: true; connection: GmailCandidate } | { ok: false; reason: GmailDraftSkipReason } {
  const mine = input.connections.filter((row) => row.userId === input.actorUserId);
  const scoped = mine.filter((row) => row.scopes.includes(GMAIL_COMPOSE_SCOPE));
  const chosen = scoped[0];
  if (!chosen) {
    return { ok: false, reason: mine.length === 0 ? 'not_connected' : 'scope_missing' };
  }
  return { ok: true, connection: chosen };
}

export interface GmailDraftDeps {
  /** A boolean, or a per-actor read so an allowlist can arm one user. */
  flagOn: boolean | ((actorUserId: string | null) => boolean);
  listGmail: (familyId: string) => Promise<readonly GmailCandidate[]>;
  accessToken: (integrationId: string) => Promise<string | null>;
  loadReply: (accessToken: string, request: GmailDraftRequest) => Promise<GmailReplyContext | null>;
  writeDraft: (args: {
    accessToken: string;
    operation: GmailDraftOperation;
    draftId?: string;
    message?: GmailDraftMessage;
  }) => Promise<{ draftId: string }>;
  rememberDraft: (
    integrationId: string,
    draftId: string,
    operation: GmailDraftOperation,
  ) => Promise<void>;
  audit: (entry: {
    familyId: string;
    actor: string;
    actionTaken: string;
    targetId: string;
    after: Record<string, unknown>;
  }) => Promise<void>;
}

function needsBody(operation: GmailDraftOperation): boolean {
  return operation === 'create' || operation === 'update';
}

async function ready(
  request: GmailDraftRequest,
  deps: GmailDraftDeps,
): Promise<
  | { status: 'skipped'; reason: GmailDraftSkipReason }
  | { status: 'ready'; connection: GmailCandidate; reply: GmailReplyContext | null }
> {
  const armed = typeof deps.flagOn === 'function' ? deps.flagOn(request.actorUserId) : deps.flagOn;
  if (!armed) return { status: 'skipped', reason: 'flag_off' };
  if (!request.actorUserId) return { status: 'skipped', reason: 'not_connected' };
  if (needsBody(request.operation) && !request.body?.trim()) {
    return { status: 'skipped', reason: 'missing_body' };
  }
  if (request.operation !== 'create' && !request.draftId) {
    return { status: 'skipped', reason: 'missing_draft' };
  }

  const connections = await deps.listGmail(request.familyId);
  const selected = selectGmailConnection({ actorUserId: request.actorUserId, connections });
  if (!selected.ok) return { status: 'skipped', reason: selected.reason };

  if (request.operation !== 'create') {
    const draftId = request.draftId ?? '';
    if (!selected.connection.draftIds.includes(draftId)) {
      return { status: 'skipped', reason: 'not_ours' };
    }
  }

  if (request.operation === 'delete') {
    return { status: 'ready', connection: selected.connection, reply: null };
  }

  const accessToken = await deps.accessToken(selected.connection.id);
  if (!accessToken) return { status: 'skipped', reason: 'token_unavailable' };
  const reply = await deps.loadReply(accessToken, request);
  if (!reply) return { status: 'skipped', reason: 'thread_unresolved' };
  return { status: 'ready', connection: selected.connection, reply };
}

export async function gateGmailDraft(
  request: GmailDraftRequest,
  deps: GmailDraftDeps,
): Promise<GmailDraftGate> {
  const resolved = await ready(request, deps);
  if (resolved.status === 'skipped') return resolved;
  return { status: 'proceed' };
}

export async function commitGmailDraft(
  request: GmailDraftRequest,
  deps: GmailDraftDeps,
): Promise<GmailDraftCommit> {
  const resolved = await ready(request, deps);
  if (resolved.status === 'skipped') return resolved;

  const accessToken = await deps.accessToken(resolved.connection.id);
  if (!accessToken) return { status: 'skipped', reason: 'token_unavailable' };

  const message: GmailDraftMessage | undefined = resolved.reply
    ? {
        to: resolved.reply.to,
        subject: resolved.reply.subject,
        body: request.body ?? '',
        threadId: resolved.reply.threadId,
        ...(resolved.reply.inReplyTo ? { inReplyTo: resolved.reply.inReplyTo } : {}),
        ...(resolved.reply.references ? { references: resolved.reply.references } : {}),
      }
    : undefined;

  try {
    const written = await deps.writeDraft({
      accessToken,
      operation: request.operation,
      ...(request.draftId ? { draftId: request.draftId } : {}),
      ...(message ? { message } : {}),
    });
    await deps.rememberDraft(resolved.connection.id, written.draftId, request.operation);
    await deps.audit({
      familyId: request.familyId,
      actor: request.actorUserId,
      actionTaken: 'integration.gmail_draft_written',
      targetId: resolved.connection.id,
      after: { op: request.operation },
    });
    return { status: 'drafted', draftId: written.draftId, operation: request.operation };
  } catch (err) {
    console.error(
      { op: request.operation, status: err instanceof Error ? err.name : 'unknown' },
      'gmail draft failed',
    );
    await deps.audit({
      familyId: request.familyId,
      actor: request.actorUserId,
      actionTaken: 'integration.gmail_draft_failed',
      targetId: resolved.connection.id,
      after: { op: request.operation },
    });
    return { status: 'failed', reason: 'google_error' };
  }
}

function draftIdsOf(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
  const raw = (metadata as Record<string, unknown>)[DRAFT_IDS_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === 'string');
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

interface GmailHeader {
  name?: string;
  value?: string;
}

function header(headers: readonly GmailHeader[], name: string): string | undefined {
  return headers.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value;
}

export function replyContextFromMessage(data: {
  threadId?: string;
  payload?: { headers?: GmailHeader[] };
}): GmailReplyContext | null {
  const threadId = data.threadId;
  const headers = data.payload?.headers ?? [];
  const from = header(headers, 'From');
  const subject = header(headers, 'Subject');
  if (!threadId || !from || !subject) return null;
  const messageId = header(headers, 'Message-ID') ?? header(headers, 'Message-Id');
  const references = header(headers, 'References');
  const to = replyToAddress(from);
  if (!to) return null;
  return {
    threadId,
    to,
    subject: replySubject(subject),
    ...(messageId ? { inReplyTo: messageId } : {}),
    ...(messageId
      ? { references: references ? `${references} ${messageId}`.trim() : messageId }
      : references
        ? { references }
        : {}),
  };
}

async function gmailGet(accessToken: string, url: string): Promise<unknown | null> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return null;
  return (await res.json()) as unknown;
}

export async function loadGmailReply(
  database: Database,
  accessToken: string,
  request: GmailDraftRequest,
): Promise<GmailReplyContext | null> {
  if (request.threadId) {
    const thread = (await gmailGet(
      accessToken,
      `${GMAIL_API}/threads/${encodeURIComponent(request.threadId)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Message-ID&metadataHeaders=References`,
    )) as { messages?: Array<{ threadId?: string; payload?: { headers?: GmailHeader[] } }> } | null;
    const last = thread?.messages?.at(-1);
    if (last) return replyContextFromMessage(last);
  }

  const rows = await database
    .select({ payload: schema.events.payload })
    .from(schema.events)
    .where(and(eq(schema.events.familyId, request.familyId), eq(schema.events.source, 'gmail')))
    .orderBy(desc(schema.events.receivedAt))
    .limit(20);

  const hint = request.about?.trim().toLowerCase();
  const match = rows.find((row) => {
    const payload = row.payload;
    if (!hint) return typeof payload.id === 'string';
    const haystack = [payload.subject, payload.from, payload.snippet]
      .filter((part): part is string => typeof part === 'string')
      .join('\n')
      .toLowerCase();
    return haystack.includes(hint) && typeof payload.id === 'string';
  });
  const messageId = typeof match?.payload.id === 'string' ? match.payload.id : null;
  if (!messageId) return null;

  const message = (await gmailGet(
    accessToken,
    `${GMAIL_API}/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Message-ID&metadataHeaders=References`,
  )) as { threadId?: string; payload?: { headers?: GmailHeader[] } } | null;
  return message ? replyContextFromMessage(message) : null;
}

function productionDeps(database: Database): GmailDraftDeps {
  return {
    flagOn: (actorUserId) => googleWriteScopesEnabledFor(actorUserId),
    listGmail: async (familyId) => {
      const rows = await database
        .select({
          id: schema.integrations.id,
          userId: schema.integrations.userId,
          scopes: schema.integrations.scopes,
          providerMetadata: schema.integrations.providerMetadata,
        })
        .from(schema.integrations)
        .where(
          and(
            eq(schema.integrations.familyId, familyId),
            eq(schema.integrations.provider, 'gmail'),
            eq(schema.integrations.status, 'active'),
          ),
        );
      return rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        scopes: row.scopes,
        draftIds: draftIdsOf(row.providerMetadata),
      }));
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
    loadReply: (accessToken, request) => loadGmailReply(database, accessToken, request),
    writeDraft: async ({ accessToken, operation, draftId, message }) => {
      if (operation === 'delete') {
        if (!draftId) throw new Error('gmail draft delete without an id');
        const deleted = await deleteGmailDraft(accessToken, draftId);
        return { draftId: deleted.draftId };
      }
      if (!message) throw new Error('gmail draft write without a message');
      if (operation === 'update') {
        if (!draftId) throw new Error('gmail draft update without an id');
        return updateGmailDraft(accessToken, draftId, message);
      }
      return createGmailDraft(accessToken, message);
    },
    rememberDraft: async (integrationId, draftId, operation) => {
      const rows = await database
        .select({ providerMetadata: schema.integrations.providerMetadata })
        .from(schema.integrations)
        .where(eq(schema.integrations.id, integrationId))
        .limit(1);
      const current = rows[0]?.providerMetadata ?? {};
      const meta = { ...current };
      const ids = draftIdsOf(meta).filter((id) => id !== draftId);
      if (operation !== 'delete') ids.push(draftId);
      meta[DRAFT_IDS_KEY] = ids.slice(-20);
      await database
        .update(schema.integrations)
        .set({ providerMetadata: meta, updatedAt: new Date() })
        .where(eq(schema.integrations.id, integrationId));
    },
    audit: async (entry) => {
      await database.insert(schema.auditLog).values({
        familyId: entry.familyId,
        actor: entry.actor,
        actionTaken: entry.actionTaken,
        targetTable: 'integrations',
        targetId: entry.targetId,
        after: entry.after,
      });
    },
  };
}

export function gateProductionGmailDraft(
  database: Database,
  request: GmailDraftRequest,
): Promise<GmailDraftGate> {
  return gateGmailDraft(request, productionDeps(database));
}

export function commitProductionGmailDraft(
  database: Database,
  request: GmailDraftRequest,
): Promise<GmailDraftCommit> {
  return commitGmailDraft(request, productionDeps(database));
}
