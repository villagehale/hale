import { createHash, timingSafeEqual } from 'node:crypto';
import { type JWTVerifyGetKey, createRemoteJWKSet, jwtVerify } from 'jose';
import type { PushEnv } from './google-push-flag';

/**
 * Authenticating a Google push, and nothing else.
 *
 * Calendar `events.watch` is not Pub/Sub. Google POSTs the channel id, the token we
 * chose, and the resource id in headers. Gmail `users.watch` publishes to Pub/Sub,
 * and the push subscription proves itself with an OIDC JWT in `Authorization`.
 * Neither body is an email or an event — ingesting it would put a notification
 * envelope in front of the classifier. Verification here only decides whether the
 * existing sync may run.
 */

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'] as const;
const GOOGLE_CERTS = 'https://www.googleapis.com/oauth2/v3/certs';

export function hashChannelToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time compare of a presented channel token against the stored SHA-256. */
export function channelTokenMatches(token: string, tokenHash: string): boolean {
  let presented: Buffer;
  let stored: Buffer;
  try {
    presented = Buffer.from(hashChannelToken(token), 'hex');
    stored = Buffer.from(tokenHash, 'hex');
  } catch {
    return false;
  }
  if (presented.length === 0 || presented.length !== stored.length) return false;
  return timingSafeEqual(presented, stored);
}

export interface CalendarPushHeaders {
  channelId: string | null;
  channelToken: string | null;
  resourceId: string | null;
  resourceState: string | null;
}

function header(headers: { get(name: string): string | null }, name: string): string | null {
  const value = headers.get(name);
  return value && value.length > 0 ? value : null;
}

export function readCalendarPushHeaders(headers: {
  get(name: string): string | null;
}): CalendarPushHeaders {
  return {
    channelId: header(headers, 'x-goog-channel-id'),
    channelToken: header(headers, 'x-goog-channel-token'),
    resourceId: header(headers, 'x-goog-resource-id'),
    resourceState: header(headers, 'x-goog-resource-state'),
  };
}

export interface StoredCalendarChannel {
  channelId: string;
  resourceId: string;
  tokenHash: string;
}

export type CalendarPushVerifyResult =
  | { status: 'verified'; resourceState: string }
  | { status: 'invalid'; reason: string };

/**
 * The channel id has already selected the row. This checks that Google echoed the
 * token and resource id we stored when the watch was opened.
 */
export function verifyCalendarPush(
  headers: CalendarPushHeaders,
  stored: StoredCalendarChannel,
): CalendarPushVerifyResult {
  if (!headers.channelId || !headers.channelToken || !headers.resourceId) {
    return { status: 'invalid', reason: 'missing_channel_headers' };
  }
  if (headers.channelId !== stored.channelId) {
    return { status: 'invalid', reason: 'channel_mismatch' };
  }
  if (headers.resourceId !== stored.resourceId) {
    return { status: 'invalid', reason: 'resource_mismatch' };
  }
  if (!channelTokenMatches(headers.channelToken, stored.tokenHash)) {
    return { status: 'invalid', reason: 'token_mismatch' };
  }
  return { status: 'verified', resourceState: headers.resourceState ?? 'exists' };
}

export interface GmailPushNotice {
  emailAddress: string;
  /** The mailbox's current history id. NOT a cursor — the sync keeps its own. */
  historyId: string;
}

/**
 * Pub/Sub push body → `{ emailAddress, historyId }`. The data field is base64
 * (or base64url) JSON. Returns null when the body is not that shape; the address
 * is not logged by the caller.
 */
export function decodeGmailPushBody(rawBody: string): GmailPushNotice | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof envelope !== 'object' || envelope === null) return null;
  const data = (envelope as { message?: { data?: unknown } }).message?.data;
  if (typeof data !== 'string' || data.length === 0) return null;
  let notice: unknown;
  try {
    notice = JSON.parse(Buffer.from(normalizeBase64(data), 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof notice !== 'object' || notice === null) return null;
  const emailAddress = (notice as { emailAddress?: unknown }).emailAddress;
  const historyId = (notice as { historyId?: unknown }).historyId;
  if (typeof emailAddress !== 'string' || emailAddress.length === 0) return null;
  if (typeof historyId === 'string' && historyId.length > 0) {
    return { emailAddress, historyId };
  }
  if (typeof historyId === 'number' && Number.isFinite(historyId)) {
    return { emailAddress, historyId: String(historyId) };
  }
  return null;
}

function normalizeBase64(data: string): string {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (normalized.length % 4)) % 4;
  return normalized + '='.repeat(pad);
}

export function readBearerToken(authorization: string | null): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}

export type PubSubVerifyResult =
  | { status: 'verified' }
  | { status: 'invalid'; reason: string }
  | { status: 'not_configured'; reason: string };

export interface PubSubVerifyOptions {
  audience: string | undefined;
  serviceAccount: string | undefined;
  jwks: JWTVerifyGetKey;
}

/**
 * Verify a Pub/Sub push OIDC token: signature (RS256 via the supplied JWKS),
 * issuer, audience, expiry, and — when configured — the push service account.
 * `email_verified` must be true whenever a service account is required.
 */
export async function verifyPubSubPushToken(
  token: string,
  options: PubSubVerifyOptions,
): Promise<PubSubVerifyResult> {
  if (!options.audience) {
    return { status: 'not_configured', reason: 'GOOGLE_PUBSUB_PUSH_AUDIENCE unset' };
  }
  if (!options.serviceAccount) {
    return { status: 'not_configured', reason: 'GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT unset' };
  }
  try {
    const { payload } = await jwtVerify(token, options.jwks, {
      issuer: [...GOOGLE_ISSUERS],
      audience: options.audience,
    });
    if (payload.email !== options.serviceAccount) {
      return { status: 'invalid', reason: 'service_account_mismatch' };
    }
    if (payload.email_verified !== true) {
      return { status: 'invalid', reason: 'email_not_verified' };
    }
    return { status: 'verified' };
  } catch {
    return { status: 'invalid', reason: 'jwt_invalid' };
  }
}

let remoteJwks: JWTVerifyGetKey | undefined;

function googleCerts(): JWTVerifyGetKey {
  remoteJwks ??= createRemoteJWKSet(new URL(GOOGLE_CERTS));
  return remoteJwks;
}

/** The production verifier: Google's certs, audience and service account from env. */
export function verifyProductionPubSubToken(
  token: string,
  env: PushEnv = process.env,
): Promise<PubSubVerifyResult> {
  return verifyPubSubPushToken(token, {
    audience: env.GOOGLE_PUBSUB_PUSH_AUDIENCE,
    serviceAccount: env.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT,
    jwks: googleCerts(),
  });
}

/** `projects/<id>/topics/<name>`, or null when the env is missing or not that shape. */
export function readPubSubTopic(env: PushEnv = process.env): string | null {
  const topic = env.GOOGLE_PUBSUB_TOPIC;
  if (!topic || !/^projects\/[^/]+\/topics\/[^/]+$/.test(topic)) return null;
  return topic;
}
